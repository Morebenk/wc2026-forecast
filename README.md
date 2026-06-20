<div align="center">

# ⚽ WC2026 Forecast

### Live, **strength-free** qualification maths for the FIFA World Cup group stage

Will your team go through? What exactly do they need? Which *other* games decide their fate?
This answers all three — from the live scores, with no opinion about who's "better".

<br/>

[![Live demo](https://img.shields.io/badge/▶_LIVE_DEMO-wc2026--forecast.pages.dev-34D6C6?style=for-the-badge&labelColor=0E1630)](https://wc2026-forecast.pages.dev)

<br/>

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-F38020?style=flat-square&logo=cloudflarepages&logoColor=white)
![No framework](https://img.shields.io/badge/no_framework-vanilla_TS-F4B73D?style=flat-square&labelColor=0E1630)
![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

---

> **The idea.** Most predictors rank teams by some power rating, then tell you a favourite.
> This one does the opposite: it treats every remaining match as a coin-flip and works out,
> purely from the **standings and the schedule**, what is *mathematically certain*, what is
> *still possible*, and *how likely* each outcome is. The result is honest probabilities and
> exact "what you need" scenarios — for **any** World Cup, because nothing is hardcoded.

## ✨ Highlights

- 🔴 **100% live** — teams, groups, fixtures and results stream from the football-data.org API. No data is baked in, so the same app works every tournament (it even auto-detects the format).
- 🧮 **Exact scenario solver** — every combination of a group's remaining games is enumerated with the official 2026 tiebreakers. "Qualified" / "Eliminated" is only ever shown when it's *mathematically guaranteed*.
- 🎲 **Honest, strength-free odds** — 20,000 neutral Monte-Carlo tournaments. No team is favoured; the numbers reflect structure, not reputation.
- 🌍 **Cross-group dependencies** — when a team can finish 3rd, it shows the specific *other groups'* games that move its survival in the best-thirds race, with real numbers.
- 🔎 **⌘K command palette**, deep-dive per team, sortable all-teams table, and a third-place race with the qualifying cut line.
- 📱 **Responsive** and fast (~35 kB JS, no framework).

## 🧭 Tabs

| Tab | What it shows |
| --- | --- |
| **Team** | Advance gauge, mathematical status, win-group %, finishing spread, schedule & form, projected-points histogram |
| **Groups** | All live group tables + the third-place race and its cut line |
| **All teams** | Sortable, filterable table of every team |
| **Scenarios** | The solver: what you **need**, your advance % for Win / Draw / Lose, and the outside games that decide it if you finish 3rd |

## 🛠 Tech stack

- **Vite + TypeScript** single-page app — no framework, no runtime dependencies.
- **Cloudflare Pages** static hosting + a **Pages Function** proxy (`/api/wc/matches`) so the API key never reaches the browser and there's no CORS.
- The dev server mirrors the exact same proxy code via a Vite middleware.

## 🛡 Built for public traffic

The free API key pool is shared by every visitor, so upstream is protected by four layers:

1. **KV cache** (global) — the API is hit ~once/minute worldwide, no matter the traffic.
2. **Edge Cache API** (per data-centre) fallback.
3. **Key pool** — multiple free keys, round-robin with automatic failover on rate-limit.
4. **Client throttle** — a 10-second cooldown on manual refresh.

## 🚀 Run locally

```bash
npm install
cp .env.example .env        # paste your free key — see below
npm run dev                 # → http://localhost:5173
```

**Free API key:** register at [football-data.org](https://www.football-data.org/client/register) (free, no card), then set `FOOTBALL_DATA_API_KEY` in `.env`. Optionally pool more accounts with `FOOTBALL_DATA_API_KEY_2`, `_3` to raise the rate limit. Without a key the app shows a friendly setup screen.

## ☁️ Deploy to Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist --project-name wc2026-forecast
npx wrangler pages secret put FOOTBALL_DATA_API_KEY --project-name wc2026-forecast
npx wrangler kv namespace create WC_CACHE   # optional global cache → add id to wrangler.toml
```

Secrets live only as Cloudflare secrets / a local `.env` — never in the repo.

## 🧮 How the maths works

- **Status & scenarios** are exact combinatorics over remaining results. Ties resolve by head-to-head → goal difference → goals; goal-difference-edge cases stay "in contention" so a verdict is never wrong.
- **Percentages** are Monte-Carlo: every unplayed match draws goals from the same neutral Poisson distribution, then standings and the best-thirds cut are applied.
- **Third-place dependency:** the best third-placed teams advance via a 12-way ranking on points *and* goal difference — which can't be reduced to one clean "iff" condition — so the app measures how much each external result shifts your survival, conditional on finishing 3rd.

## 🗂 Project structure

```
functions/api/wc/matches.ts   Cloudflare Pages Function (proxy + KV/edge cache)
src/server/fetchMatches.ts    Shared proxy logic + key pool (Function + dev)
src/api/liveData.ts           API payload → generic Tournament model
src/engine/sim.ts             Monte-Carlo · clinch/eliminate · scenario solver · sensitivity
src/engine/types.ts           Types
src/main.ts                   UI — tabs, search, rendering
src/styles.css                Responsive styles
vite.config.ts                Dev middleware mirroring the Function
wrangler.toml                 Pages + KV binding
```

## 📄 License

[MIT](LICENSE) © Morebenk

<div align="center"><sub>Built with Claude Code · data from football-data.org</sub></div>
