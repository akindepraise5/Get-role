#!/usr/bin/env node
// Injects out/directory.json into the tracker page between its markers, so the
// Companies view ships with verified data instead of fetching at view time
// (the published page's network is blocked by CSP — it cannot call anything).
//
//   node src/directory.js && node src/embed.js
// then republish getatrole.html.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = resolve(ROOT, "..", "getatrole.html");
const START = "/*__DIRECTORY_START__*/";
const END = "/*__DIRECTORY_END__*/";

const dir = JSON.parse(readFileSync(resolve(ROOT, "out", "directory.json"), "utf8"));

// A careers URL that answered 404, or did not resolve at all, is dropped rather
// than shipped — a link verified to be broken is worse than no link. 403 is kept:
// that is bot protection answering, and the page works fine in a real browser.
const broken = new Set([0, 404, 410]);
let dropped = 0;

// Only what the page actually renders — keeps the payload small.
const slim = {
  verifiedAt: dir.verifiedAt,
  groups: dir.groups,
  companies: dir.companies.map((c) => ({
    name: c.name,
    group: c.group,
    hq: c.hq,
    sector: c.sector,
    site: c.site,
    careers: broken.has(c.careersOk) ? (dropped++, "") : c.careers,
    board: c.board,
    designRoles: c.designRoles,
    designTitles: (c.designTitles || []).slice(0, 4),
    disciplines: c.disciplines,
    hiringIn: c.hiringIn,
    social: c.social,
  })),
};

// --- job boards ---------------------------------------------------------
// A board that 404'd or never resolved is dropped. 403 is kept and flagged:
// that is bot protection answering, and the site opens fine in a real browser.
let boards = { verifiedAt: "", regions: [], boards: [] };
let boardsDropped = [];
try {
  const raw = JSON.parse(readFileSync(resolve(ROOT, "out", "boards.json"), "utf8"));
  boardsDropped = raw.boards.filter((b) => b.verdict === "dead").map((b) => b.name);
  boards = {
    verifiedAt: raw.verifiedAt,
    regions: raw.regions,
    boards: raw.boards
      .filter((b) => b.verdict !== "dead")
      .map((b) => ({ name: b.name, url: b.url, region: b.region, focus: b.focus, note: b.note, verdict: b.verdict })),
  };
} catch {
  console.log("No out/boards.json yet — run `node src/boards.js` to build the board list.");
}

function inject(html, startMark, endMark, value) {
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark);
  if (a < 0 || b < 0) {
    console.error(`Markers not found in ${PAGE}. Expected ${startMark} … ${endMark}`);
    process.exit(1);
  }
  return html.slice(0, a + startMark.length) + value + html.slice(b);
}

let html = readFileSync(PAGE, "utf8");
const json = JSON.stringify(slim);
const boardsJson = JSON.stringify(boards);

html = inject(html, START, END, json);
if (boards.boards.length) html = inject(html, "/*__BOARDS_START__*/", "/*__BOARDS_END__*/", boardsJson);
writeFileSync(PAGE, html, "utf8");

const kb = ((json.length + boardsJson.length) / 1024).toFixed(1);
const hiring = slim.companies.filter((c) => c.designRoles > 0).length;
if (boards.boards.length) {
  const blocked = boards.boards.filter((b) => b.verdict === "blocked").length;
  console.log(`Embedded ${boards.boards.length} job boards (${blocked} bot-protected but live).`);
  if (boardsDropped.length) console.log(`Dropped ${boardsDropped.length} dead board(s): ${boardsDropped.join(", ")}`);
}
console.log(`Embedded ${slim.companies.length} companies (${hiring} hiring designers), ${kb} KB, into ${PAGE}`);
if (dropped) console.log(`${dropped} careers link(s) dropped — they returned 404 or did not resolve.`);
console.log("Now republish the page.");
