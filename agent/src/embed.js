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

const html = readFileSync(PAGE, "utf8");
const a = html.indexOf(START);
const b = html.indexOf(END);
if (a < 0 || b < 0) {
  console.error(`Markers not found in ${PAGE}. Expected ${START} … ${END}`);
  process.exit(1);
}

const json = JSON.stringify(slim);
const next = html.slice(0, a + START.length) + json + html.slice(b);
writeFileSync(PAGE, next, "utf8");

const kb = (json.length / 1024).toFixed(1);
const hiring = slim.companies.filter((c) => c.designRoles > 0).length;
console.log(`Embedded ${slim.companies.length} companies (${hiring} hiring designers), ${kb} KB, into ${PAGE}`);
if (dropped) console.log(`${dropped} careers link(s) dropped — they returned 404 or did not resolve.`);
console.log("Now republish the page.");
