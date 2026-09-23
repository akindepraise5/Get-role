#!/usr/bin/env node
// Verifies every job board in boards.json and writes out/boards.json.
//
//   node src/boards.js
//
// Sequential on purpose: a parallel burst trips bot protection on these sites and
// reports false failures. A 403 is kept — that is a bot check answering, and the
// site works fine in a real browser. A 404 or a name that does not resolve is
// recorded so embed.js can drop it rather than ship a dead link.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function check(url, timeout = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    return { status: r.status, finalUrl: r.url !== url ? r.url : "" };
  } catch {
    return { status: 0, finalUrl: "" };
  } finally {
    clearTimeout(t);
  }
}

const master = JSON.parse(readFileSync(resolve(ROOT, "boards.json"), "utf8"));
const out = [];

console.log(`\nChecking ${master.boards.length} job boards…\n`);

let ok = 0,
  blocked = 0,
  dead = 0;

for (const b of master.boards) {
  const { status, finalUrl } = await check(b.url);
  const verdict = status >= 200 && status < 400 ? "ok" : status === 403 || status === 401 || status === 429 ? "blocked" : "dead";
  if (verdict === "ok") ok++;
  else if (verdict === "blocked") blocked++;
  else dead++;

  out.push({ ...b, status, verdict, finalUrl });
  console.log(
    `  ${String(status || "ERR").padEnd(4)} ${verdict.padEnd(8)} ${b.name.padEnd(30)} ${b.region}`
  );
  await new Promise((r) => setTimeout(r, 400));
}

mkdirSync(resolve(ROOT, "out"), { recursive: true });
const p = resolve(ROOT, "out", "boards.json");
writeFileSync(
  p,
  JSON.stringify({ verifiedAt: new Date().toISOString(), regions: master.regions, boards: out }, null, 2),
  "utf8"
);

console.log(`\n${ok} reachable · ${blocked} bot-blocked but live · ${dead} dead or unresolvable`);
if (dead) {
  console.log("\nDead entries — fix the URL in boards.json or delete them:");
  out.filter((b) => b.verdict === "dead").forEach((b) => console.log(`  ${b.name}  ${b.url}`));
}
console.log(`\nWritten to ${p}\n`);
