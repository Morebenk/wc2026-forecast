# WC2026 Forecast — World Cup qualification engine

A live, **strength-free** forecast for any World Cup group stage. It reads the
tournament (teams, groups, fixtures, results) **live from the football-data.org
API** — nothing is hardcoded, so the same app works every edition — and answers,
for any team:

- **Is it mathematically through, out, or still alive?** Exact combinatorics over
  every remaining result, using the 2026 tiebreakers.
- **What does each of its own results do?** Win / Draw / Lose → real chance to
  reach the knockout (including the third-place route).
- **What does it need, and who else affects it?** The simplest result that seals a
  top-2 place, plus — when it can drop to 3rd — the specific *other groups'* games
  that move its survival in the best-thirds race.

No team is ever treated as "stronger": every unplayed match is simulated neutrally,
so the numbers reflect the standings and the schedule, not who's favoured.

## App tabs

- **Team** — advance gauge, mathematical status, win-group %, finishing spread,
  schedule/form, and a projected-points histogram.
- **Groups** — all 12 live tables + the third-place race with the qualifying cut line.
- **All teams** — sortable, filterable table of every team.
- **Scenarios** — the solver: a big "what you NEED", advance % for each own result,
  and the cross-group games that decide your fate if you finish 3rd.
- **Search** — ⌘/Ctrl-K command palette to jump to any team.

## Stack

- **Vite + TypeScript** single-page app (no framework).
- **Cloudflare Pages** hosting + a **Pages Function** (`functions/api/wc/matches.ts`)
  that proxies the API so the key never reaches the browser and there's no CORS.
- Local dev uses a Vite middleware that shares the exact same proxy code.

## Rate-limit safety net (built for public traffic)

The football-data.org key pool is shared by every visitor, so requests must never
reach the upstream API uncached:

1. **KV cache** (global) — the Function serves a cached payload; upstream is hit
   ~once per minute worldwide regardless of traffic.
2. **Edge Cache API** (per data-centre) fallback when KV isn't bound.
3. **Key pool** — multiple free keys round-robin with automatic failover on 429.
4. **Client throttle** — the Refresh button has a 10s cooldown.

So a user hammering "Refresh" cannot drain the quota for everyone.

## Run locally

```bash
npm install
cp .env.example .env        # paste your free key(s) — see below
npm run dev                 # http://localhost:5173
```

Without a key the app shows a setup screen.

### Free API key

1. Register at https://www.football-data.org/client/register — they email a token (free, no card).
2. Put it in `.env`: `FOOTBALL_DATA_API_KEY=your-token`
3. (Optional) pool extra free accounts to raise the rate limit:
   `FOOTBALL_DATA_API_KEY_2=…`, `FOOTBALL_DATA_API_KEY_3=…`

## Deploy to Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name wc2026-forecast
# secrets (once):
npx wrangler pages secret put FOOTBALL_DATA_API_KEY --project-name wc2026-forecast
# optional global cache:
npx wrangler kv namespace create WC_CACHE   # then add the id to wrangler.toml
```

Secrets live only as Cloudflare secrets / local `.env` — never in the repo.

## How the maths works

- **Status & scenarios** are exact: every combination of a group's remaining results
  is enumerated. Ties use head-to-head, then goal difference, then goals;
  goal-difference-edge cases stay "in contention". A verdict is never shown unless
  guaranteed.
- **Percentages** come from a Monte-Carlo of the whole tournament where every
  unplayed match draws goals from the same neutral Poisson distribution.
- **Cross-group dependency** (third place): the best third-placed teams advance via a
  12-way ranking on points *and* goal difference, so it can't be reduced to one
  clean "iff" condition. Instead the app measures, for each external game, how much
  each result shifts the team's survival — conditional on it finishing 3rd.

## Project layout

```
functions/api/wc/matches.ts   Cloudflare Pages Function (proxy + KV/edge cache)
src/server/fetchMatches.ts    Shared proxy logic (Function + Vite dev) + key pool
src/api/liveData.ts           API payload -> generic Tournament model
src/engine/sim.ts             Monte-Carlo, clinch/eliminate, scenario solver, sensitivity
src/engine/types.ts           Types
src/main.ts                   UI (tabs, search, render)
src/styles.css                Styles (responsive)
vite.config.ts                Dev middleware mirroring the Function
wrangler.toml                 Pages + KV binding
```
