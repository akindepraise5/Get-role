# Get@role search agent

Searches job boards for postings from the last day or two, scores each one against your
profile using whichever AI model key you have, and writes a file you paste straight into
the [Get@role tracker](https://claude.ai/artifact/QuTbSvRZQqEza2bzE4CBzf).

## Why this runs on your machine

The tracker is a web page published on claude.ai. It runs under a content security policy
that blocks all outbound network calls — it cannot reach a job board or a model API, and an
API key placed inside it would be readable by anyone who opened the link. So the searching
happens here, on your computer, and the tracker imports the result.

## Setup

```bash
cd agent
cp .env.example .env      # then open .env and fill in ONE model key
node src/index.js
```

No `npm install` — there are no dependencies. Node 20.12 or newer.

### Which key to get

Four providers have a genuinely free tier. **ChatGPT, Grok and Claude do not** — their APIs
are paid per token, though this job costs fractions of a cent per run.

| Provider | Free tier | Get a key |
|---|---|---|
| **Groq** | Yes — fastest option | <https://console.groq.com/keys> |
| **Google Gemini** | Yes — generous | <https://aistudio.google.com/apikey> |
| **Cerebras** | Yes | <https://cloud.cerebras.ai> |
| **OpenRouter** | Yes, on `:free` models | <https://openrouter.ai/keys> |
| DeepSeek | No, but cheapest paid | <https://platform.deepseek.com> |
| OpenAI (ChatGPT) | No | <https://platform.openai.com/api-keys> |
| xAI (Grok) | No | <https://console.x.ai> |
| Anthropic (Claude) | No | <https://console.anthropic.com> |

Fill in any one. The agent picks the first key it finds, free tiers first. To force one:

```bash
node src/index.js --provider gemini
```

Model IDs change often. If a provider rejects the default, set your own in
`search.config.json` → `"llm": { "provider": "xai", "model": "grok-4" }`.

## Running it

```bash
node src/index.js                                   # every track
node src/index.js --track "internships"             # one track (substring match)
node src/index.js --days 1                          # only today's postings
node src/index.js --no-llm                          # keyword filter only, spends nothing
node src/index.js --max 40                          # keep more results
```

### Finding design roles specifically

Design roles are rarer than engineering ones, and the keyless boards skew heavily towards
engineering — expect a handful of results a day, not dozens. Three levers, in order of how
much they help:

1. **Add company boards.** By far the biggest win. These slugs are verified to post design
   roles regularly: Greenhouse — `figma`, `databricks`, `pinterest`, `duolingo`, `asana`,
   `coinbase`, `airtable`. Ashby — `linear`, `vanta`, `ramp`, `notion`, `replit`.
2. **Widen `maxDaysOld` on the internship track.** Design internships are posted in seasonal
   batches, not continuously. `7` to `14` is realistic; `2` will usually find nothing.
3. **Turn on JSearch** (`RAPIDAPI_KEY`) with design queries — it reaches Google Jobs, which
   indexes far more design postings than any of the free boards.

## Configure it — edit `search.config.json`

`searches` is a list of independent **tracks**. Two ship configured — *Product design
internships* and *Product design roles* — each with its own profile, keywords and recency.
All tracks share one network pass, so adding a track costs no extra fetching. Copy a block
to add your own (engineering roles, research, whatever), and run one at a time with
`--track "Product design internships"`.

**`profile` is the field that matters most.** It is the text the model scores every posting
against, so write it like you would describe yourself to a careers adviser: where you are,
what you can actually do, and what you will not take. A vague profile gives vague scores.

| Setting | What it does |
|---|---|
| `name` | What the track is called in the output and on `--track` |
| `profile` | The candidate description the model scores against |
| `keywords` | A posting matches if its **title** contains at least one. Free — runs before the model |
| `mustMatchAll` | Every one of these must appear. `["intern"]` is what makes the internship track an internship track |
| `excludeKeywords` | Any match **in the title** drops the posting — `senior`, `head of`, `brand design` |
| `maxYearsExperience` | Drops postings demanding more, reading `5+ years` / `3-5 yrs` / `8+ YOE` from anywhere in the posting. Uses the *lowest* number stated, so "2+ required, 5+ preferred" survives a max of 3 |
| `searchBody` | `false` (default) matches titles only. `true` also searches the description — a much wider net, and a lot more noise |
| `maxDaysOld` | How fresh. `2` for full-time roles; internships are posted in seasonal batches, so `7`–`14` suits them better |
| `minMatchScore` | Postings scoring below this are dropped. `60` is a sensible start |
| `remoteOnly` | Drop anything not explicitly remote |
| `maxResults` | How many to write out |

### Why titles, not descriptions

Matching on description bodies sounds thorough and is actually the main source of junk — an
"IT Systems Engineer" posting that mentions *user experience* once will match a design
search. Titles are how job boards actually name roles, so that is the default. If a track
returns too little, widen `maxDaysOld` and add company boards before reaching for
`searchBody`.

### Sources

Five boards need no key and are on by default: **Remotive**, **RemoteOK**, **Arbeitnow**,
**Jobicy** and the monthly **Hacker News "Who is hiring"** thread. A typical run pulls
around 3,000 postings before filtering.

*Hacker News returns nothing for most of the month* — the thread is posted on the 1st and
its comments are only "fresh" for the first few days. That is expected, not a failure.

**Company boards** are the highest-signal source. Add any company whose careers page runs on
Greenhouse, Lever or Ashby — the slug is the last part of the URL:

- `boards.greenhouse.io/**gitlab**` → add `"gitlab"` under `greenhouse`
- `jobs.lever.co/**spotify**` → add `"spotify"` under `lever`
- `jobs.ashbyhq.com/**linear**` → add `"linear"` under `ashby`

A company that hosts its own careers page has no public API and cannot be added. Many
African fintechs are in that group — Paystack, Flutterwave, Moniepoint and Kuda all return
404 on these APIs, so watch those manually and paste postings into the tracker directly.

**Two optional keyed sources**, both free to sign up for:

- **Adzuna** (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`) — real listings for the UK, US, South
  Africa, India, Australia and more. No Nigeria coverage.
- **JSearch** on RapidAPI (`RAPIDAPI_KEY`) — Google Jobs data with a real date filter, and
  the one source here with genuine Nigeria coverage. Free tier is about 200 requests/month.

Turn either on by setting `"enabled": true` in `search.config.json`.

## Job boards

The second tab of **Where to look** in the tracker: the boards worth checking by hand,
filterable by discipline (UI/UX, Graphic, Branding, General) and by region.

Two kinds are in there. **Design-specific and remote-first boards** — Dribbble, Behance,
UX Jobs Board, Coroflot, AIGA, IxDA, Awwwards, Working Not Working, The Design Kids and the
remote boards your agent already reads. And **native boards for eleven European markets** —
Dasauge and StepStone for Germany, Welcome to the Jungle and APEC for France, Creativeheads
and Magnet.me for the Netherlands, Domestika and InfoJobs for Spain, The Hub and Jobindex
for the Nordics, No Fluff Jobs and JustJoin.IT for Poland, and so on.

Several are local-language only. Use them anyway — browser translation handles them fine,
and they carry roles that never reach the English-language boards.

```bash
npm run boards      # re-check every board URL
```

Edit [boards.json](boards.json) to add your own. Each board needs a `name`, `url`, `region`
(one of the list at the top of the file) and `focus` — any of `uiux`, `graphic`, `branding`,
`general`.

### The three-verdict check

`src/boards.js` requests each URL sequentially — a parallel burst trips bot protection and
reports false failures — and records one of three verdicts:

| Verdict | Meaning | What happens |
|---|---|---|
| `ok` | 2xx/3xx | Listed normally |
| `blocked` | 401/403/429 | Bot protection answering. The site is live and opens fine in a real browser, so it is listed and tagged *opens in browser only* |
| `dead` | 404, or the name never resolved | **Dropped at embed time.** Never shipped |

That third row is why the list is shorter than the one I started with — a handful of boards
that used to exist no longer do, and a link verified broken is worse than no link.

## The company directory

A separate feature from the search: a browsable list of big tech, Fortune 500, UK, European
and Asia-Pacific companies, with what design roles each has open *right now*.

```bash
npm run refresh     # verify everything, then embed it in the tracker page
```

That runs two scripts:

- **`src/directory.js`** reads [companies.json](companies.json), hits each company's job
  board, and records what it finds — how many design roles are open, their actual titles,
  which of product / UI-UX / graphic they are, and which regions they sit in. It also
  requests each careers URL and records the HTTP status.
- **`src/embed.js`** writes the result into `index.html` between its markers. It has to
  be embedded rather than fetched, because the published page's network is blocked by CSP.

Then republish the page and open **Companies** in the toolbar.

### What is fact and what is not

Everything about design roles is **derived from a live response**, never asserted by me:
counts, job titles, disciplines and locations all come from the company's own board. That
is also why *"American companies hiring designers in the UK"* is a real filter and not a
guess — it means "this company's currently-open design roles include a UK location."

Two honest limits:

- **The biggest companies have no readable board.** Google, Apple, Microsoft, Amazon, Meta,
  Netflix, Adobe, Salesforce, Oracle, Nvidia and most Fortune 500 names run their own
  careers software with no public API. They're in the directory with verified careers links
  and are marked *no public board* — the counts genuinely aren't knowable from here.
- **Social links are searches, not profile URLs.** A guessed `linkedin.com/company/<slug>`
  is wrong often enough to be worse than useless, so each company links to a LinkedIn, X,
  Instagram and Dribbble *search* for its name. Those always land you in the right place.

A careers URL that returned 404 or failed to resolve is dropped at embed time rather than
shipped — a link verified to be broken is worse than no link.

### Adding companies

Copy a block in [companies.json](companies.json). If the company's careers page is
`boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>` or `jobs.ashbyhq.com/<slug>`, add the
`ats` block and you get live design counts. Otherwise give it a `careers` URL and it still
appears, just without counts. Re-run `npm run refresh`.

## Getting results into the tracker

Each run writes two files into `out/`:

- `jobs-<date>.json` — the import format
- `jobs-<date>.csv` — for Sheets or Excel

Open the tracker, tap **Paste a job**, paste the whole contents of the `.json` file, and tap
**Fill it in**. Every role is added at once, and anything already in your tracker at the same
company and title is skipped. They land in **To apply** with the match score and reasoning in
the notes.

## Running it on a schedule

Windows Task Scheduler, daily:

```
Program:   node
Arguments: src\index.js --days 1
Start in:  C:\Users\USER\Desktop\Vibecoding for money\Get@role\agent
```

## What it does, in order

1. Pulls every configured board in parallel; a board that fails is logged and skipped.
2. Drops anything older than `maxDaysOld`, using each board's own posted date.
3. Removes duplicates on company + title.
4. Applies the keyword and exclusion filters — free, before any tokens are spent.
5. Sends what survives to the model in batches of 15 for a 0–100 fit score and one line of
   reasoning.
6. Drops anything under `minMatchScore`, ranks by score, writes the files.
