// Job sources. Every fetcher returns an array of jobs in one shape:
//   { role, company, location, workMode, type, salary, link, source, notes, postedAt }
// postedAt is an ISO date string and is what the recency filter reads.
// A source that fails is logged and skipped — one dead board never kills a run.

const UA = "Mozilla/5.0 (compatible; getatrole-agent/1.0)";

async function getJSON(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": UA, accept: "application/json", ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const iso = (v) => {
  if (v === null || v === undefined || v === "") return "";
  let d;
  if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(v);
  return isNaN(d) ? "" : d.toISOString();
};

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

// Entities first, then tags — several boards ship descriptions that are
// HTML escaped, so stripping tags before decoding leaves "div class=" debris.
const decode = (s) =>
  String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? " ");

const clean = (html, max = 700) => {
  let t = decode(html);
  for (let i = 0; i < 2 && /<[^>]+>/.test(t); i++) t = t.replace(/<[^>]*>/g, " ");
  return t.replace(/\s+/g, " ").trim().slice(0, max);
};

const modeOf = (text) => {
  const t = String(text || "").toLowerCase();
  if (/\bhybrid\b/.test(t)) return "Hybrid";
  if (/\bremote\b|worldwide|anywhere/.test(t)) return "Remote";
  if (/on[- ]?site|in[- ]?office/.test(t)) return "On-site";
  return "";
};

const typeOf = (text) => {
  const t = String(text || "").toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return "Internship";
  if (/\bgraduate\b|\btrainee\b/.test(t)) return "Graduate scheme";
  if (/\bpart[- ]?time\b/.test(t)) return "Part-time";
  if (/\bcontract(or)?\b|\bfreelance\b/.test(t)) return "Contract";
  if (/\bfull[- ]?time\b/.test(t)) return "Full-time";
  return "";
};

/* ------------------------------------------------------------------ */
/* Keyless sources                                                     */
/* ------------------------------------------------------------------ */

async function remotive() {
  const data = await getJSON("https://remotive.com/api/remote-jobs?limit=200");
  return (data.jobs || []).map((j) => ({
    role: j.title,
    company: j.company_name,
    location: j.candidate_required_location || "Remote",
    workMode: "Remote",
    type: typeOf(j.job_type) || typeOf(j.title),
    salary: j.salary || "",
    link: j.url,
    source: "Remotive",
    notes: clean(j.description),
    postedAt: iso(j.publication_date),
  }));
}

async function remoteok() {
  const data = await getJSON("https://remoteok.com/api");
  return (Array.isArray(data) ? data : [])
    .filter((j) => j && j.position)
    .map((j) => ({
      role: j.position,
      company: j.company,
      location: j.location || "Remote",
      workMode: "Remote",
      type: typeOf([j.position, (j.tags || []).join(" ")].join(" ")),
      salary: j.salary_min ? `$${j.salary_min}–$${j.salary_max}` : "",
      link: j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : ""),
      source: "RemoteOK",
      notes: clean(j.description),
      postedAt: iso(j.date),
    }));
}

async function arbeitnow() {
  const data = await getJSON("https://www.arbeitnow.com/api/job-board-api");
  return (data.data || []).map((j) => ({
    role: j.title,
    company: j.company_name,
    location: j.location || "",
    workMode: j.remote ? "Remote" : modeOf(j.location),
    type: typeOf((j.job_types || []).join(" ") || j.title),
    salary: j.salary || "",
    link: j.url,
    source: "Arbeitnow",
    notes: clean(j.description),
    postedAt: iso(j.created_at),
  }));
}

// Jobicy is the one board here whose category filter actually works server-side —
// Remotive and RemoteOK ignore theirs and return the same feed either way, so those
// two are filtered by each search's keywords instead.
async function jobicy(cfg) {
  const tags = (cfg && cfg.tags && cfg.tags.length) ? cfg.tags : [null];
  const batches = await Promise.all(
    tags.map((tag) =>
      getJSON(`https://jobicy.com/api/v2/remote-jobs?count=50${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`)
        .catch(() => ({ jobs: [] }))
    )
  );
  const data = { jobs: batches.flatMap((b) => b.jobs || []) };
  return (data.jobs || []).map((j) => ({
    role: j.jobTitle,
    company: j.companyName,
    location: j.jobGeo || "Remote",
    workMode: "Remote",
    type: typeOf((j.jobType || []).join(" ") || j.jobLevel || j.jobTitle),
    salary:
      j.annualSalaryMin && j.salaryCurrency
        ? `${j.salaryCurrency} ${j.annualSalaryMin}–${j.annualSalaryMax} / year`
        : "",
    link: j.url,
    source: "Jobicy",
    notes: clean(j.jobExcerpt || j.jobDescription),
    postedAt: iso(j.pubDate),
  }));
}

// Hacker News "Ask HN: Who is hiring?" — the monthly thread, read as individual comments.
async function hackernews(maxDaysOld) {
  const search = await getJSON(
    "https://hn.algolia.com/api/v1/search?query=Ask%20HN%20Who%20is%20hiring&tags=story&hitsPerPage=5"
  );
  const thread = (search.hits || []).find((h) => /who is hiring/i.test(h.title || ""));
  if (!thread) return [];
  const since = Math.floor((Date.now() - maxDaysOld * 86400000) / 1000);
  const comments = await getJSON(
    `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${thread.objectID}` +
      `&numericFilters=created_at_i>${since}&hitsPerPage=100`
  );
  return (comments.hits || [])
    .filter((c) => c.comment_text)
    .map((c) => {
      const text = clean(c.comment_text, 1200);
      // The convention is "Company | Role | Location | Remote | …" on the first line.
      const head = text.split("|").map((s) => s.trim());
      const url = (c.comment_text.match(/https?:\/\/[^\s"<]+/) || [""])[0];
      return {
        role: head[1] || text.slice(0, 80),
        company: head[0] || "",
        location: head[2] || "",
        workMode: modeOf(text),
        type: typeOf(text),
        salary: "",
        link: url || `https://news.ycombinator.com/item?id=${c.objectID}`,
        source: "HN Who is hiring",
        notes: text,
        postedAt: iso(c.created_at),
      };
    });
}

/* ------------------------------------------------------------------ */
/* Company ATS boards — the highest-signal source for a named shortlist */
/* ------------------------------------------------------------------ */

async function greenhouse(token) {
  const data = await getJSON(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
  );
  return (data.jobs || []).map((j) => ({
    role: j.title,
    company: token,
    location: (j.location && j.location.name) || "",
    workMode: modeOf([j.location && j.location.name, j.title].join(" ")),
    type: typeOf(j.title),
    salary: "",
    link: j.absolute_url,
    source: `${token} careers`,
    notes: clean(j.content),
    postedAt: iso(j.updated_at || j.first_published),
  }));
}

async function lever(company) {
  const data = await getJSON(
    `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`
  );
  return (Array.isArray(data) ? data : []).map((j) => ({
    role: j.text,
    company,
    location: (j.categories && j.categories.location) || "",
    workMode: modeOf([j.categories && j.categories.location, j.workplaceType].join(" ")),
    type: typeOf((j.categories && j.categories.commitment) || j.text),
    salary: (j.salaryRange && `${j.salaryRange.currency} ${j.salaryRange.min}–${j.salaryRange.max}`) || "",
    link: j.hostedUrl,
    source: `${company} careers`,
    notes: clean(j.descriptionPlain || j.description),
    postedAt: iso(j.createdAt),
  }));
}

async function ashby(org) {
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`
  );
  return (data.jobs || []).map((j) => ({
    role: j.title,
    company: org,
    location: j.location || "",
    workMode: j.isRemote ? "Remote" : modeOf(j.location),
    type: typeOf(j.employmentType || j.title),
    salary: (j.compensation && j.compensation.compensationTierSummary) || "",
    link: j.jobUrl,
    source: `${org} careers`,
    notes: clean(j.descriptionPlain || j.descriptionHtml),
    postedAt: iso(j.publishedAt || j.updatedAt),
  }));
}

/* ------------------------------------------------------------------ */
/* Keyed sources                                                       */
/* ------------------------------------------------------------------ */

async function adzuna(cfg, maxDaysOld) {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY not set");
  const url =
    `https://api.adzuna.com/v1/api/jobs/${cfg.country || "gb"}/search/1` +
    `?app_id=${id}&app_key=${key}&results_per_page=50&max_days_old=${maxDaysOld}` +
    `&what=${encodeURIComponent(cfg.what || "graduate software engineer")}`;
  const data = await getJSON(url);
  return (data.results || []).map((j) => ({
    role: j.title,
    company: (j.company && j.company.display_name) || "",
    location: (j.location && j.location.display_name) || "",
    workMode: modeOf([j.title, j.description].join(" ")),
    type: typeOf(j.contract_time || j.title),
    salary: j.salary_min ? `${Math.round(j.salary_min)}–${Math.round(j.salary_max)} / year` : "",
    link: j.redirect_url,
    source: "Adzuna",
    notes: clean(j.description),
    postedAt: iso(j.created),
  }));
}

async function jsearch(cfg, maxDaysOld) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error("RAPIDAPI_KEY not set");
  const window = maxDaysOld <= 1 ? "today" : maxDaysOld <= 3 ? "3days" : maxDaysOld <= 7 ? "week" : "month";
  const out = [];
  for (const q of cfg.queries || []) {
    const data = await getJSON(
      `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(q)}&date_posted=${window}&num_pages=1`,
      { headers: { "x-rapidapi-key": key, "x-rapidapi-host": "jsearch.p.rapidapi.com" } }
    );
    for (const j of data.data || []) {
      out.push({
        role: j.job_title,
        company: j.employer_name,
        location: [j.job_city, j.job_country].filter(Boolean).join(", "),
        workMode: j.job_is_remote ? "Remote" : modeOf(j.job_description),
        type: typeOf(j.job_employment_type || j.job_title),
        salary: j.job_min_salary ? `${j.job_salary_currency || ""} ${j.job_min_salary}–${j.job_max_salary}` : "",
        link: j.job_apply_link,
        source: j.job_publisher ? `Google Jobs / ${j.job_publisher}` : "Google Jobs",
        notes: clean(j.job_description),
        postedAt: iso(j.job_posted_at_datetime_utc),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

// A source may be `true` or `{ "enabled": true, ...options }`.
const on = (v) => v === true || (v && typeof v === "object" && v.enabled);
const opts = (v) => (v && typeof v === "object" ? v : {});

export async function collect(config, log, days) {
  const s = config.sources || {};
  const tasks = [];
  const add = (name, fn) => tasks.push({ name, fn });

  if (on(s.remotive)) add("Remotive", remotive);
  if (on(s.remoteok)) add("RemoteOK", remoteok);
  if (on(s.arbeitnow)) add("Arbeitnow", arbeitnow);
  if (on(s.jobicy)) add("Jobicy", () => jobicy(opts(s.jobicy)));
  if (on(s.hackernews)) add("HN Who is hiring", () => hackernews(days));

  const co = s.companies || {};
  for (const t of co.greenhouse || []) add(`greenhouse:${t}`, () => greenhouse(t));
  for (const t of co.lever || []) add(`lever:${t}`, () => lever(t));
  for (const t of co.ashby || []) add(`ashby:${t}`, () => ashby(t));

  if (on(s.adzuna)) add("Adzuna", () => adzuna(s.adzuna, days));
  if (on(s.jsearch)) add("JSearch", () => jsearch(s.jsearch, days));

  const settled = await Promise.allSettled(tasks.map((t) => t.fn()));
  const jobs = [];
  settled.forEach((r, i) => {
    const name = tasks[i].name;
    if (r.status === "fulfilled") {
      const rows = r.value.filter((j) => j && j.role);
      log(`  ${name}: ${rows.length}`);
      jobs.push(...rows);
    } else {
      log(`  ${name}: skipped (${r.reason && r.reason.message})`);
    }
  });
  return jobs;
}
