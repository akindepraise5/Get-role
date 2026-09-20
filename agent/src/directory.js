#!/usr/bin/env node
// Builds the company directory.
//   node src/directory.js            verify boards + careers URLs, write out/directory.json
//   node src/directory.js --quick    skip careers-URL checks (boards only, much faster)
//
// Everything it writes is derived from a live response, never asserted:
//   designRoles  — design job titles currently open on the company's board
//   disciplines  — which of product / uiux / graphic those titles actually are
//   hiringIn     — the regions those design roles are located in
//   careersOk    — the HTTP status the careers URL returned
// A company with no machine-readable board keeps its curated links and is
// marked `board: null`, so the page can say "check their site" rather than
// pretend to know.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DESIGN = /design|ux|\bui\b|creative|brand studio/i;
const DISCIPLINE = {
  product: /product design|product designer/i,
  uiux: /\bux\b|\bui\b|user experience|interaction design|experience design|design system/i,
  graphic: /graphic|brand design|visual design|creative|illustrat|motion/i,
};

// Cities and countries, mapped to the regions the directory groups by.
const REGIONS = {
  "UK & Ireland": /london|manchester|edinburgh|bristol|cambridge|leeds|glasgow|belfast|dublin|united kingdom|\buk\b|england|ireland/i,
  Europe: /berlin|munich|hamburg|amsterdam|paris|madrid|barcelona|lisbon|stockholm|copenhagen|oslo|helsinki|warsaw|zurich|geneva|milan|rome|vienna|prague|brussels|dublin|germany|france|spain|netherlands|sweden|poland|portugal|italy|switzerland|denmark|norway|finland|austria|belgium/i,
  "Asia-Pacific": /singapore|tokyo|osaka|seoul|hong kong|shanghai|beijing|shenzhen|taipei|bangalore|bengaluru|mumbai|hyderabad|delhi|gurgaon|pune|chennai|jakarta|manila|bangkok|kuala lumpur|sydney|melbourne|auckland|india|japan|china|korea|australia|singapore/i,
  "North America": /san francisco|new york|seattle|austin|boston|chicago|los angeles|denver|atlanta|toronto|vancouver|montreal|united states|\busa\b|\bus\b|canada|california|texas|washington|remote - us/i,
  Remote: /remote|anywhere|distributed|worldwide/i,
};

async function getJSON(url, timeout = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "user-agent": UA, accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function headStatus(url, timeout = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
    });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

/** Pulls every open role from a company's board and returns {title, location}. */
async function board(ats) {
  if (!ats) return null;
  if (ats.type === "greenhouse") {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${ats.slug}/jobs`);
    return (d.jobs || []).map((j) => ({ title: j.title, location: (j.location && j.location.name) || "", url: j.absolute_url }));
  }
  if (ats.type === "lever") {
    const d = await getJSON(`https://api.lever.co/v0/postings/${ats.slug}?mode=json`);
    return (Array.isArray(d) ? d : []).map((j) => ({
      title: j.text,
      location: (j.categories && j.categories.location) || "",
      url: j.hostedUrl,
    }));
  }
  if (ats.type === "ashby") {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${ats.slug}`);
    return (d.jobs || []).map((j) => ({ title: j.title, location: j.location || "", url: j.jobUrl }));
  }
  return null;
}

const BOARD_URL = {
  greenhouse: (s) => `https://boards.greenhouse.io/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
};

// Social links are SEARCHES, not asserted profile URLs. A guessed
// linkedin.com/company/<slug> is wrong often enough to be worse than useless;
// a search always lands the user in the right place.
const social = (name) => ({
  linkedin: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name)}`,
  x: `https://x.com/search?q=${encodeURIComponent(name)}&f=user`,
  instagram: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(name)}`,
  dribbble: `https://dribbble.com/search/${encodeURIComponent(name)}`,
});

const master = JSON.parse(readFileSync(resolve(ROOT, "companies.json"), "utf8"));
const out = [];

console.log(`\nVerifying ${master.companies.length} companies…\n`);

for (const c of master.companies) {
  const row = {
    name: c.name,
    group: c.group,
    hq: c.hq || "",
    sector: c.sector || "",
    site: c.site || "",
    careers: c.careers || "",
    board: null,
    boardType: null,
    openRoles: null,
    designRoles: null,
    designTitles: [],
    disciplines: [],
    hiringIn: [],
    careersOk: null,
    social: social(c.name),
  };

  if (c.ats) {
    try {
      const jobs = await board(c.ats);
      if (jobs && jobs.length) {
        const design = jobs.filter((j) => DESIGN.test(j.title || ""));
        row.board = BOARD_URL[c.ats.type](c.ats.slug);
        row.boardType = c.ats.type;
        row.openRoles = jobs.length;
        row.designRoles = design.length;
        row.designTitles = design.slice(0, 6).map((j) => j.title);

        for (const [k, re] of Object.entries(DISCIPLINE)) {
          if (design.some((j) => re.test(j.title))) row.disciplines.push(k);
        }
        const blob = design.map((j) => `${j.location} ${j.title}`).join(" | ");
        for (const [region, re] of Object.entries(REGIONS)) {
          if (re.test(blob)) row.hiringIn.push(region);
        }
      }
    } catch (e) {
      console.log(`  ${c.name}: board unreachable (${e.message})`);
    }
  }

  if (!quick && c.careers) {
    row.careersOk = await headStatus(c.careers);
    await new Promise((r) => setTimeout(r, 350)); // these sites rate-limit bursts hard
  }

  const flag = row.designRoles ? `${row.designRoles} design` : row.board ? "0 design" : "no public board";
  console.log(`  ${c.name.padEnd(18)} ${flag}${row.careersOk ? `  careers:${row.careersOk}` : ""}`);
  out.push(row);
}

const payload = {
  verifiedAt: new Date().toISOString(),
  groups: master.groups,
  companies: out,
};

mkdirSync(resolve(ROOT, "out"), { recursive: true });
const p = resolve(ROOT, "out", "directory.json");
writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");

const withBoard = out.filter((r) => r.board).length;
const hiring = out.filter((r) => r.designRoles > 0).length;
console.log(
  `\n${out.length} companies · ${withBoard} with a readable board · ${hiring} with design roles open right now.`
);
console.log(`Written to ${p}\n`);
