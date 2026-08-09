/* Browser-first rates and macro collectors. Every provider fails independently. */
(function attachSentinelMacro(global) {
  "use strict";

  const REQUEST_TIMEOUT_MS = 22000;
  const SOURCES = {
    treasury: {
      label: "U.S. Treasury",
      url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
    },
    nyFed: {
      label: "Federal Reserve Bank of New York",
      url: "https://markets.newyorkfed.org/api/rates/all/latest.json"
    },
    ecb: {
      label: "European Central Bank",
      url: "https://data-api.ecb.europa.eu/service/"
    },
    riksbank: {
      label: "Sveriges Riksbank",
      url: "https://api.riksbank.se/swea/v1/"
    },
    bis: {
      label: "Bank for International Settlements",
      url: "https://stats.bis.org/api/v2/"
    },
    eurostat: {
      label: "Eurostat",
      url: "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"
    },
    fred: {
      label: "FRED, Federal Reserve Bank of St. Louis",
      url: "https://fred.stlouisfed.org/graph/fredgraph.csv"
    }
  };

  const sleep = milliseconds => new Promise(resolve => global.setTimeout(resolve, milliseconds));
  const finite = value => value === null || value === undefined || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const isoDate = date => new Date(date).toISOString().slice(0, 10);

  function proxyCandidates(url, preferProxy = false) {
    const proxied = [
      `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    return preferProxy ? proxied : [url, ...proxied];
  }

  async function fetchCandidate(url, responseType) {
    const controller = new AbortController();
    const timeout = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: responseType === "json" ? "application/json" : "text/plain,application/xml,text/csv,*/*" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return responseType === "json" ? response.json() : response.text();
    } finally {
      global.clearTimeout(timeout);
    }
  }

  async function fetchThroughBrowser(url, responseType = "json", options = {}) {
    const failures = [];
    for (const candidate of proxyCandidates(url, options.preferProxy)) {
      try {
        return await fetchCandidate(candidate, responseType);
      } catch (error) {
        let host = "browser route";
        try { host = new URL(candidate).hostname; } catch {}
        failures.push(`${host}: ${error.name === "AbortError" ? "timeout" : error.message}`);
        if (options.singleAttempt) break;
      }
    }
    throw new Error(failures.join("; "));
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = !quoted;
      } else if (character === "," && !quoted) {
        row.push(field); field = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field); field = "";
        if (row.some(value => value !== "")) rows.push(row);
        row = [];
      } else field += character;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    if (rows.length < 2) return [];
    const headers = rows[0].map(value => value.trim());
    return rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function nearestObservation(history, targetTime) {
    let match = null;
    for (const item of history) {
      const time = Date.parse(item.date);
      if (time <= targetTime && (!match || time > Date.parse(match.date))) match = item;
    }
    return match;
  }

  function changesFor(history) {
    if (!history.length) return { day: null, week: null, month: null };
    const latest = history[history.length - 1];
    const latestTime = Date.parse(latest.date);
    const previous = history.length > 1 ? history[history.length - 2] : null;
    const week = nearestObservation(history, latestTime - (7 * 86400000));
    const month = nearestObservation(history, latestTime - (30 * 86400000));
    const change = comparison => comparison ? (latest.value - comparison.value) * 100 : null;
    return { day: change(previous), week: change(week), month: change(month) };
  }

  function percentageChangesFor(history) {
    if (!history.length) return { day: null, week: null, month: null };
    const latest = history[history.length - 1];
    const latestTime = Date.parse(latest.date);
    const previous = history.length > 1 ? history[history.length - 2] : null;
    const week = nearestObservation(history, latestTime - (7 * 86400000));
    const month = nearestObservation(history, latestTime - (30 * 86400000));
    const change = comparison => comparison?.value ? ((latest.value / comparison.value) - 1) * 100 : null;
    return { day: change(previous), week: change(week), month: change(month) };
  }

  function sequenceChanges(history) {
    const ordered = history.filter(item => Number.isFinite(item.value)).sort((a, b) => a.date.localeCompare(b.date));
    const latest = ordered.at(-1);
    const change = offset => latest && ordered.length > offset ? (latest.value - ordered.at(-(offset + 1)).value) * 100 : null;
    return { month: change(1), quarter: change(3), year: change(12) };
  }

  function curvePoint(term, years, history) {
    const ordered = history.filter(item => Number.isFinite(item.value)).sort((a, b) => a.date.localeCompare(b.date));
    const latest = ordered.at(-1);
    return latest ? { term, years, value: latest.value, date: latest.date, changes: changesFor(ordered) } : null;
  }

  function parseTreasuryXML(xml) {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Treasury returned invalid XML.");
    const fieldMap = {
      BC_3MONTH: ["3M", 0.25], BC_6MONTH: ["6M", 0.5], BC_1YEAR: ["1Y", 1],
      BC_2YEAR: ["2Y", 2], BC_5YEAR: ["5Y", 5], BC_7YEAR: ["7Y", 7],
      BC_10YEAR: ["10Y", 10], BC_20YEAR: ["20Y", 20], BC_30YEAR: ["30Y", 30]
    };
    const histories = Object.fromEntries(Object.keys(fieldMap).map(key => [key, []]));
    for (const entry of [...document.getElementsByTagNameNS("*", "entry")]) {
      const values = Object.fromEntries([...entry.getElementsByTagNameNS("*", "properties")]
        .flatMap(properties => [...properties.children].map(node => [node.localName, node.textContent.trim()])));
      const date = String(values.NEW_DATE || "").slice(0, 10);
      if (!date) continue;
      Object.keys(fieldMap).forEach(key => {
        const value = finite(values[key]);
        if (value !== null) histories[key].push({ date, value });
      });
    }
    const points = Object.entries(fieldMap).map(([key, [term, years]]) => curvePoint(term, years, histories[key])).filter(Boolean);
    if (points.length < 5) throw new Error("Treasury yield curve was incomplete.");
    return buildCurve("US", "United States", SOURCES.treasury, points);
  }

  function parseECBPolicy(text) {
    const rows = parseCSV(text).filter(row => row.TIME_PERIOD && finite(row.OBS_VALUE) !== null);
    const latestFor = id => rows.filter(row => row.PROVIDER_FM_ID === id).sort((a, b) => a.TIME_PERIOD.localeCompare(b.TIME_PERIOD)).at(-1);
    const deposit = latestFor("DFR"), main = latestFor("MRR_FR"), marginal = latestFor("MLFR");
    if (!deposit && !main) throw new Error("ECB policy series were empty.");
    return {
      region: "EU", regionName: "Euro area", benchmark: "Deposit facility",
      rate: finite(deposit?.OBS_VALUE), date: deposit?.TIME_PERIOD || main?.TIME_PERIOD,
      secondary: [
        main && { label: "Main refinancing", value: finite(main.OBS_VALUE) },
        marginal && { label: "Marginal lending", value: finite(marginal.OBS_VALUE) }
      ].filter(Boolean), source: SOURCES.ecb
    };
  }

  function parseECBCurve(text) {
    const rows = parseCSV(text).filter(row => row.TIME_PERIOD && finite(row.OBS_VALUE) !== null);
    const terms = [["SR_1Y", "1Y", 1], ["SR_2Y", "2Y", 2], ["SR_5Y", "5Y", 5], ["SR_10Y", "10Y", 10], ["SR_30Y", "30Y", 30]];
    const points = terms.map(([id, term, years]) => curvePoint(term, years,
      rows.filter(row => row.DATA_TYPE_FM === id).map(row => ({ date: row.TIME_PERIOD, value: Number(row.OBS_VALUE) }))
    )).filter(Boolean);
    if (points.length < 4) throw new Error("ECB yield curve was incomplete.");
    return buildCurve("EU", "Euro area", SOURCES.ecb, points);
  }

  function buildCurve(region, regionName, source, points) {
    const byTerm = term => points.find(point => point.term === term)?.value;
    const threeMonth = byTerm("3M"), two = byTerm("2Y"), ten = byTerm("10Y");
    return {
      region, regionName, source, points,
      date: [...points].sort((a, b) => b.date.localeCompare(a.date))[0]?.date,
      slope10y2y: two !== undefined && ten !== undefined ? (ten - two) * 100 : null,
      slope10y3m: threeMonth !== undefined && ten !== undefined ? (ten - threeMonth) * 100 : null
    };
  }

  function latestSeriesValue(rows, seriesId) {
    const row = rows.find(item => String(item.seriesId || "").toUpperCase() === seriesId.toUpperCase());
    return row ? { value: finite(row.value), date: row.date } : null;
  }

  function parseRiksbankPolicy(rows) {
    const policy = latestSeriesValue(rows, "SECBREPOEFF");
    if (!policy || policy.value === null) throw new Error("Riksbank policy rate was unavailable.");
    const deposit = latestSeriesValue(rows, "SECBDEPOEFF"), lending = latestSeriesValue(rows, "SECBLENDEFF");
    return {
      region: "SE", regionName: "Sweden", benchmark: "Policy rate", rate: policy.value, date: policy.date,
      secondary: [
        deposit && { label: "Deposit rate", value: deposit.value },
        lending && { label: "Lending rate", value: lending.value }
      ].filter(Boolean), source: SOURCES.riksbank
    };
  }

  function parseRiksbankCurve(rows) {
    const terms = [["SEGVB2YC", "2Y", 2], ["SEGVB5YC", "5Y", 5], ["SEGVB7YC", "7Y", 7], ["SEGVB10YC", "10Y", 10]];
    const points = terms.map(([id, term, years]) => {
      const observation = latestSeriesValue(rows, id);
      return observation && observation.value !== null ? { term, years, value: observation.value, date: observation.date, changes: { day: null, week: null, month: null } } : null;
    }).filter(Boolean);
    if (points.length < 4) throw new Error("Swedish government curve was incomplete.");
    return buildCurve("SE", "Sweden", SOURCES.riksbank, points);
  }

  function parseRiksbankFX(rows) {
    const pairs = [["SEKUSDPMI", "USD/SEK"], ["SEKEURPMI", "EUR/SEK"], ["SEKGBPPMI", "GBP/SEK"], ["SEKNOKPMI", "NOK/SEK"]];
    const values = pairs.map(([id, pair]) => {
      const observation = latestSeriesValue(rows, id);
      return observation && observation.value !== null ? { pair, value: observation.value, date: observation.date, source: SOURCES.riksbank } : null;
    }).filter(Boolean);
    if (!values.length) throw new Error("Riksbank FX series were empty.");
    return values;
  }

  function parseECBFx(text) {
    const rows = parseCSV(text).filter(row => row.TIME_PERIOD && row.CURRENCY && finite(row.OBS_VALUE) !== null);
    const historyFor = currency => rows.filter(row => row.CURRENCY === currency)
      .map(row => ({ date: row.TIME_PERIOD, value: Number(row.OBS_VALUE) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const sekHistory = historyFor("SEK");
    if (!sekHistory.length) throw new Error("ECB SEK reference series was empty.");
    const crosses = [["EUR", "EUR/SEK"], ["USD", "USD/SEK"], ["GBP", "GBP/SEK"], ["NOK", "NOK/SEK"]];
    return crosses.map(([currency, pair]) => {
      const foreignByDate = new Map(historyFor(currency).map(item => [item.date, item.value]));
      const history = sekHistory.map(item => {
        const denominator = currency === "EUR" ? 1 : foreignByDate.get(item.date);
        return denominator ? { date: item.date, value: item.value / denominator } : null;
      }).filter(Boolean);
      const latest = history.at(-1);
      return latest ? { pair, value: latest.value, date: latest.date, changes: percentageChangesFor(history), source: SOURCES.ecb, derived: currency !== "EUR" } : null;
    }).filter(Boolean);
  }

  function parseBankRates(text) {
    const rows = parseCSV(text).filter(row => row.TIME_PERIOD && row.REF_AREA && finite(row.OBS_VALUE) !== null);
    const definitions = [["SE", "Sweden", "SEK"], ["U2", "Euro area", "EUR"]];
    return definitions.map(([region, regionName, currency]) => {
      const history = rows.filter(row => row.REF_AREA === region && row.CURRENCY_TRANS === currency)
        .map(row => ({ date: row.TIME_PERIOD, value: Number(row.OBS_VALUE) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const latest = history.at(-1);
      return latest ? {
        region: region === "U2" ? "EU" : region, regionName, label: "New mortgage rate", value: latest.value,
        date: latest.date, changes: sequenceChanges(history), source: SOURCES.ecb
      } : null;
    }).filter(Boolean);
  }

  function parseBISSwedenPolicy(text) {
    const rows = parseCSV(text).filter(row => row.TIME_PERIOD && finite(row.OBS_VALUE) !== null)
      .sort((a, b) => a.TIME_PERIOD.localeCompare(b.TIME_PERIOD));
    const latest = rows.at(-1);
    if (!latest) throw new Error("BIS Swedish policy-rate series was empty.");
    return {
      region: "SE", regionName: "Sweden", benchmark: "Policy rate", rate: Number(latest.OBS_VALUE), date: latest.TIME_PERIOD,
      secondary: [], fallback: true, source: SOURCES.bis
    };
  }

  function jsonStatHistory(dataset, selectors = {}) {
    const ids = dataset?.id || [], sizes = dataset?.size || [];
    const timePosition = ids.indexOf("time");
    if (timePosition < 0) return [];
    const positions = ids.map(() => 0);
    for (const [dimension, code] of Object.entries(selectors)) {
      const dimensionPosition = ids.indexOf(dimension);
      const selectedIndex = dataset.dimension?.[dimension]?.category?.index?.[code];
      if (dimensionPosition < 0 || selectedIndex === undefined) return [];
      positions[dimensionPosition] = selectedIndex;
    }
    const valueAt = currentPositions => {
      let flatIndex = 0, stride = 1;
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        flatIndex += currentPositions[index] * stride;
        stride *= sizes[index];
      }
      return dataset.value?.[flatIndex] ?? dataset.value?.[String(flatIndex)] ?? null;
    };
    return Object.entries(dataset.dimension?.time?.category?.index || {}).map(([date, timeIndex]) => {
      const currentPositions = [...positions];
      currentPositions[timePosition] = timeIndex;
      const value = finite(valueAt(currentPositions));
      return value === null ? null : { date, value };
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  }

  function parseSwedenOfficialCurve(shortDataset, longDataset) {
    const shortHistory = jsonStatHistory(shortDataset, { geo: "SE", int_rt: "IRT_M3" });
    const longHistory = jsonStatHistory(longDataset, { geo: "SE", int_rt: "MCBY" });
    const points = [curvePoint("3M", 0.25, shortHistory), curvePoint("10Y", 10, longHistory)].filter(Boolean);
    if (points.length < 2) throw new Error("Official Swedish fallback curve was incomplete.");
    const curve = buildCurve("SE", "Sweden", SOURCES.eurostat, points);
    curve.fallback = true;
    curve.coverage = "3M money-market rate + 10Y convergence yield";
    return curve;
  }

  function parseSwedenMoneyMarket(dataset) {
    const history = jsonStatHistory(dataset, { geo: "SE", int_rt: "IRT_M3" });
    const latest = history.at(-1);
    if (!latest) throw new Error("Swedish 3-month money-market rate was empty.");
    return { region: "SE", regionName: "Sweden", label: "3M money-market rate", value: latest.value, date: latest.date, changes: sequenceChanges(history), source: SOURCES.eurostat };
  }

  function jsonStatLatest(dataset, geoCode) {
    const ids = dataset.id || [];
    const sizes = dataset.size || [];
    const geoPosition = ids.indexOf("geo"), timePosition = ids.indexOf("time");
    if (geoPosition < 0 || timePosition < 0) return null;
    const indexFor = (dimension, code) => dataset.dimension?.[dimension]?.category?.index?.[code];
    const geoIndex = indexFor("geo", geoCode);
    const timeIndexes = Object.entries(dataset.dimension?.time?.category?.index || {}).sort((left, right) => right[1] - left[1]);
    if (geoIndex === undefined) return null;
    const valueAt = positions => {
      let flatIndex = 0, stride = 1;
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        flatIndex += positions[index] * stride;
        stride *= sizes[index];
      }
      return dataset.value?.[flatIndex] ?? dataset.value?.[String(flatIndex)] ?? null;
    };
    for (const [date, timeIndex] of timeIndexes) {
      const positions = ids.map(() => 0);
      positions[geoPosition] = geoIndex;
      positions[timePosition] = timeIndex;
      const value = finite(valueAt(positions));
      if (value !== null) return { value, date };
    }
    return null;
  }

  function parseFred(text) {
    const rows = parseCSV(text).map(row => {
      const keys = Object.keys(row);
      return { date: row.observation_date || row.DATE || row.date || row[keys[0]], value: finite(row[keys[1]]) };
    }).filter(row => row.date && row.value !== null).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw new Error("FRED series contained no observations.");
    return rows;
  }

  function annualInflation(rows) {
    const latest = rows.at(-1);
    const target = new Date(`${latest.date}T00:00:00Z`);
    target.setUTCFullYear(target.getUTCFullYear() - 1);
    const prior = nearestObservation(rows, target.getTime());
    if (!prior || !prior.value) throw new Error("Not enough CPI history to calculate annual inflation.");
    return { value: ((latest.value / prior.value) - 1) * 100, date: latest.date };
  }

  function parseNYFed(json) {
    const rows = Array.isArray(json?.refRates) ? json.refRates : [];
    const byType = type => rows.find(row => row.type === type);
    const effr = byType("EFFR"), sofr = byType("SOFR"), obfr = byType("OBFR"), tgcr = byType("TGCR"), bgcr = byType("BGCR");
    if (!effr && !sofr) throw new Error("NY Fed reference rates were empty.");
    const rate = row => finite(row?.percentRate);
    const funding = [effr, sofr, obfr, tgcr, bgcr].filter(Boolean).map(row => ({
      label: row.type, rate: rate(row), date: row.effectiveDate, volume: finite(row.volumeInBillions),
      percentile1: finite(row.percentPercentile1), percentile99: finite(row.percentPercentile99), source: SOURCES.nyFed
    }));
    return {
      policy: effr ? {
        region: "US", regionName: "United States", benchmark: "Effective federal funds rate", rate: rate(effr), date: effr.effectiveDate,
        target: finite(effr.targetRateFrom) !== null && finite(effr.targetRateTo) !== null ? `${Number(effr.targetRateFrom).toFixed(2)}-${Number(effr.targetRateTo).toFixed(2)}% target` : "",
        secondary: sofr ? [{ label: "SOFR", value: rate(sofr) }] : [], source: SOURCES.nyFed
      } : null,
      funding
    };
  }

  function mergeByKey(fresh, previous, key) {
    const map = new Map((previous || []).map(item => [item[key], { ...item, stale: true }]));
    (fresh || []).forEach(item => map.set(item[key], item));
    return [...map.values()];
  }

  function deriveSignals(payload) {
    const signals = [];
    Object.values(payload.curves || {}).forEach(curve => {
      const twoYearSlope = finite(curve.slope10y2y);
      const threeMonthSlope = finite(curve.slope10y3m);
      const slope = twoYearSlope !== null ? twoYearSlope : threeMonthSlope;
      if (slope === null) return;
      const slopeLabel = twoYearSlope !== null ? "10Y-2Y" : "10Y-3M";
      const state = slope < 0 ? "Inverted" : slope < 25 ? "Flat" : slope > 100 ? "Steep" : "Positive";
      const tone = slope < 0 ? "danger" : slope < 25 ? "watch" : "calm";
      signals.push({
        label: `${curve.region} ${slopeLabel}`, value: `${slope >= 0 ? "+" : ""}${slope.toFixed(0)} bp`, state, tone,
        detail: `${curve.regionName} curve slope based on the latest ${slopeLabel.replace("-", " minus ")} observations.${curve.fallback ? ` Fallback coverage: ${curve.coverage}.` : ""}`,
        source: curve.source
      });
    });
    (payload.realPolicy || []).forEach(item => {
      const state = item.value > 1 ? "Restrictive" : item.value > 0 ? "Mildly restrictive" : "Accommodative";
      signals.push({ label: `${item.region} real policy`, value: `${item.value >= 0 ? "+" : ""}${item.value.toFixed(2)}%`, state, tone: item.value > 1 ? "danger" : item.value > 0 ? "watch" : "calm", detail: `${item.policy.toFixed(2)}% policy rate minus ${item.inflation.toFixed(2)}% annual inflation.`, source: item.source });
    });
    const funding = Object.fromEntries((payload.funding || []).map(item => [item.label, item.rate]));
    if (Number.isFinite(funding.SOFR) && Number.isFinite(funding.EFFR)) {
      const spread = (funding.SOFR - funding.EFFR) * 100;
      signals.push({ label: "SOFR-EFFR", value: `${spread >= 0 ? "+" : ""}${spread.toFixed(1)} bp`, state: Math.abs(spread) > 10 ? "Stress" : Math.abs(spread) > 5 ? "Watch" : "Normal", tone: Math.abs(spread) > 10 ? "danger" : Math.abs(spread) > 5 ? "watch" : "calm", detail: "Secured overnight funding minus the effective federal funds rate.", source: SOURCES.nyFed });
    }

    const policyByRegion = Object.fromEntries((payload.policy || []).map(item => [item.region, item]));
    [["US", "SE"], ["EU", "SE"]].forEach(([left, right]) => {
      const first = policyByRegion[left], second = policyByRegion[right];
      if (finite(first?.rate) === null || finite(second?.rate) === null) return;
      const spread = (first.rate - second.rate) * 100;
      signals.push({
        label: `${left}-${right} policy gap`, value: `${spread >= 0 ? "+" : ""}${spread.toFixed(0)} bp`,
        state: Math.abs(spread) >= 150 ? "Wide divergence" : Math.abs(spread) >= 50 ? "Divergent" : "Aligned",
        tone: Math.abs(spread) >= 150 ? "danger" : Math.abs(spread) >= 50 ? "watch" : "calm",
        detail: `${first.regionName} policy rate minus ${second.regionName} policy rate. Large gaps can affect currencies, cross-border funding and capital flows.`,
        source: first.source
      });
    });

    const tenYearFor = region => payload.curves?.[region]?.points?.find(point => point.term === "10Y");
    [["US", "SE"], ["EU", "SE"]].forEach(([left, right]) => {
      const first = tenYearFor(left), second = tenYearFor(right);
      if (finite(first?.value) === null || finite(second?.value) === null) return;
      const spread = (first.value - second.value) * 100;
      signals.push({
        label: `${left}-${right} 10Y gap`, value: `${spread >= 0 ? "+" : ""}${spread.toFixed(0)} bp`, state: Math.abs(spread) >= 150 ? "Wide" : Math.abs(spread) >= 50 ? "Meaningful" : "Narrow",
        tone: Math.abs(spread) >= 150 ? "danger" : Math.abs(spread) >= 50 ? "watch" : "calm",
        detail: `${left} 10-year government yield minus ${right} 10-year yield. The gap can influence hedged returns, currencies and relative financing costs.`,
        source: payload.curves?.[left]?.source
      });
    });

    const swedenMortgage = payload.bankRates?.find(item => item.region === "SE");
    const swedenPolicy = policyByRegion.SE;
    if (finite(swedenMortgage?.value) !== null && finite(swedenPolicy?.rate) !== null) {
      const spread = (swedenMortgage.value - swedenPolicy.rate) * 100;
      signals.push({
        label: "SE mortgage-policy", value: `${spread >= 0 ? "+" : ""}${spread.toFixed(0)} bp`, state: spread > 200 ? "Wide transmission" : spread > 75 ? "Normal premium" : "Compressed",
        tone: spread > 200 ? "danger" : spread < 50 ? "watch" : "calm",
        detail: `New Swedish mortgage rate minus the Riksbank policy rate. This is a simple transmission spread, not a lender margin.`,
        source: swedenMortgage.source
      });
    }

    const eurSek = payload.fx?.find(item => item.pair === "EUR/SEK");
    const sekMonth = finite(eurSek?.changes?.month);
    if (sekMonth !== null) {
      const magnitude = Math.abs(sekMonth);
      signals.push({
        label: "SEK 1M vs EUR", value: `${sekMonth >= 0 ? "+" : ""}${sekMonth.toFixed(2)}%`,
        state: sekMonth > 0 ? "SEK weaker" : sekMonth < 0 ? "SEK stronger" : "Unchanged",
        tone: magnitude > 3 ? "danger" : magnitude > 1 ? "watch" : "calm",
        detail: "One-month change in EUR/SEK. A positive move means more kronor per euro and therefore a weaker SEK.",
        source: eurSek.source
      });
    }
    const realAverage = payload.realPolicy?.length ? payload.realPolicy.reduce((sum, item) => sum + item.value, 0) / payload.realPolicy.length : null;
    const inverted = Object.values(payload.curves || {}).filter(curve => {
      const slope = finite(curve.slope10y2y) ?? finite(curve.slope10y3m);
      return slope !== null && slope < 0;
    }).length;
    payload.regime = inverted >= 2 ? "Cross-market curve inversion" : realAverage !== null && realAverage > 1 ? "Restrictive global stance" : realAverage !== null && realAverage < 0 ? "Accommodative global stance" : "Mixed / neutral macro regime";
    return signals;
  }

  async function collect(previous = null, progress = () => {}) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const startDate = isoDate(now.getTime() - (75 * 86400000));
    const eurostatStart = `${year - 1}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const fredStart = isoDate(Date.UTC(year - 2, now.getUTCMonth(), 1));
    const urls = {
      treasury: `${SOURCES.treasury.url}?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,
      nyFed: SOURCES.nyFed.url,
      ecbPolicy: `${SOURCES.ecb.url}data/FM/D.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV?startPeriod=${startDate}&format=csvdata`,
      ecbCurve: `${SOURCES.ecb.url}data/YC/B.U2.EUR.4F.G_N_C.SV_C_YM.SR_1Y+SR_2Y+SR_5Y+SR_10Y+SR_30Y?startPeriod=${startDate}&format=csvdata`,
      riksPolicy: `${SOURCES.riksbank.url}Observations/Latest/ByGroup/2`,
      riksCurve: `${SOURCES.riksbank.url}Observations/Latest/ByGroup/7`,
      riksFX: `${SOURCES.riksbank.url}Observations/Latest/ByGroup/130`,
      bisPolicy: `${SOURCES.bis.url}data/dataflow/BIS/WS_CBPOL/1.0/M.SE?startPeriod=${year - 1}-01&format=csv`,
      ecbFX: `${SOURCES.ecb.url}data/EXR/D.USD+GBP+NOK+SEK.EUR.SP00.A?startPeriod=${startDate}&format=csvdata`,
      ecbBankRates: `${SOURCES.ecb.url}data/MIR/M.SE+U2.B.A2C.A.R.A.2250.SEK+EUR.N?startPeriod=${year - 1}-01&format=csvdata`,
      swedenShort: `${SOURCES.eurostat.url}irt_st_m?geo=SE&sinceTimePeriod=${eurostatStart}`,
      swedenLong: `${SOURCES.eurostat.url}irt_lt_mcby_m?geo=SE&sinceTimePeriod=${eurostatStart}`,
      euroInflation: `${SOURCES.eurostat.url}prc_hicp_manr?coicop=CP00&sinceTimePeriod=${eurostatStart}`,
      euroLabour: `${SOURCES.eurostat.url}une_rt_m?s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT&sinceTimePeriod=${eurostatStart}`,
      usInflation: `${SOURCES.fred.url}?id=CPIAUCSL&cosd=${fredStart}`,
    };
    const definitions = [
      ["treasury", () => fetchThroughBrowser(urls.treasury, "text").then(parseTreasuryXML)],
      ["nyFed", () => fetchThroughBrowser(urls.nyFed).then(parseNYFed)],
      ["ecbPolicy", () => fetchThroughBrowser(urls.ecbPolicy, "text").then(parseECBPolicy)],
      ["ecbCurve", () => fetchThroughBrowser(urls.ecbCurve, "text").then(parseECBCurve)],
      ["riksPolicy", () => fetchThroughBrowser(urls.riksPolicy, "json", { preferProxy: true }).then(parseRiksbankPolicy)],
      ["riksCurve", () => fetchThroughBrowser(urls.riksCurve, "json", { preferProxy: true }).then(parseRiksbankCurve)],
      ["riksFX", () => fetchThroughBrowser(urls.riksFX, "json", { preferProxy: true }).then(parseRiksbankFX)],
      ["bisPolicy", () => fetchThroughBrowser(urls.bisPolicy, "text").then(parseBISSwedenPolicy)],
      ["ecbFX", () => fetchThroughBrowser(urls.ecbFX, "text").then(parseECBFx)],
      ["ecbBankRates", () => fetchThroughBrowser(urls.ecbBankRates, "text").then(parseBankRates)],
      ["swedenShort", () => fetchThroughBrowser(urls.swedenShort)],
      ["swedenLong", () => fetchThroughBrowser(urls.swedenLong)],
      ["euroInflation", () => fetchThroughBrowser(urls.euroInflation)],
      ["euroLabour", () => fetchThroughBrowser(urls.euroLabour)],
      ["usInflation", () => fetchThroughBrowser(urls.usInflation, "text").then(parseFred).then(annualInflation)]
    ];
    let completed = 0;
    progress("connecting", 0, definitions.length, "Connecting to official rates and macro feeds...");
    const wrapped = definitions.map(([key, task]) => task().then(value => {
      completed += 1; progress("fetching", completed, definitions.length, `${key} received.`); return { key, value };
    }).catch(error => {
      completed += 1; progress("fetching", completed, definitions.length, `${key} unavailable; preserving its last successful values.`); throw Object.assign(error, { providerKey: key });
    }));
    const settled = await Promise.allSettled(wrapped);
    const values = {}, failures = [];
    settled.forEach((result, index) => {
      const key = definitions[index][0];
      if (result.status === "fulfilled") values[key] = result.value.value;
      else failures.push({ key, message: result.reason?.message || "Request failed" });
    });
    if (!Object.keys(values).length && !previous) throw new Error("Every rates and macro provider was unavailable.");

    const freshPolicy = [values.nyFed?.policy, values.ecbPolicy, values.riksPolicy || values.bisPolicy].filter(Boolean);
    const curves = { ...(previous?.curves || {}) };
    if (values.treasury) curves.US = values.treasury;
    if (values.ecbCurve) curves.EU = values.ecbCurve;
    if (values.riksCurve) curves.SE = values.riksCurve;
    else if (values.swedenShort && values.swedenLong) {
      try { curves.SE = parseSwedenOfficialCurve(values.swedenShort, values.swedenLong); }
      catch (error) { failures.push({ key: "swedenCurveFallback", message: error.message }); }
    }
    const inflation = [];
    if (values.usInflation) inflation.push({ region: "US", regionName: "United States", ...values.usInflation, source: SOURCES.fred });
    const euInflation = values.euroInflation && (jsonStatLatest(values.euroInflation, "EA21") || jsonStatLatest(values.euroInflation, "EA20"));
    const seInflation = values.euroInflation && jsonStatLatest(values.euroInflation, "SE");
    if (euInflation) inflation.push({ region: "EU", regionName: "Euro area", ...euInflation, source: SOURCES.eurostat });
    if (seInflation) inflation.push({ region: "SE", regionName: "Sweden", ...seInflation, source: SOURCES.eurostat });
    const labour = [];
    const usLabour = values.euroLabour && jsonStatLatest(values.euroLabour, "US");
    const euLabour = values.euroLabour && (jsonStatLatest(values.euroLabour, "EA21") || jsonStatLatest(values.euroLabour, "EA20"));
    const seLabour = values.euroLabour && jsonStatLatest(values.euroLabour, "SE");
    if (usLabour) labour.push({ region: "US", regionName: "United States", ...usLabour, source: SOURCES.eurostat });
    if (euLabour) labour.push({ region: "EU", regionName: "Euro area", ...euLabour, source: SOURCES.eurostat });
    if (seLabour) labour.push({ region: "SE", regionName: "Sweden", ...seLabour, source: SOURCES.eurostat });
    const policy = mergeByKey(freshPolicy, previous?.policy, "region");
    const mergedInflation = mergeByKey(inflation, previous?.inflation, "region");
    const mergedLabour = mergeByKey(labour, previous?.labour, "region");
    const bankRates = mergeByKey(values.ecbBankRates || [], previous?.bankRates, "region");
    let moneyMarket = previous?.moneyMarket || [];
    if (values.swedenShort) {
      try { moneyMarket = [parseSwedenMoneyMarket(values.swedenShort)]; }
      catch (error) { failures.push({ key: "swedenShortParse", message: error.message }); }
    }
    let fx = values.ecbFX || previous?.fx || [];
    if (values.riksFX) {
      fx = values.riksFX.map(item => {
        const ecbMatch = values.ecbFX?.find(candidate => candidate.pair === item.pair);
        return ecbMatch ? { ...item, changes: ecbMatch.changes } : item;
      });
    }
    const realPolicy = policy.map(item => {
      const price = mergedInflation.find(candidate => candidate.region === item.region);
      return price && finite(item.rate) !== null && finite(price.value) !== null ? {
        region: item.region, regionName: item.regionName, value: item.rate - price.value,
        policy: item.rate, inflation: price.value, date: price.date, source: price.source
      } : null;
    }).filter(Boolean);
    const payload = {
      source: {
        fetchedAt: new Date().toISOString(), providerCount: definitions.length,
        successfulProviders: Object.keys(values).length, failures, urls
      },
      policy, curves,
      funding: values.nyFed?.funding || previous?.funding || [],
      fx, bankRates, moneyMarket,
      inflation: mergedInflation, labour: mergedLabour, realPolicy,
      providers: Object.fromEntries(definitions.map(([key]) => [key, failures.some(item => item.key === key) ? "stale" : "live"]))
    };
    payload.signals = deriveSignals(payload);
    progress("saving", definitions.length, definitions.length, "Rates and macro matrix assembled; saving in this browser...");
    try {
      if (global.SentinelBrowser?.store) await global.SentinelBrowser.store.put("macro", payload);
      else throw new Error("IndexedDB helper is unavailable.");
    } catch (error) {
      payload.source.storageWarning = error.message;
    }
    progress("complete", definitions.length, definitions.length, `Updated ${payload.source.successfulProviders}/${payload.source.providerCount} provider routes.`);
    return payload;
  }

  global.SentinelMacro = { collect, sources: SOURCES };
})(globalThis);
