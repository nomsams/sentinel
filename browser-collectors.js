/* Browser-first website collectors for static deployments (GitHub Pages, etc.). */
(function attachSentinelBrowser(global) {
  "use strict";

  const DB_NAME = "market-sentinel-browser-cache";
  const STORE_NAME = "datasets";
  const DB_VERSION = 1;
  const REQUEST_TIMEOUT_MS = 20000;
  const OPENINSIDER_SECTIONS = [
    { id: "cluster-buys", title: "Cluster Buys", url: "https://openinsider.com/latest-cluster-buys" },
    { id: "insider-buys", title: "Insider Buys", url: "https://openinsider.com/insider-purchases" },
    { id: "penny-stock-buys", title: "Penny Stock Buys", url: "https://openinsider.com/latest-penny-stock-buys" },
    { id: "sales-100k", title: "Sales $100k+", url: "https://openinsider.com/top-insider-sales-of-the-day" },
    { id: "latest-trading", title: "Latest Trading", url: "https://openinsider.com/latest-insider-trading" }
  ];
  const WIKI_API = "https://en.wikipedia.org/w/api.php";
  const WIKI_INDEXES = [
    { chamber: "house", title: "List of United States House of Representatives committees" },
    { chamber: "senate", title: "List of United States Senate committees" }
  ];
  const STATE_CODES = {
    Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
    Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID",
    Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
    Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
    Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
    Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
    "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC"
  };

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error("IndexedDB is unavailable in this browser."));
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the browser data store."));
    });
  }

  async function useStore(mode, operation) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error || new Error("Browser data store operation failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Browser data store transaction aborted."));
      });
    } finally {
      db.close();
    }
  }

  const store = {
    get(key) { return useStore("readonly", objectStore => objectStore.get(key)); },
    put(key, value) { return useStore("readwrite", objectStore => objectStore.put(value, key)); }
  };

  function proxyCandidates(url) {
    return [
      url,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
  }

  async function fetchCandidate(url, responseType) {
    const controller = new AbortController();
    const timeout = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: responseType === "json" ? "application/json" : "text/html,application/xhtml+xml,text/plain" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return responseType === "json" ? response.json() : response.text();
    } finally {
      global.clearTimeout(timeout);
    }
  }

  async function fetchThroughBrowser(url, responseType = "text") {
    const failures = [];
    for (const candidate of proxyCandidates(url)) {
      try {
        return await fetchCandidate(candidate, responseType);
      } catch (error) {
        failures.push(`${new URL(candidate).hostname}: ${error.name === "AbortError" ? "timeout" : error.message}`);
      }
    }
    throw new Error(`Browser request failed through every available route (${failures.join("; ")}).`);
  }

  function numericValue(value) {
    const normalized = String(value ?? "").replace(/[^0-9.+-]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseOpenInsiderTable(html, definition) {
    const document = new DOMParser().parseFromString(html, "text/html");
    const tables = [...document.querySelectorAll("table.tinytable")];
    const table = tables.find(candidate => candidate.querySelectorAll("tbody td").length >= 13) || tables[0];
    if (!table) throw new Error(`${definition.title} returned no OpenInsider table.`);
    const headers = [...table.querySelectorAll("thead th")].map(cell => cell.textContent.replace(/\s+/g, " ").trim());
    const rows = [...table.querySelectorAll("tbody tr, tr")]
      .map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent.replace(/\s+/g, " ").trim()))
      .filter(cells => cells.length >= 13)
      .slice(0, 10)
      .map(cells => ({
        flags: cells[0], filingDate: cells[1], tradeDate: cells[2], ticker: cells[3], company: cells[4],
        detail: cells[5], role: cells[6], tradeType: cells[7], price: cells[8], quantity: cells[9],
        owned: cells[10], ownershipChange: cells[11], value: cells[12], dayReturn: cells[13] || "",
        weekReturn: cells[14] || "", monthReturn: cells[15] || "", sixMonthReturn: cells[16] || "",
        priceValue: numericValue(cells[8]), quantityValue: numericValue(cells[9]), tradeValue: numericValue(cells[12])
      }));
    if (!rows.length) throw new Error(`${definition.title} contained no usable filings.`);
    return { ...definition, detailLabel: headers[5] || "Insider / Industry", roleLabel: headers[6] || "Title / Insiders", rows };
  }

  function insiderCurrency(value, fallback = "—") {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : fallback;
  }

  function normalizeInsiderAPITrade(trade, type) {
    const shares = Number(trade.shares);
    const price = Number(trade.pricePerShare);
    const value = Number(trade.valueUsd);
    const tradeType = type === "buy" ? "P - Purchase" : "S - Sale";
    return {
      flags: "", filingDate: String(trade.txDate || ""), tradeDate: String(trade.txDate || ""),
      ticker: String(trade.ticker || "").toUpperCase(), company: "SEC Form 4 filing",
      detail: String(trade.insiderName || "Unknown insider"), role: String(trade.insiderTitle || "Insider"), tradeType,
      price: insiderCurrency(price), quantity: Number.isFinite(shares) ? shares.toLocaleString() : "—", owned: "—",
      ownershipChange: "—", value: insiderCurrency(value), dayReturn: "", weekReturn: "", monthReturn: "", sixMonthReturn: "",
      priceValue: Number.isFinite(price) ? price : null, quantityValue: Number.isFinite(shares) ? shares : null,
      tradeValue: Number.isFinite(value) ? value : null
    };
  }

  function buildInsiderAPISections(buyTrades, sellTrades) {
    const buys = buyTrades.map(trade => normalizeInsiderAPITrade(trade, "buy"));
    const sells = sellTrades.map(trade => normalizeInsiderAPITrade(trade, "sell"));
    const clusterMap = new Map();
    buys.forEach(row => {
      const entry = clusterMap.get(row.ticker) || { ticker: row.ticker, rows: [], names: new Set() };
      entry.rows.push(row);
      entry.names.add(row.detail);
      clusterMap.set(row.ticker, entry);
    });
    const clusters = [...clusterMap.values()].filter(entry => entry.names.size >= 2)
      .sort((left, right) => right.names.size - left.names.size || right.rows.reduce((sum, row) => sum + (row.tradeValue || 0), 0) - left.rows.reduce((sum, row) => sum + (row.tradeValue || 0), 0))
      .slice(0, 10).map(entry => {
        const latest = [...entry.rows].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0];
        const value = entry.rows.reduce((sum, row) => sum + (row.tradeValue || 0), 0);
        const quantity = entry.rows.reduce((sum, row) => sum + (row.quantityValue || 0), 0);
        return {
          ...latest, company: `${entry.ticker} insider cluster`, detail: `${entry.names.size} distinct insiders`,
          role: [...entry.names].join(", "), quantity: quantity.toLocaleString(), quantityValue: quantity,
          value: insiderCurrency(value), tradeValue: value
        };
      });
    const latest = [...buys, ...sells].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).slice(0, 10);
    return new Map([
      ["cluster-buys", { ...OPENINSIDER_SECTIONS[0], detailLabel: "Cluster Size", roleLabel: "Insiders", rows: clusters.length ? clusters : buys.slice(0, 10) }],
      ["insider-buys", { ...OPENINSIDER_SECTIONS[1], detailLabel: "Insider", roleLabel: "Title", rows: buys.slice(0, 10) }],
      ["penny-stock-buys", { ...OPENINSIDER_SECTIONS[2], detailLabel: "Insider", roleLabel: "Title", rows: buys.filter(row => row.priceValue !== null && row.priceValue < 5).slice(0, 10) }],
      ["sales-100k", { ...OPENINSIDER_SECTIONS[3], detailLabel: "Insider", roleLabel: "Title", rows: sells.filter(row => (row.tradeValue || 0) >= 100000).slice(0, 10) }],
      ["latest-trading", { ...OPENINSIDER_SECTIONS[4], detailLabel: "Insider", roleLabel: "Title", rows: latest }]
    ]);
  }

  async function fetchInsiderAPI(type) {
    const json = await fetchThroughBrowser(`https://xoomar.com/api/markets/insiders?type=${type}&window=90d`, "json");
    if (!Array.isArray(json?.data) || !json.data.length) throw new Error(`The SEC Form 4 ${type} feed returned no transactions.`);
    return json.data;
  }

  async function collectOpenInsider(existing, sectionId, progress = () => {}) {
    const selected = sectionId ? OPENINSIDER_SECTIONS.filter(section => section.id === sectionId) : OPENINSIDER_SECTIONS;
    if (!selected.length) throw new Error(`Unknown OpenInsider list: ${sectionId}`);
    let replacements;
    let provider = "Xoomar SEC Form 4 API (browser feed)";
    let sourceURL = "https://xoomar.com/markets/api/insiders";
    try {
      const needsBuys = selected.some(section => ["cluster-buys", "insider-buys", "penny-stock-buys", "latest-trading"].includes(section.id));
      const needsSells = selected.some(section => ["sales-100k", "latest-trading"].includes(section.id));
      const total = Number(needsBuys) + Number(needsSells);
      let complete = 0;
      progress("connecting", 0, total, "Connecting directly to the live SEC Form 4 browser feed…");
      const [buyTrades, sellTrades] = await Promise.all([
        needsBuys ? fetchInsiderAPI("buys").then(rows => { complete += 1; progress("downloading", complete, total, `Received ${rows.length} current insider buys.`); return rows; }) : [],
        needsSells ? fetchInsiderAPI("sells").then(rows => { complete += 1; progress("downloading", complete, total, `Received ${rows.length} current insider sales.`); return rows; }) : []
      ]);
      const generated = buildInsiderAPISections(buyTrades, sellTrades);
      replacements = new Map(selected.map(definition => [definition.id, generated.get(definition.id)]));
      for (const definition of selected) {
        if (!replacements.get(definition.id)?.rows?.length) throw new Error(`${definition.title} contained no qualifying live transactions.`);
      }
      progress("parsing", total, total, `Built ${selected.length} live SEC Form 4 list${selected.length === 1 ? "" : "s"}.`);
    } catch (apiError) {
      provider = "OpenInsider (browser proxy fetch)";
      sourceURL = "https://openinsider.com/";
      replacements = new Map();
      for (let index = 0; index < selected.length; index += 1) {
        const definition = selected[index];
        progress("connecting", index, selected.length, `SEC API failed; requesting ${definition.title} through a browser CORS route…`);
        const html = await fetchThroughBrowser(definition.url);
        replacements.set(definition.id, parseOpenInsiderTable(html, definition));
        progress("parsing", index + 1, selected.length, `Loaded ${definition.title} (${replacements.get(definition.id).rows.length} rows).`);
      }
    }
    const previous = Array.isArray(existing?.sections) ? existing.sections : [];
    const sections = OPENINSIDER_SECTIONS.map(definition => replacements.get(definition.id)
      || previous.find(section => section.id === definition.id)).filter(Boolean);
    const fetchedAt = new Date().toISOString();
    const payload = {
      source: {
        provider, url: sourceURL, fetchedAt,
        updateIntervalMinutes: 30, rowCount: sections.reduce((total, section) => total + section.rows.length, 0),
        refreshedSection: sectionId || "all"
      },
      sections
    };
    progress("saving", selected.length, selected.length, "Saving the successful OpenInsider result in this browser…");
    try { await store.put("openinsider", payload); }
    catch (error) { payload.source.storageWarning = error.message; }
    return payload;
  }

  function displayDate(value) {
    const date = new Date(`${String(value || "").slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? String(value || "—") : date.toLocaleDateString();
  }

  function amountMidpoint(value) {
    const amounts = String(value || "").match(/[\d,]+/g)?.map(item => Number(item.replace(/,/g, ""))).filter(Number.isFinite) || [];
    if (!amounts.length) return 0;
    return amounts.length > 1 ? (amounts[0] + amounts[1]) / 2 : amounts[0];
  }

  function dayGap(left, right) {
    const start = Date.parse(left);
    const end = Date.parse(right);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 86400000)) : 0;
  }

  function normalizeCongressTrade(trade, index) {
    const memberRecord = trade._member || {};
    const member = String(trade.member || trade.member_name || trade.politician || memberRecord.name || "Unknown").trim();
    const chamber = String(trade.chamber || memberRecord.chamber || trade.source || "").toLowerCase();
    const rawType = trade.trade_type || trade.transaction_type || trade.type || "other";
    const type = /sell|sale/i.test(rawType) ? "sell" : /buy|purchase/i.test(rawType) ? "buy" : String(rawType).toLowerCase();
    const tradedAt = String(trade.tx_date || trade.transaction_date || "").slice(0, 10);
    const publishedAt = String(trade.disclosed || trade.filing_date || trade.disclosure_date || "").slice(0, 10);
    const reportingGap = dayGap(tradedAt, publishedAt);
    const link = String(trade.link || trade.source_url || trade.filing_portal || "");
    const ticker = String(trade.ticker || "").toUpperCase();
    const amountLow = Number(trade.amount_low ?? trade.amount_min);
    const amountHigh = Number(trade.amount_high ?? trade.amount_max);
    const amount = String(trade.amount || trade.amount_range || (Number.isFinite(amountLow) && Number.isFinite(amountHigh)
      ? `${insiderCurrency(amountLow)} - ${insiderCurrency(amountHigh)}` : "Not disclosed"));
    const price = Number(trade.est_price);
    return {
      id: String(trade.id || `${member}|${ticker}|${tradedAt}|${publishedAt}|${amount}|${index}`),
      politicianId: String(trade.member_slug || `${chamber}-${member}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      politicianName: member, firstName: member.split(/\s+/)[0] || "", lastName: member.split(/\s+/).at(-1) || "",
      party: String(trade.party || memberRecord.party || ""), chamber, state: String(trade.state || memberRecord.state || "").slice(0, 2), dateOfBirth: "", gender: "",
      issuerName: String(trade.asset || trade.asset_description || ticker || "Unknown asset"), issuerTicker: ticker, sector: "",
      publishedAt, publishedDisplay: displayDate(publishedAt), tradedAt, tradedDisplay: displayDate(tradedAt),
      reportingGap, filedAfterDisplay: `${reportingGap} days`, owner: String(trade.owner || ""),
      ownerDisplay: trade.owner ? String(trade.owner).replace(/\b\w/g, character => character.toUpperCase()) : "Not disclosed",
      type, typeExtended: "", typeDisplay: type === "buy" ? "Buy" : type === "sell" ? "Sell" : rawType,
      sizeDisplay: amount, estimatedValue: Number.isFinite(amountLow) && Number.isFinite(amountHigh) ? (amountLow + amountHigh) / 2 : amountMidpoint(amount),
      price: Number.isFinite(price) ? price : null, priceDisplay: Number.isFinite(price) ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })} est.` : "N/A",
      comment: Array.isArray(trade.conflict_flags) && trade.conflict_flags.length ? `${trade.conflict_flags.length} source conflict flag${trade.conflict_flags.length === 1 ? "" : "s"}`
        : Number.isFinite(Number(trade.perf_pct)) ? `${Number(trade.perf_pct).toFixed(2)}% since disclosed source estimate` : "",
      politicianUrl: trade.member_slug ? `https://www.capitolexposed.com/members/${trade.member_slug}` : "",
      issuerUrl: "", tradeUrl: link, sourcePage: Number(trade._sourcePage) || 1
    };
  }

  async function collectCongress(progress = () => {}) {
    const base = "https://www.capitolexposed.com/api/v1";
    const limit = 100;
    const cutoff = Date.now() - (90 * 86400000);
    let page = 0;
    let rawTrades = [];
    let latest = null;
    do {
      page += 1;
      progress("downloading", page - 1, page, `Requesting congressional trades page ${page} in the browser…`);
      latest = await fetchThroughBrowser(`${base}/trades?per_page=${limit}&page=${page}&sort=date`, "json");
      const rows = Array.isArray(latest?.data) ? latest.data : [];
      rawTrades.push(...rows.map(trade => ({ ...trade, _sourcePage: page })));
      progress("downloading", page, rows.length === limit ? page + 1 : page, `Received ${rawTrades.length.toLocaleString()} congressional trades from ${page} page${page === 1 ? "" : "s"}.`);
      const crossedCutoff = rows.some(trade => {
        const timestamp = Date.parse(trade.transaction_date || trade.tx_date);
        return Number.isFinite(timestamp) && timestamp < cutoff;
      });
      if (!latest?.meta?.has_more || rows.length < limit || crossedCutoff) break;
    } while (page < 100);

    progress("members", 0, 1, "Loading member details for party, chamber, and state…");
    const memberMap = new Map();
    let memberPage = 0;
    let memberResult;
    do {
      memberPage += 1;
      memberResult = await fetchThroughBrowser(`${base}/members?per_page=${limit}&page=${memberPage}`, "json");
      const members = Array.isArray(memberResult?.data) ? memberResult.data : [];
      members.forEach(member => memberMap.set(member.slug, member));
      progress("members", memberPage, memberResult?.meta?.has_more ? memberPage + 1 : memberPage, `Loaded ${memberMap.size} congressional member profiles.`);
      if (!memberResult?.meta?.has_more || !members.length) break;
    } while (memberPage < 10);
    rawTrades = rawTrades.map(trade => ({ ...trade, _member: memberMap.get(trade.member_slug) || null }));
    const normalized = rawTrades.map(normalizeCongressTrade)
      .filter(trade => ["buy", "sell"].includes(trade.type) && (!Date.parse(trade.tradedAt) || Date.parse(trade.tradedAt) >= cutoff));
    const trades = [...new Map(normalized.map(trade => [trade.id, trade])).values()]
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    if (!trades.length) throw new Error("The browser congressional feed returned no 90-day buy/sell trades.");
    progress("parsing", page, page, `Normalized ${trades.length.toLocaleString()} buy/sell disclosures.`);
    const payload = {
      source: {
        provider: "CapitolExposed API (browser feed)", url: "https://www.capitolexposed.com/api-docs",
        upstream: "Official House and Senate disclosure records", fetchedAt: new Date().toISOString(),
        sourceUpdatedAt: latest?.meta?.timestamp || null, window: "90 days", transactionTypes: ["buy", "sell"],
        pageSize: limit, pagesFetched: page, totalRows: trades.length
      },
      columns: ["Politician", "Traded Issuer", "Published", "Traded", "Filed After", "Owner", "Type", "Size", "Price"],
      trades
    };
    progress("saving", page, page, "Saving congressional trades in this browser…");
    try { await store.put("capitol", payload); }
    catch (error) { payload.source.storageWarning = error.message; }
    return payload;
  }

  function normalizeName(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\b(jr|sr|ii|iii|iv)\.?\b/gi, "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  }

  function cleanWikiLabel(value) {
    return String(value || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "")
      .replace(/<ref\b[^>]*\/>/gi, "").replace(/<[^>]+>/g, " ").replace(/''+/g, "")
      .replace(/\{\{[^{}]*\}\}/g, "").replace(/\s+/g, " ").trim();
  }

  async function fetchWikiPage(title) {
    const url = new URL(WIKI_API);
    Object.entries({ action: "parse", page: title, prop: "wikitext|text", format: "json", formatversion: "2", origin: "*", redirects: "1" })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const json = await fetchCandidate(url.href, "json");
    if (!json?.parse?.wikitext) throw new Error(`Wikipedia returned no content for ${title}.`);
    return { title: json.parse.title || title, wikitext: json.parse.wikitext, html: json.parse.text || "" };
  }

  function extractCommitteeLinks(wikitext, chamber) {
    const standingStart = wikitext.search(/^==\s*Standing committees\s*==/mi);
    const leadershipStart = wikitext.search(/^==\s*Party leadership\s*==/mi);
    const text = wikitext.slice(Math.max(0, standingStart), leadershipStart > standingStart ? leadershipStart : wikitext.length);
    const links = [];
    for (const match of text.matchAll(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g)) {
      const title = match[1].trim();
      const label = cleanWikiLabel(match[2] || title.replace(/^United States (?:House|Senate) (?:Permanent )?(?:Select |Special )?Committee on (?:the )?/i, ""));
      const pattern = chamber === "house" ? /^United States House (?:(?:Permanent )?Select )?Committee\b/i : /^United States Senate (?:(?:Special|Select) )?(?:Committee|Caucus)\b/i;
      const joint = /^(?:United States Congress )?Joint (?:Economic )?Committee|^Joint Committee/i.test(title);
      if ((!pattern.test(title) && !joint) || /Subcommittee/i.test(title)) continue;
      links.push({ chamber: joint ? "joint" : chamber, title, name: label || title });
    }
    return [...new Map(links.map(link => [`${link.chamber}:${link.title}`, link])).values()];
  }

  function currentCommitteeSection(wikitext) {
    const headings = [...wikitext.matchAll(/^(={2,4})\s*([^=\n]+?)\s*\1\s*$/gm)].map(match => ({
      level: match[1].length, title: match[2].trim(), index: match.index, start: match.index + match[0].length,
      congress: Number(match[2].match(/Members?,\s*(\d+)(?:st|nd|rd|th)\s+Congress/i)?.[1] || 0)
    }));
    const current = headings.filter(heading => heading.congress).sort((a, b) => b.congress - a.congress)[0]
      || headings.find(heading => /current members/i.test(heading.title)) || headings.find(heading => /^members$/i.test(heading.title));
    if (!current) return null;
    const next = headings.find(heading => heading.index > current.index && heading.level <= current.level);
    return { congress: current.congress || null, text: wikitext.slice(current.start, next ? next.index : wikitext.length) };
  }

  function extractState(text) {
    const clean = cleanWikiLabel(text);
    for (const [state, code] of Object.entries(STATE_CODES).sort((a, b) => b[0].length - a[0].length)) {
      if (new RegExp(`(?:^|[, (])${state.replace(/ /g, "\\s+")}(?:$|[, )])`, "i").test(clean)) return code;
    }
    return clean.match(/\b(?:R|D|I)-([A-Z]{2})\b/)?.[1] || null;
  }

  function extractMembers(wikitext, committee) {
    const section = currentCommitteeSection(wikitext);
    if (!section) return { congress: null, assignments: [] };
    const text = section.text.replace(/<!--[\s\S]*?-->/g, "").replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "").replace(/<ref\b[^>]*\/>/gi, "");
    const assignments = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*[*|!]/.test(line)) continue;
      const wikiLink = line.match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
      const sortName = line.match(/\{\{\s*sortname\s*\|\s*([^|}]+)\s*\|\s*([^|}]+)/i);
      let name;
      let wikiTitle;
      if (wikiLink) {
        wikiTitle = wikiLink[1].trim();
        name = cleanWikiLabel(wikiLink[2] || wikiTitle.replace(/\s*\([^)]*\)\s*$/, ""));
        if (/^(?:United States|List of|Democratic Party|Republican Party|Independent politician)/i.test(wikiTitle)) continue;
      } else if (sortName) {
        name = cleanWikiLabel(`${sortName[1]} ${sortName[2]}`);
        wikiTitle = name;
      } else continue;
      if (!name.includes(" ") || /Committee|Subcommittee|Congress|Senate|House of Representatives/i.test(name)) continue;
      assignments.push({
        name, normalizedName: normalizeName(name), state: extractState(line), committee: committee.name,
        committeeUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(committee.title.replace(/ /g, "_"))}`,
        chamber: committee.chamber, role: line.match(/\b(Vice Chair|Chair|Ranking Member|Vice Ranking Member)\b/i)?.[1] || "Member",
        memberUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}`
      });
    }
    return { congress: section.congress, assignments: [...new Map(assignments.map(item => [`${item.normalizedName}:${item.committee}`, item])).values()] };
  }

  async function mapConcurrent(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function collectCommittees(progress = () => {}) {
    progress("indexes", 0, 2, "Loading the House and Senate committee indexes from Wikipedia…");
    let indexesDone = 0;
    const indexes = await Promise.all(WIKI_INDEXES.map(async index => {
      const page = await fetchWikiPage(index.title);
      indexesDone += 1;
      progress("indexes", indexesDone, 2, `Loaded ${index.chamber} committee index (${indexesDone}/2).`);
      return { ...index, ...page };
    }));
    const links = [...new Map(indexes.flatMap(index => extractCommitteeLinks(index.wikitext, index.chamber)).map(link => [`${link.chamber}:${link.title}`, link])).values()];
    if (!links.length) throw new Error("Wikipedia exposed no current committee pages.");
    let done = 0;
    const rosters = await mapConcurrent(links, 3, async committee => {
      const page = await fetchWikiPage(committee.title);
      const roster = extractMembers(page.wikitext, committee);
      done += 1;
      progress("rosters", done, links.length, `Parsed ${committee.name} (${done}/${links.length}).`);
      return { ...committee, ...roster };
    });
    const assignments = rosters.flatMap(roster => roster.assignments);
    if (assignments.length < 100) throw new Error(`Only ${assignments.length} committee assignments were found; the browser result was not saved.`);
    const memberMap = new Map();
    assignments.forEach(assignment => {
      const key = `${assignment.chamber}:${assignment.normalizedName}`;
      const member = memberMap.get(key) || {
        name: assignment.name, normalizedName: assignment.normalizedName, chamber: assignment.chamber,
        state: assignment.state, memberUrl: assignment.memberUrl, committees: []
      };
      if (!member.state && assignment.state) member.state = assignment.state;
      member.committees.push({ name: assignment.committee, url: assignment.committeeUrl, role: assignment.role });
      memberMap.set(key, member);
    });
    const members = [...memberMap.values()].map(member => ({ ...member, committees: member.committees.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const payload = {
      source: {
        provider: "Wikipedia / MediaWiki API (browser fetch)",
        indexPages: WIKI_INDEXES.map(page => `https://en.wikipedia.org/wiki/${page.title.replace(/ /g, "_")}`),
        fetchedAt: new Date().toISOString(), congress: Math.max(...rosters.map(roster => roster.congress || 0)) || null,
        committeeCount: rosters.filter(roster => roster.assignments.length).length, memberCount: members.length,
        assignmentCount: assignments.length, updateIntervalHours: 24
      },
      members
    };
    progress("saving", links.length, links.length, `Saving ${members.length} lawmakers in this browser…`);
    try { await store.put("committees", payload); }
    catch (error) { payload.source.storageWarning = error.message; }
    return payload;
  }

  global.SentinelBrowser = {
    store,
    openInsiderSections: OPENINSIDER_SECTIONS.map(({ id, title }) => ({ id, title })),
    collectOpenInsider,
    collectCongress,
    collectCommittees
  };
})(globalThis);
