import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJSON = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const validTimestamp = value => Number.isFinite(Date.parse(value));

const indexHTML = await readFile(resolve(root, "index.html"), "utf8");
const inlineScript = indexHTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(inlineScript, "Dashboard inline script was not found");
new Function(inlineScript);

const openinsider = await readJSON("data/openinsider.json");
assert(validTimestamp(openinsider.source?.fetchedAt), "OpenInsider fetchedAt is invalid");
assert.equal(openinsider.sections?.length, 5, "OpenInsider must contain five lists");
const insiderRows = openinsider.sections.flatMap(section => section.rows || []);
assert.equal(insiderRows.length, openinsider.source.rowCount, "OpenInsider row count does not match metadata");
assert(insiderRows.every(row => row.ticker && row.company && row.tradeDate && row.tradeType), "OpenInsider contains an incomplete row");

const capitol = await readJSON("data/capitol-trades.json");
assert(validTimestamp(capitol.source?.fetchedAt), "Capitol Trades fetchedAt is invalid");
assert.equal(capitol.trades?.length, capitol.source.rowCount, "Capitol Trades row count does not match metadata");
if (Number.isFinite(capitol.source.reportedCount)) {
  assert.equal(capitol.trades.length, capitol.source.reportedCount, "Capitol Trades record count does not match the source-reported count");
}
assert.equal(new Set(capitol.trades.map(trade => trade.id)).size, capitol.trades.length, "Capitol Trades contains duplicate transaction IDs");
assert.equal(Math.max(...capitol.trades.map(trade => trade.sourcePage)), capitol.source.pagesFetched, "Capitol Trades did not reach the reported final page");
assert(capitol.trades.every(trade => trade.id && trade.politicianId && trade.politicianName && trade.issuerName && trade.publishedAt && trade.tradedAt), "Capitol Trades contains an incomplete row");

const committees = await readJSON("data/committee-memberships.json");
assert(validTimestamp(committees.source?.fetchedAt), "Committee fetchedAt is invalid");
assert.equal(committees.members?.length, committees.source.memberCount, "Committee member count does not match metadata");
const committeeAssignments = committees.members.reduce((total, member) => total + (member.committees?.length || 0), 0);
assert.equal(committeeAssignments, committees.source.assignmentCount, "Committee assignment count does not match metadata");
assert.equal(new Set(committees.members.map(member => `${member.chamber}:${member.normalizedName}`)).size, committees.members.length, "Committee roster contains duplicate member keys");
assert(committees.members.every(member => member.name && member.normalizedName && member.chamber && member.committees?.length), "Committee roster contains an incomplete member");

console.log(JSON.stringify({
  openInsiderRows: insiderRows.length,
  capitolTrades: capitol.trades.length,
  capitolPages: capitol.source.pagesFetched,
  committeeMembers: committees.members.length,
  committeeAssignments
}));
