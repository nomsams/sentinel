import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://en.wikipedia.org/w/api.php";
const INDEX_PAGES = [
  { chamber: "house", title: "List of United States House of Representatives committees" },
  { chamber: "senate", title: "List of United States Senate committees" }
];

function reportProgress(stage, current, total, message) {
  console.log(`SENTINEL_PROGRESS ${JSON.stringify({ stage, current, total, message })}`);
}

async function writeJSONAtomic(outputPath, payload) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

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

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/gi, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function cleanWikiLabel(value) {
  return String(value || "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<ref\b[^>]*>[^]*?<\/ref>/gi, "")
    .replace(/<ref\b[^>]*\/>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/''+/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWikitext(title, attempt = 1) {
  const url = new URL(API_URL);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", title);
  url.searchParams.set("prop", "wikitext|text");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("maxlag", "5");
  const response = await fetch(url, {
    headers: { "User-Agent": "MarketSentinel/1.0 (https://nomsams.github.io/sentinel/)" }
  });
  if ((!response.ok || response.status === 429) && attempt < 4) {
    await delay(attempt * 1000);
    return fetchWikitext(title, attempt + 1);
  }
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status} for ${title}.`);
  let json;
  try {
    json = await response.json();
  } catch (error) {
    if (attempt < 4) {
      await delay(attempt * 1500);
      return fetchWikitext(title, attempt + 1);
    }
    throw error;
  }
  if (!json?.parse?.wikitext) throw new Error(`Wikipedia returned no wikitext for ${title}.`);
  return { title: json.parse.title || title, wikitext: json.parse.wikitext, html: json.parse.text || "" };
}

function currentCommitteeSection(wikitext) {
  const headings = [...wikitext.matchAll(/^(={2,4})\s*([^=\n]+?)\s*\1\s*$/gm)].map(match => ({
    level: match[1].length,
    title: match[2].trim(),
    index: match.index,
    start: match.index + match[0].length,
    congress: Number(match[2].match(/Members?,\s*(\d+)(?:st|nd|rd|th)\s+Congress/i)?.[1] || 0)
  }));
  const current = headings.filter(heading => heading.congress).sort((left, right) => right.congress - left.congress)[0]
    || headings.find(heading => /current members/i.test(heading.title))
    || headings.find(heading => /^members$/i.test(heading.title));
  if (!current) return null;
  const next = headings.find(heading => heading.index > current.index && heading.level <= current.level);
  return {
    congress: current.congress || null,
    text: wikitext.slice(current.start, next ? next.index : wikitext.length)
  };
}

function extractCommitteeLinks(wikitext, chamber) {
  const standingStart = wikitext.search(/^==\s*Standing committees\s*==/mi);
  const leadershipStart = wikitext.search(/^==\s*Party leadership\s*==/mi);
  const currentText = wikitext.slice(Math.max(0, standingStart), leadershipStart > standingStart ? leadershipStart : wikitext.length);
  const links = [];
  for (const match of currentText.matchAll(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g)) {
    const title = match[1].trim();
    const label = cleanWikiLabel(match[2] || title.replace(/^United States (?:House|Senate) (?:Permanent )?(?:Select |Special )?Committee on (?:the )?/i, ""));
    const chamberPattern = chamber === "house"
      ? /^United States House (?:(?:Permanent )?Select )?Committee\b/i
      : /^United States Senate (?:(?:Special|Select) )?(?:Committee|Caucus)\b/i;
    const isJoint = /^(?:United States Congress )?Joint (?:Economic )?Committee|^Joint Committee/i.test(title);
    if ((!chamberPattern.test(title) && !isJoint) || /Subcommittee/i.test(title)) continue;
    links.push({ chamber: isJoint ? "joint" : chamber, title, name: label || title });
  }
  return [...new Map(links.map(link => [`${link.chamber}:${link.title}`, link])).values()];
}

function extractState(text) {
  const clean = cleanWikiLabel(text);
  for (const [state, code] of Object.entries(STATE_CODES).sort((left, right) => right[0].length - left[0].length)) {
    if (new RegExp(`(?:^|[, (])${state.replace(/ /g, "\\s+")}(?:$|[, )])`, "i").test(clean)) return code;
  }
  const code = clean.match(/\b(?:R|D|I)-([A-Z]{2})\b/)?.[1];
  return code || null;
}

function decodeEntities(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function extractRenderedMembers(html, committee, congress) {
  if (!html) return [];
  const headingExpression = new RegExp(`<h([2-4])\\b[^>]*>[\\s\\S]*?Members?[^<]*${congress || ""}[^<]*Congress[\\s\\S]*?<\\/h\\1>`, "i");
  const heading = headingExpression.exec(html);
  if (!heading) return [];
  const level = Number(heading[1]);
  const rest = html.slice(heading.index + heading[0].length);
  const nextHeading = new RegExp(`<h[2-${level}]\\b`, "i").exec(rest);
  const section = rest.slice(0, nextHeading?.index ?? rest.length);
  const assignments = [];
  for (const match of section.matchAll(/<a\b[^>]*href="(?:\.\/|\/wiki\/)([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const wikiTitle = decodeURIComponent(match[1]);
    const name = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\[[0-9]+\]/g, "").replace(/\s+/g, " ").trim();
    if (!name.includes(" ") || STATE_CODES[name] || /(?:Committee|Subcommittee|Congress|Senate|House|Party|Resolution|United States)/i.test(name)) continue;
    if (/^(?:United_States|List_of|Democratic_Party|Republican_Party|Independent_politician)/i.test(wikiTitle)) continue;
    assignments.push({
      name,
      normalizedName: normalizeName(name),
      state: null,
      committee: committee.name,
      committeeUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(committee.title.replace(/ /g, "_"))}`,
      chamber: committee.chamber,
      role: "Member",
      memberUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}`
    });
  }
  return [...new Map(assignments.map(item => [`${item.normalizedName}:${item.committee}`, item])).values()];
}

function extractMembers(wikitext, committee, html = "") {
  const section = currentCommitteeSection(wikitext);
  if (!section) return { congress: null, assignments: [] };
  const text = section.text.replace(/<!--[^]*?-->/g, "").replace(/<ref\b[^>]*>[^]*?<\/ref>/gi, "").replace(/<ref\b[^>]*\/>/gi, "");
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
      wikiTitle = name.replace(/ /g, "_");
    } else {
      continue;
    }
    if (!name.includes(" ") || /Committee|Subcommittee|Congress|Senate|House of Representatives/i.test(name)) continue;
    const role = line.match(/\b(Vice Chair|Chair|Ranking Member|Vice Ranking Member)\b/i)?.[1] || "Member";
    assignments.push({
      name,
      normalizedName: normalizeName(name),
      state: extractState(line),
      committee: committee.name,
      committeeUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(committee.title.replace(/ /g, "_"))}`,
      chamber: committee.chamber,
      role,
      memberUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}`
    });
  }
  const unique = [...new Map(assignments.map(item => [`${item.normalizedName}:${item.committee}`, item])).values()];
  const rendered = unique.length ? [] : extractRenderedMembers(html, committee, section.congress);
  return { congress: section.congress, assignments: unique.length ? unique : rendered };
}

async function mapWithConcurrency(items, limit, mapper) {
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

async function main() {
  reportProgress("indexes", 0, INDEX_PAGES.length, "Loading House and Senate committee indexes from Wikipedia…");
  let completedIndexes = 0;
  const indexes = await Promise.all(INDEX_PAGES.map(async index => {
    const page = await fetchWikitext(index.title);
    completedIndexes += 1;
    reportProgress("indexes", completedIndexes, INDEX_PAGES.length, `Loaded ${index.chamber} committee index (${completedIndexes}/${INDEX_PAGES.length}).`);
    return { ...index, ...page };
  }));
  const committeeLinks = [...new Map(indexes.flatMap(index => extractCommitteeLinks(index.wikitext, index.chamber))
    .map(link => [`${link.chamber}:${link.title}`, link])).values()];
  console.log(`Wikipedia index pages exposed ${committeeLinks.length} current committee pages.`);

  let completedRosters = 0;
  const rosters = await mapWithConcurrency(committeeLinks, 3, async committee => {
    await delay(150);
    const page = await fetchWikitext(committee.title);
    const roster = extractMembers(page.wikitext, committee, page.html);
    completedRosters += 1;
    console.log(`Parsed ${completedRosters}/${committeeLinks.length}: ${committee.name} (${roster.assignments.length} assignments).`);
    reportProgress("rosters", completedRosters, committeeLinks.length, `Parsed ${committee.name}: ${roster.assignments.length} assignments (${completedRosters}/${committeeLinks.length}).`);
    return { ...committee, resolvedTitle: page.title, ...roster };
  });

  const assignments = rosters.flatMap(roster => roster.assignments);
  if (assignments.length < 200) throw new Error(`Only ${assignments.length} committee assignments were found; refusing an incomplete snapshot.`);
  const memberMap = new Map();
  for (const assignment of assignments) {
    const key = `${assignment.chamber}:${assignment.normalizedName}`;
    const existing = memberMap.get(key) || {
      name: assignment.name,
      normalizedName: assignment.normalizedName,
      chamber: assignment.chamber,
      state: assignment.state,
      memberUrl: assignment.memberUrl,
      committees: []
    };
    if (!existing.state && assignment.state) existing.state = assignment.state;
    existing.committees.push({ name: assignment.committee, url: assignment.committeeUrl, role: assignment.role });
    memberMap.set(key, existing);
  }
  const members = [...memberMap.values()]
    .map(member => ({ ...member, committees: member.committees.sort((left, right) => left.name.localeCompare(right.name)) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const congress = Math.max(...rosters.map(roster => roster.congress || 0));
  const fetchedAt = new Date().toISOString();
  const payload = {
    source: {
      provider: "Wikipedia / MediaWiki API",
      indexPages: INDEX_PAGES.map(page => `https://en.wikipedia.org/wiki/${page.title.replace(/ /g, "_")}`),
      fetchedAt,
      congress: congress || null,
      committeeCount: rosters.filter(roster => roster.assignments.length).length,
      memberCount: members.length,
      assignmentCount: assignments.length,
      updateIntervalHours: 24
    },
    members
  };
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const outputPath = resolve(scriptDirectory, "..", "data", "committee-memberships.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeJSONAtomic(outputPath, payload);
  reportProgress("saving", committeeLinks.length, committeeLinks.length, `Saved ${members.length} lawmakers and ${assignments.length} committee assignments.`);
  console.log(`Saved ${members.length} members and ${assignments.length} assignments to ${outputPath}.`);
}

await main();
