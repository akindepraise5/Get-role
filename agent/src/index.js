#!/usr/bin/env node
// Get@role search agent.
//   node src/index.js                      run every search in search.config.json
//   node src/index.js --track "Product design internships"
//   node src/index.js --days 1             override recency for every track
//   node src/index.js --no-llm             skip scoring (keyword filter only, costs nothing)
//   node src/index.js --provider groq
//
// Every track shares one network pass, then filters and scores it independently.
// Writes out/jobs-<date>.json (paste into the tracker) and a .csv.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./sources.js";
import { ask, looseJSON, pickProvider, PROVIDERS } from "./llm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

try {
  if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  /* Node < 20.12 — fall back to whatever is already in the environment */
}

const log = (...a) => console.log(...a);

/* ---------- args ---------- */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-llm") out.noLlm = true;
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--max") out.max = Number(argv[++i]);
    else if (a === "--track") out.track = argv[++i];
  }
  return out;
}
const flags = args(process.argv.slice(2));

/* ---------- config ---------- */
const config = JSON.parse(readFileSync(resolve(ROOT, "search.config.json"), "utf8"));
if (flags.provider) config.llm.provider = flags.provider;

const defaults = Object.assign(
  { remoteOnly: false, maxDaysOld: 2, minMatchScore: 60, maxResults: 25, keywords: [], excludeKeywords: [], mustMatchAll: [] },
  config.defaults || {}
);

// A single-profile config (the older shape) still works — it becomes one track.
let tracks = Array.isArray(config.searches) && config.searches.length
  ? config.searches
  : [Object.assign({ name: "All", profile: config.profile }, config.wants || {})];

tracks = tracks.map((t) => Object.assign({}, defaults, t));

if (flags.track) {
  const want = flags.track.toLowerCase();
  tracks = tracks.filter((t) => String(t.name).toLowerCase().includes(want));
  if (!tracks.length) {
    log(`No search matches "${flags.track}".`);
    process.exit(1);
  }
}
if (flags.days) tracks.forEach((t) => (t.maxDaysOld = flags.days));
if (flags.max) tracks.forEach((t) => (t.maxResults = flags.max));

const today = new Date().toISOString().slice(0, 10);
const poolDays = Math.max(...tracks.map((t) => t.maxDaysOld));

/* ---------- 1. collect once for every track ---------- */
log(`\nGet@role — ${tracks.length} search${tracks.length === 1 ? "" : "es"}, postings from the last ${poolDays} day(s)\n`);
log("Sources:");
const raw = await collect(config, log, poolDays);
log(`\n${raw.length} postings pulled.`);

/* ---------- 2. shared pool: recency + dedupe ---------- */
const keyOf = (j) =>
  `${String(j.company || "").toLowerCase().trim()}::${String(j.role || "").toLowerCase().trim()}`;

const cutoff = Date.now() - poolDays * 86400000;
const seen = new Set();
const pool = raw.filter((j) => {
  if (!j.postedAt) return false;
  const t = Date.parse(j.postedAt);
  if (isNaN(t) || t < cutoff) return false;
  const k = keyOf(j);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
log(`${pool.length} posted within ${poolDays} day(s), after removing duplicates.`);

/* ---------- 3. model ---------- */
const provider = flags.noLlm ? null : pickProvider(config.llm);
if (!flags.noLlm && !provider) {
  log(
    "\nNo model API key found, so results are keyword-ranked only.\n" +
      "Add one of these to agent/.env — the first four have free tiers:\n  " +
      Object.values(PROVIDERS).map((p) => `${p.env}${p.free ? " (free)" : ""}`).join("\n  ") +
      "\n"
  );
} else if (provider) {
  log(`Scoring with ${provider.label} (${provider.model}).`);
}

async function score(track, jobs) {
  if (!provider || !jobs.length) return;
  const size = config.llm.batchSize || 15;
  for (let start = 0, b = 1; start < jobs.length; start += size, b++) {
    const batch = jobs.slice(start, start + size);
    const listing = batch
      .map((j, i) =>
        [
          `#${i}`,
          `role: ${j.role}`,
          `company: ${j.company}`,
          `location: ${j.location} (${j.workMode || "unstated"})`,
          `type: ${j.type || "unstated"}`,
          `posted: ${j.postedAt.slice(0, 10)}`,
          `details: ${String(j.notes || "").slice(0, 550)}`,
        ].join("\n")
      )
      .join("\n---\n");

    const prompt =
      "You are screening job postings for one candidate. Here is the candidate:\n\n" +
      track.profile +
      "\n\nScore each posting below from 0 to 100 for how well it fits this candidate. " +
      "Be strict. A role demanding more experience than the candidate has, requiring relocation " +
      "they cannot do, or in a different discipline from the one described scores under 40 no " +
      "matter how appealing it sounds. A posting whose title looks right but whose body describes " +
      "a different seniority or discipline scores on the body, not the title.\n\n" +
      'Reply with ONLY a JSON object of the form {"results":[{"i":0,"score":72,"why":"…","type":"Internship"}]}\n' +
      "- i: the posting number exactly as given.\n" +
      "- score: integer 0-100.\n" +
      "- why: one sentence, under 110 characters, on why it does or does not fit.\n" +
      '- type: one of "Internship", "Graduate scheme", "Full-time", "Part-time", "Contract", "Fellowship", "Volunteer", or "".\n' +
      "Include every posting exactly once.\n\nPostings:\n\n" +
      listing;

    try {
      const parsed = looseJSON(await ask(provider, prompt));
      const rows = Array.isArray(parsed) ? parsed : parsed.results || [];
      for (const r of rows) {
        const j = batch[Number(r.i)];
        if (!j) continue;
        j.score = Math.max(0, Math.min(100, Number(r.score) || 0));
        j.why = String(r.why || "").slice(0, 160);
        if (r.type && !j.type) j.type = String(r.type);
      }
      log(`    batch ${b} scored`);
    } catch (e) {
      log(`    batch ${b} failed (${e.message}) — kept unscored`);
    }
  }
}

/* ---------- 4. run each track over the shared pool ---------- */
const results = [];

for (const track of tracks) {
  log(`\n── ${track.name} ─────────────────────────`);
  const trackCutoff = Date.now() - track.maxDaysOld * 86400000;
  const kw = (track.keywords || []).map((k) => k.toLowerCase());
  const bad = (track.excludeKeywords || []).map((k) => k.toLowerCase());
  const must = (track.mustMatchAll || []).map((k) => k.toLowerCase());

  // Keywords match the TITLE by default. Matching the description body instead
  // pulls in any posting that happens to mention "user experience" in passing —
  // set "searchBody": true on the track if you want that wider net.
  const field = (j) =>
    (track.searchBody ? `${j.role} ${j.type} ${j.notes}` : `${j.role} ${j.type}`).toLowerCase();

  // "5+ years", "3-5 yrs", "8+ YOE" — anywhere in the posting. Drops on the
  // LOWEST number stated, so "2+ required, 5+ preferred" survives a max of 3.
  const yearsDemanded = (j) => {
    const text = `${j.role} ${j.notes}`.toLowerCase();
    const found = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*\d{0,2}\s*(years?|yrs?|yoe)\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0 && n < 30);
    return found.length ? Math.min(...found) : null;
  };

  let jobs = pool
    .filter((j) => Date.parse(j.postedAt) >= trackCutoff)
    .filter((j) => {
      const title = String(j.role || "").toLowerCase();
      if (bad.some((b) => title.includes(b))) return false;
      if (track.maxYearsExperience != null) {
        const y = yearsDemanded(j);
        if (y !== null && y > track.maxYearsExperience) return false;
      }
      const f = field(j);
      if (must.length && !must.every((m) => f.includes(m))) return false;
      if (kw.length && !kw.some((k) => f.includes(k))) return false;
      return true;
    })
    .filter((j) => !track.remoteOnly || j.workMode === "Remote")
    .map((j) => ({ ...j, score: null, why: "", track: track.name }));

  log(`  ${jobs.length} match the keywords`);
  if (!jobs.length) continue;

  await score(track, jobs);

  if (provider) {
    const before = jobs.length;
    jobs = jobs.filter((j) => j.score === null || j.score >= track.minMatchScore);
    log(`  ${jobs.length} of ${before} cleared a score of ${track.minMatchScore}`);
  }

  jobs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.postedAt.localeCompare(a.postedAt));
  results.push({ track, jobs: jobs.slice(0, track.maxResults) });
}

/* ---------- 5. merge across tracks ---------- */
const merged = new Map();
for (const { jobs } of results) {
  for (const j of jobs) {
    const k = keyOf(j);
    const prev = merged.get(k);
    if (!prev) merged.set(k, { ...j, tracks: [j.track] });
    else {
      if (!prev.tracks.includes(j.track)) prev.tracks.push(j.track);
      if ((j.score ?? -1) > (prev.score ?? -1)) {
        prev.score = j.score;
        prev.why = j.why;
      }
    }
  }
}
const final = [...merged.values()].sort(
  (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.postedAt.localeCompare(a.postedAt)
);

/* ---------- 6. write ---------- */
const outDir = resolve(ROOT, "out");
mkdirSync(outDir, { recursive: true });

// Exactly the shape the tracker's paste box imports.
const forTracker = final.map((j) => ({
  role: j.role || "",
  company: j.company || "",
  location: j.location || "",
  workMode: j.workMode || "",
  type: j.type || "",
  salary: j.salary || "",
  deadline: "",
  link: j.link || "",
  source: j.source || "",
  contact: "",
  notes: [
    j.score !== null ? `Match ${j.score}/100 — ${j.why}` : null,
    `${j.tracks.join(" + ")} · posted ${j.postedAt.slice(0, 10)}`,
    String(j.notes || "").slice(0, 300),
  ]
    .filter(Boolean)
    .join("\n"),
}));

const jsonPath = resolve(outDir, `jobs-${today}.json`);
writeFileSync(jsonPath, JSON.stringify(forTracker, null, 2), "utf8");

const COLS = ["company", "role", "type", "workMode", "location", "salary", "source", "link", "notes"];
const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
const csvPath = resolve(outDir, `jobs-${today}.csv`);
writeFileSync(
  csvPath,
  [COLS.map(q).join(","), ...forTracker.map((r) => COLS.map((c) => q(r[c])).join(","))].join("\n"),
  "utf8"
);

/* ---------- 7. report ---------- */
if (!final.length) {
  log("\nNothing cleared the bar today. Widen maxDaysOld, loosen the keywords, or lower minMatchScore.\n");
  process.exit(0);
}

for (const { track, jobs } of results) {
  if (!jobs.length) continue;
  log(`\n${track.name} — ${jobs.length}\n`);
  for (const j of jobs) {
    const s = j.score === null ? " — " : String(j.score).padStart(3);
    log(`  ${s}  ${j.role}`);
    log(`       ${j.company}${j.location ? " · " + j.location : ""}${j.workMode ? " · " + j.workMode : ""}  [${j.source}]`);
    if (j.why) log(`       ${j.why}`);
    if (j.link) log(`       ${j.link}`);
    log("");
  }
}

log(`${final.length} unique role(s) written.\n`);
log(`Saved:\n  ${jsonPath}\n  ${csvPath}\n`);
log("Open Get@role, tap “Paste a job”, paste the contents of the .json file, and tap “Fill it in”.");
log("It adds every one at once and skips anything already in your tracker.\n");
