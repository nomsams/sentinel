import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "http://openinsider.com/";
const SECTION_DEFINITIONS = [
  { id: "cluster-buys", title: "Cluster Buys" },
  { id: "insider-buys", title: "Insider Buys" },
  { id: "penny-stock-buys", title: "Penny Stock Buys" },
  { id: "sales-100k", title: "Sales $100k+" },
  { id: "latest-trading", title: "Latest Trading" }
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

const entityMap = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  quot: '"'
};

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entityMap[entity.toLowerCase()] ?? match;
  });
}

function stripTags(fragment) {
  let output = "";
  let insideTag = false;
  let quote = null;

  for (const character of fragment) {
    if (!insideTag) {
      if (character === "<") insideTag = true;
      else output += character;
      continue;
    }

    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      insideTag = false;
    }
  }

  return output;
}

function textContent(fragment) {
  return decodeEntities(
    stripTags(fragment
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, ""))
  ).replace(/\s+/g, " ").trim();
}

function extractCells(row, tagName) {
  const cells = [];
  const expression = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = expression.exec(row))) cells.push(textContent(match[1]));
  return cells;
}

function numericValue(value) {
  const normalized = String(value).replace(/[^0-9.+-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTable(table, definition) {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const headers = rows.map(row => extractCells(row, "th")).find(cells => cells.length >= 13) ?? [];
  const records = rows
    .map(row => extractCells(row, "td"))
    .filter(cells => cells.length >= 13)
    .slice(0, 10)
    .map(cells => ({
      flags: cells[0],
      filingDate: cells[1],
      tradeDate: cells[2],
      ticker: cells[3],
      company: cells[4],
      detail: cells[5],
      role: cells[6],
      tradeType: cells[7],
      price: cells[8],
      quantity: cells[9],
      owned: cells[10],
      ownershipChange: cells[11],
      value: cells[12],
      dayReturn: cells[13] ?? "",
      weekReturn: cells[14] ?? "",
      monthReturn: cells[15] ?? "",
      sixMonthReturn: cells[16] ?? "",
      priceValue: numericValue(cells[8]),
      quantityValue: numericValue(cells[9]),
      tradeValue: numericValue(cells[12])
    }));

  if (!records.length) throw new Error(`OpenInsider section "${definition.title}" contained no usable rows.`);

  return {
    ...definition,
    detailLabel: headers[5] || "Insider / Industry",
    roleLabel: headers[6] || "Title / Insiders",
    rows: records
  };
}

async function main() {
  reportProgress("connecting", 0, SECTION_DEFINITIONS.length, "Connecting to OpenInsider…");
  const response = await fetch(SOURCE_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; MarketSentinel/1.0; +https://nomsams.github.io/sentinel/)"
    },
    redirect: "follow"
  });

  if (!response.ok) throw new Error(`OpenInsider returned HTTP ${response.status}.`);

  const html = await response.text();
  reportProgress("downloading", 0, SECTION_DEFINITIONS.length, `Downloaded ${html.length.toLocaleString()} characters from OpenInsider.`);
  const tables = [...html.matchAll(/<table\b[^>]*class=(?:"[^"]*\btinytable\b[^"]*"|'[^']*\btinytable\b[^']*')[^>]*>[\s\S]*?<\/table>/gi)]
    .map(match => match[0]);

  if (tables.length < SECTION_DEFINITIONS.length) {
    throw new Error(`Expected ${SECTION_DEFINITIONS.length} OpenInsider tables, received ${tables.length}.`);
  }

  const sections = SECTION_DEFINITIONS.map((definition, index) => {
    const section = parseTable(tables[index], definition);
    reportProgress("parsing", index + 1, SECTION_DEFINITIONS.length, `Parsed ${definition.title}: ${section.rows.length} live rows.`);
    return section;
  });
  const fetchedAt = new Date().toISOString();
  const payload = {
    source: {
      provider: "OpenInsider",
      url: SOURCE_URL,
      fetchedAt,
      lastModified: response.headers.get("last-modified"),
      updateIntervalMinutes: 30,
      rowCount: sections.reduce((total, section) => total + section.rows.length, 0)
    },
    sections
  };

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const outputPath = resolve(scriptDirectory, "..", "data", "openinsider.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeJSONAtomic(outputPath, payload);
  reportProgress("saving", SECTION_DEFINITIONS.length, SECTION_DEFINITIONS.length, `Saved ${payload.source.rowCount} current OpenInsider rows.`);
  console.log(`Saved ${payload.source.rowCount} live OpenInsider rows to ${outputPath} at ${fetchedAt}.`);
}

await main();
