import "./styles.css";
import { fetchTournament, type LiveMeta } from "./api/liveData";
import { Forecaster, analyzeTeam, nextMatchScenarios, sensitivity } from "./engine/sim";
import type { Forecast, Group, Sensitivity, Status, TeamAnalysis, Tournament } from "./engine/types";

const SENS_SIMS = 8000;

const CHUNK = 2500;
const REFRESH_MS = 60_000;
const REFRESH_COOLDOWN = 10_000;
const RING_C = 2 * Math.PI * 82;
type View = "team" | "groups" | "teams" | "scenarios";

interface State {
  tournament: Tournament | null;
  forecast: Forecast | null;
  meta: LiveMeta | null;
  selected: string | null;
  view: View;
  autoRefresh: boolean;
  animateGauge: boolean;
  sims: number;
  paletteOpen: boolean;
  q: string;
  qi: number;
  tableQuery: string;
  statusFilter: "all" | Status;
  sort: { key: string; dir: number };
  cooldownUntil: number;
  sens: Record<string, Sensitivity>; // cached per team, cleared on data change
}
const state: State = {
  tournament: null, forecast: null, meta: null, selected: null, view: "team",
  autoRefresh: false, animateGauge: false, sims: 20000,
  paletteOpen: false, q: "", qi: 0,
  tableQuery: "", statusFilter: "all", sort: { key: "adv", dir: -1 }, cooldownUntil: 0, sens: {},
};
let refreshTimer: number | undefined;
let prevAdv = 0;
let EFF: Tournament;

const app = document.getElementById("app")!;
const pct = (v: number) => (v * 100).toFixed(1) + "%";
const pct0 = (v: number) => Math.round(v * 100) + "%";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ordinal = (i: number) => ["1st", "2nd", "3rd", "4th", "5th", "6th"][i] ?? `${i + 1}th`;
const info = (tip: string) => `<button type="button" class="info" data-tip="${esc(tip)}" aria-label="${esc(tip)}">i</button>`;
const statusWord: Record<Status, string> = { clinched: "Qualified", alive: "In contention", eliminated: "Eliminated" };

function groupOf(name: string): Group { return EFF.groups.find((g) => g.teams.includes(name))!; }
function codeOf(name: string): string { return state.tournament?.codes[name] ?? ""; }

interface Row { name: string; pld: number; pts: number; gf: number; ga: number; gd: number; }
function standings(g: Group): Row[] {
  const r: Record<string, Row> = {};
  g.teams.forEach((n) => (r[n] = { name: n, pld: 0, pts: 0, gf: 0, ga: 0, gd: 0 }));
  for (const m of g.matches) {
    if (!m.played) continue;
    r[m.home].pld++; r[m.away].pld++;
    r[m.home].gf += m.hg; r[m.home].ga += m.ag; r[m.away].gf += m.ag; r[m.away].ga += m.hg;
    if (m.hg > m.ag) r[m.home].pts += 3; else if (m.hg < m.ag) r[m.away].pts += 3; else { r[m.home].pts++; r[m.away].pts++; }
  }
  g.teams.forEach((n) => (r[n].gd = r[n].gf - r[n].ga));
  return Object.values(r).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
}

// ---------- simulation ----------
function runSim(onDone: () => void): void {
  const fc = new Forecaster(state.tournament!);
  const bar = document.getElementById("simbar");
  const step = () => {
    fc.runChunk(Math.min(CHUNK, state.sims - fc.completed));
    if (bar) bar.style.width = `${(100 * fc.completed) / state.sims}%`;
    if (fc.completed < state.sims) requestAnimationFrame(step);
    else { state.forecast = fc.finalize(); onDone(); }
  };
  requestAnimationFrame(step);
}

// ---------- load / refresh ----------
async function load(silent = false): Promise<void> {
  if (!silent) app.innerHTML = loadingHtml();
  const res = await fetchTournament();
  if (!res.ok) {
    app.innerHTML = res.reason === "no-key" ? setupHtml() : errorHtml(res.reason);
    return;
  }
  state.tournament = res.tournament;
  state.meta = res.meta;
  // Never auto-pick a team — the landing prompts the user to choose.
  if (state.selected && !res.tournament.groups.some((g) => g.teams.includes(state.selected!))) {
    state.selected = null;
  }
  state.animateGauge = state.view === "team" && !!state.selected;
  state.sens = {};
  prevAdv = 0;
  runSim(paint);
}
function resim(): void { state.sens = {}; runSim(paint); }
function requestRefresh(): void {
  if (Date.now() < state.cooldownUntil) return;
  state.cooldownUntil = Date.now() + REFRESH_COOLDOWN;
  load(true);
  const sel = () => document.querySelector<HTMLButtonElement>('[data-action="refresh"]');
  const b = sel(); if (b) b.disabled = true;
  window.setTimeout(() => { const x = sel(); if (x) x.disabled = false; }, REFRESH_COOLDOWN);
}
function selectTeam(name: string): void { state.selected = name; if (state.view === "teams" || state.view === "groups") state.view = "team"; state.animateGauge = false; state.paletteOpen = false; paint(); }
function setView(v: View): void { state.view = v; state.animateGauge = false; paint(); }

// ---------- paint ----------
function paint(): void {
  EFF = state.tournament!;
  app.innerHTML = appHtml();
  if (state.view === "team") animateGauge();
  const cb = document.getElementById("autorefresh") as HTMLInputElement | null;
  if (cb) cb.checked = state.autoRefresh;
  if (state.paletteOpen) caretEnd("paletteInput", state.q);
}
function caretEnd(id: string, val: string): void {
  const inp = document.getElementById(id) as HTMLInputElement | null;
  if (inp) { inp.value = val; inp.focus(); inp.setSelectionRange(val.length, val.length); }
}
function animateGauge(): void {
  const ring = document.getElementById("ring");
  const num = document.getElementById("advNum");
  if (!ring || !num || !state.forecast || !state.selected) return;
  const target = state.forecast.adv[state.selected];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!state.animateGauge || reduce) {
    ring.setAttribute("stroke-dashoffset", String(RING_C * (1 - target)));
    num.textContent = pct(target); prevAdv = target; return;
  }
  const from = prevAdv, t0 = performance.now(), dur = 750;
  const frame = (now: number) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3), cur = from + (target - from) * e;
    ring.setAttribute("stroke-dashoffset", String(RING_C * (1 - cur)));
    num.textContent = pct(cur);
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame); prevAdv = target;
}

// ---------- screens ----------
function loadingHtml(): string {
  return `<div class="screen"><div class="k">World Cup Forecast</div><h2><span class="spinner"></span> Loading live tournament…</h2><p>Fetching groups, fixtures and results.</p></div>`;
}
function setupHtml(): string {
  return `<div class="screen"><div class="k">One-time setup</div><h2>Add your free API key</h2>
    <p>Reads the tournament live from <a href="https://www.football-data.org" target="_blank" rel="noopener">football-data.org</a> — free, no card.</p>
    <ol><li>Register at <a href="https://www.football-data.org/client/register" target="_blank" rel="noopener">football-data.org/client/register</a>.</li>
    <li><b>Local:</b> copy <code>.env.example</code> → <code>.env</code>, set <code>FOOTBALL_DATA_API_KEY</code>, restart <code>npm run dev</code>.</li>
    <li><b>Cloudflare:</b> <code>wrangler pages secret put FOOTBALL_DATA_API_KEY</code>.</li></ol>
    <p><button class="btn primary" data-action="reload">↻ Reload</button></p></div>`;
}
function errorHtml(reason: string): string {
  return `<div class="screen"><div class="k">Couldn't load live data</div><h2>Live feed unavailable</h2>
    <p>API said: <code>${esc(reason)}</code> — usually a transient rate limit. Retry in a moment.</p>
    <p><button class="btn primary" data-action="reload">↻ Retry</button></p></div>`;
}

// ---------- shell ----------
function appHtml(): string {
  return `<div class="wrap">${headerHtml()}${bannerHtml()}${viewHtml()}${methodHtml()}</div>${state.paletteOpen ? paletteHtml() : ""}`;
}
function headerHtml(): string {
  const t = state.tournament!;
  const tab = (v: View, label: string) => `<button class="tab${state.view === v ? " on" : ""}" data-view="${v}">${label}</button>`;
  return `<div class="topbar">
    <div class="brand"><div class="k">${esc(t.edition)}</div><h1>Qualification Forecast</h1></div>
    <div class="controls">
      <button class="search" data-action="palette"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>Search teams<kbd>⌘K</kbd></button>
      <select class="mini" id="simSel" aria-label="Simulations">${[5000, 20000, 100000].map((n) => `<option value="${n}"${state.sims === n ? " selected" : ""}>${n / 1000}k sims</option>`).join("")}</select>
      <button class="btn primary" data-action="refresh"${Date.now() < state.cooldownUntil ? " disabled" : ""}><span class="bar" id="simbar"></span>↻ Refresh</button>
      <label class="toggle"><input type="checkbox" id="autorefresh" data-action="autorefresh" /> Auto</label>
    </div>
  </div>
  <nav class="tabs">${tab("team", "Team")}${tab("groups", "Groups")}${tab("teams", "All teams")}${tab("scenarios", "Scenarios")}</nav>`;
}
function bannerHtml(): string {
  const m = state.meta!;
  const ago = m.fetchedAt ? timeAgo(m.fetchedAt) : "now";
  return `<div class="banner">
    <span class="pill live"><span class="dot"></span>Live · football-data.org</span>
    <span class="pill">Updated ${esc(ago)}</span>
    <span class="pill">${m.matchesPlayed}/${m.matchesTotal} played</span>
  </div>`;
}
function viewHtml(): string {
  switch (state.view) {
    case "team": return teamView();
    case "groups": return groupsView();
    case "teams": return allTeamsView();
    case "scenarios": return scenariosView();
  }
}

// ---------- choose-team landing ----------
function chooseTeamHtml(): string {
  const grid = EFF.groups.map((g) =>
    `<div class="choosegrp"><div class="cg">Group ${esc(g.name)}</div>${standings(g).map((r) => `<button class="teamchip" data-team="${esc(r.name)}"><span class="code">${esc(codeOf(r.name))}</span>${esc(r.name)}</button>`).join("")}</div>`,
  ).join("");
  return `<section class="choose">
    <div class="k">Start here</div>
    <h2>Pick a team</h2>
    <p class="muted">Tap any team below, or <button class="linkbtn" data-action="palette">search ⌘K</button>.</p>
    <div class="choosegrid">${grid}</div>
  </section>`;
}

// ---------- team deep-dive ----------
function teamView(): string {
  if (!state.selected) return chooseTeamHtml();
  const f = state.forecast!, sel = state.selected!, g = groupOf(sel);
  const status = f.status[sel], pos = f.pos[sel];
  const best = pos.indexOf(Math.max(...pos));
  const scenarios = nextMatchScenarios(EFF, g, sel);
  const finishBar = pos.map((v, i) => {
    const col = ["var(--gold)", "var(--teal)", "#5C6CA8", "#2A375F"][i] ?? "#2A375F";
    return `<span style="flex-grow:${Math.max(v, 0.0001)};background:${col};color:${i >= 2 ? "var(--text)" : "#0E1630"}">${v >= 0.07 ? pct0(v) : ""}</span>`;
  }).join("");
  const legend = pos.map((_, i) => `<span><i style="background:${["var(--gold)", "var(--teal)", "#5C6CA8", "#2A375F"][i] ?? "#2A375F"}"></i>${ordinal(i)}</span>`).join("");
  const scen = scenarios
    ? `<div class="cap">Next match — what each result means</div>${scenarios.map((s) => `<div class="scrow"><span class="res">${s.label}</span><span class="nm">vs ${esc(codeOf(s.opponent) || s.opponent)}</span><span class="arrow">→</span><span class="tag ${s.status}">${statusWord[s.status]}</span></div>`).join("")}`
    : `<div class="cap">All group matches played — fate now rests on other groups.</div>`;
  return `<section class="hero">
    <div class="gauge">
      <svg width="190" height="190" viewBox="0 0 190 190">
        <circle cx="95" cy="95" r="82" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="16"/>
        <circle id="ring" cx="95" cy="95" r="82" fill="none" stroke="var(--gold)" stroke-width="16" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/>
      </svg>
      <div class="val"><b id="advNum">—</b><span>chance to advance ${info("Probability of reaching the knockout — finishing in the top " + EFF.advancePerGroup + (EFF.bestThirds > 0 ? `, or as one of the ${EFF.bestThirds} best third-placed teams` : "") + ". From " + state.sims.toLocaleString() + " neutral simulations.")}</span></div>
    </div>
    <div class="heromain">
      <div class="grouptag">Group ${esc(g.name)} · ${esc(codeOf(sel))}</div>
      <h2>${esc(sel)}</h2>
      <span class="statusbadge st-${status}"><span class="ic"></span>${statusWord[status]}${info("Mathematical status from the games still to play. Qualified = a knockout place is already secured; Eliminated = can no longer reach the knockout; In contention = still possible.")}</span>
      <div class="statrow">
        <div class="stat"><div class="lab">Win group ${info("Chance of finishing 1st in the group.")}</div><div class="num gold">${pct(f.win[sel])}</div></div>
        <div class="stat"><div class="lab">Most likely ${info("The single most probable final position, and how often it happens in the model.")}</div><div class="num teal" style="font-size:18px">${ordinal(best)} · ${pct0(pos[best])}</div></div>
        ${EFF.bestThirds > 0 ? `<div class="stat"><div class="lab">Advance as 3rd ${info(`Chance of finishing 3rd AND being one of the ${EFF.bestThirds} best third-placed teams that go through.`)}</div><div class="num" style="font-size:18px">${pct(f.thirdAdv[sel])}</div></div>` : ""}
      </div>
      <div class="finish"><div class="cap">Finishing position ${info("How likely the team is to finish in each spot, 1st through last.")}</div><div class="fbar">${finishBar}</div><div class="flegend">${legend}</div></div>
      <div class="scenarios">${scen}</div>
    </div>
  </section>
  <div class="cols2">
    <div class="card"><h4>Schedule &amp; form</h4>${scheduleHtml(sel, g)}</div>
    <div class="card"><h4>Projected final points</h4>${histogramHtml(sel, g)}</div>
  </div>`;
}
function scheduleHtml(team: string, g: Group): string {
  let pts = 0;
  const rows = g.matches.filter((m) => m.home === team || m.away === team).map((m) => {
    const home = m.home === team, opp = home ? m.away : m.home;
    if (!m.played) return `<div class="schrow up"><span class="when">—</span><span class="opp">${home ? "vs" : "@"} ${esc(opp)}</span><span class="sc">scheduled</span></div>`;
    const gf = home ? m.hg : m.ag, ga = home ? m.ag : m.hg;
    const r = gf > ga ? "W" : gf < ga ? "L" : "D";
    pts += r === "W" ? 3 : r === "D" ? 1 : 0;
    return `<div class="schrow"><span class="form ${r}">${r}</span><span class="opp">${home ? "vs" : "@"} ${esc(opp)}</span><span class="sc">${gf}–${ga}</span><span class="pp">${pts} pts</span></div>`;
  }).join("");
  return rows || `<p class="muted">No fixtures.</p>`;
}
function histogramHtml(team: string, g: Group): string {
  const dist = state.forecast!.pointsDist[team];
  const cur = standings(g).find((r) => r.name === team)!;
  const exp = dist.reduce((s, p, i) => s + i * p, 0);
  const max = Math.max(...dist, 0.001);
  const bars = dist.map((p, i) => `<div class="hbar" title="${i} pts: ${pct(p)}"><div class="hfill" style="height:${Math.max(2, (p / max) * 100)}%;${p < 0.005 ? "opacity:.25" : ""}"></div><span class="hx">${i}</span></div>`).join("");
  return `<div class="hist">${bars}</div><div class="histfoot"><span>Expected <b>${exp.toFixed(2)}</b> pts</span><span>Now on <b>${cur.pts}</b></span></div>`;
}

// ---------- groups ----------
function groupsView(): string {
  return `<div class="ggrid">${EFF.groups.map(groupCardBig).join("")}</div>${EFF.bestThirds > 0 ? raceHtml() : ""}`;
}
function groupCardBig(g: Group): string {
  const f = state.forecast!;
  const rows = standings(g);
  const pldCount = g.matches.filter((m) => m.played).length;
  const body = rows.map((r, i) => {
    const st = f.status[r.name], adv = f.adv[r.name];
    return `<tr class="${r.name === state.selected ? "me" : ""}" data-team="${esc(r.name)}">
      <td class="l">${i + 1}</td><td class="l"><span class="sdot ${st}"></span>${esc(r.name)}</td>
      <td>${r.pld}</td><td>${r.pts}</td><td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
      <td class="advcell">${pct0(adv)}<span class="advbar"><i style="width:${adv * 100}%"></i></span></td></tr>`;
  }).join("");
  return `<div class="card gbig">
    <div class="gbighead"><b>Group ${esc(g.name)}</b><span>${pldCount}/${g.matches.length} played</span></div>
    <table class="tbl"><thead><tr><th class="l">#</th><th class="l">Team</th><th>Pld</th><th>Pts</th><th>GD</th><th class="advcell">Adv</th></tr></thead><tbody>${body}</tbody></table>
  </div>`;
}
function raceHtml(): string {
  const f = state.forecast!, t = EFF;
  const reps = t.groups.map((g) => {
    let best = { name: "", v: -1, third: 0 };
    for (const n of g.teams) { const v = f.thirdAdv[n]; if (v > best.v) best = { name: n, v, third: f.pos[n][t.advancePerGroup] ?? 0 }; }
    return { group: g.name, ...best };
  }).sort((a, b) => b.v - a.v);
  const maxv = Math.max(...reps.map((r) => r.v), 0.001);
  let rows = "";
  reps.forEach((r, k) => {
    if (k === t.bestThirds) rows += `<div class="cutline"><span>Qualifying cut · top ${t.bestThirds}</span><span class="ln"></span></div>`;
    const col = k < t.bestThirds ? "var(--teal)" : "#4A5784";
    rows += `<div class="rrow" data-team="${esc(r.name)}"><div class="rk">${k + 1}</div><div class="rn"><b>${esc(r.name)}</b></div>
      <div><div class="rn"><span>Grp ${esc(r.group)} · ${pct0(r.third)} to finish 3rd</span></div><div class="rtrack"><i style="width:${(r.v / maxv) * 100}%;background:${col}"></i></div></div>
      <div class="rp" style="color:${k < t.bestThirds ? "var(--teal)" : "var(--muted)"}">${pct(r.v)}</div></div>`;
  });
  return `<section class="sec"><div class="sechead"><h3>Third-place race ${info(`Each group's most likely 3rd-place team, ranked by their chance of being in the best ${t.bestThirds} third-placed teams (who advance). The line marks the cut-off.`)}</h3><span class="note">Best ${t.bestThirds} of ${t.groups.length} third-placed teams advance</span></div><div class="race">${rows}</div></section>`;
}

// ---------- all teams ----------
interface TRow { name: string; group: string; pld: number; pts: number; gd: number; status: Status; adv: number; win: number; p1: number; third: number; }
function allRows(): TRow[] {
  const f = state.forecast!;
  const out: TRow[] = [];
  for (const g of EFF.groups) for (const r of standings(g)) out.push({ name: r.name, group: g.name, pld: r.pld, pts: r.pts, gd: r.gd, status: f.status[r.name], adv: f.adv[r.name], win: f.win[r.name], p1: f.pos[r.name][0], third: f.thirdAdv[r.name] });
  return out;
}
function allTeamsView(): string {
  const q = state.tableQuery.toLowerCase();
  let rows = allRows().filter((r) => (state.statusFilter === "all" || r.status === state.statusFilter) && (q === "" || r.name.toLowerCase().includes(q) || codeOf(r.name).toLowerCase().includes(q)));
  const k = state.sort.key, dir = state.sort.dir;
  const val = (r: TRow): number | string => (k === "name" ? r.name : k === "group" ? r.group : (r as unknown as Record<string, number>)[k]);
  rows = rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === "string" ? String(x).localeCompare(String(y)) : (x as number) - (y as number)) * dir; });
  const counts = allRows().reduce((m, r) => { m[r.status]++; return m; }, { clinched: 0, alive: 0, eliminated: 0 } as Record<Status, number>);
  const chip = (key: "all" | Status, label: string) => `<button class="chip${state.statusFilter === key ? " on" : ""}" data-filter="${key}">${label}</button>`;
  const th = (key: string, label: string, l = false, tip = "") => `<th class="${l ? "l " : ""}sortable${state.sort.key === key ? " sorted" : ""}" data-sort="${key}">${label}${tip ? " " + info(tip) : ""}${state.sort.key === key ? (dir < 0 ? " ▾" : " ▴") : ""}</th>`;
  return `<div class="filters">
      <input class="filterbox" id="tableQuery" placeholder="Filter teams…" value="${esc(state.tableQuery)}" />
      <div class="chips">${chip("all", "All 48")}${chip("clinched", `Qualified ${counts.clinched}`)}${chip("alive", `In contention ${counts.alive}`)}${chip("eliminated", `Out ${counts.eliminated}`)}</div>
    </div>
    <div class="card"><div class="tblwrap"><table class="tbl big"><thead><tr>
      ${th("name", "Team", true)}${th("group", "Grp")}${th("pld", "Pld")}${th("pts", "Pts")}${th("gd", "GD")}${th("adv", "Adv%", false, "Chance of reaching the knockout.")}${th("win", "Win%", false, "Chance of finishing 1st in the group.")}${th("p1", "1st%", false, "Chance of finishing 1st (same as Win%).")}${th("third", "3rd→adv", false, "Chance of advancing as one of the best third-placed teams.")}
    </tr></thead><tbody>${rows.map((r) => `<tr data-team="${esc(r.name)}">
      <td class="l"><span class="sdot ${r.status}"></span><span class="code">${esc(codeOf(r.name))}</span> ${esc(r.name)}</td>
      <td>${esc(r.group)}</td><td>${r.pld}</td><td>${r.pts}</td><td>${r.gd > 0 ? "+" : ""}${r.gd}</td>
      <td class="advcell">${pct0(r.adv)}<span class="advbar"><i style="width:${r.adv * 100}%"></i></span></td>
      <td style="color:var(--gold)">${pct0(r.win)}</td><td>${pct0(r.p1)}</td><td>${EFF.bestThirds > 0 ? pct0(r.third) : "—"}</td>
    </tr>`).join("")}</tbody></table></div></div>`;
}

// ---------- scenarios (the solver) — visual, low-text ----------
interface Need { big: string; sub: string; cls: "ok" | "maybe" | "no"; }
function computeNeed(a: TeamAnalysis, status: Status, adv: number): Need {
  if (status === "clinched") return { big: "THROUGH", sub: "already qualified", cls: "ok" };
  if (status === "eliminated") return { big: "OUT", sub: "eliminated", cls: "no" };
  const gp = a.top2.guaranteePts;
  if (gp === null) return { big: a.top2.possiblePts === null ? "OUT" : "NEED HELP", sub: a.top2.possiblePts === null ? `can't reach top ${adv}` : "can't seal it alone", cls: a.top2.possiblePts === null ? "no" : "maybe" };
  if (a.ownRemaining === 1) return { big: gp <= 1 ? "DRAW" : "WIN", sub: `to seal top ${adv}`, cls: "ok" };
  return { big: `${gp} PTS`, sub: `from ${a.ownRemaining} games to seal top ${adv}`, cls: "ok" };
}
function scenariosView(): string {
  if (!state.selected) return chooseTeamHtml();
  const f = state.forecast!, sel = state.selected, g = groupOf(sel);
  const a = analyzeTeam(EFF, g, sel);
  const status = f.status[sel], adv = EFF.advancePerGroup;
  const need = computeNeed(a, status, adv);

  const stat = (lab: string, val: string, tip: string, cls = "") => `<div class="sstat"><div class="lab">${lab} ${info(tip)}</div><div class="num ${cls}">${val}</div></div>`;
  const stats = `<div class="sstats">
    ${stat("Advance", pct0(f.adv[sel]), "Overall chance of reaching the knockout (top " + adv + (EFF.bestThirds > 0 ? " or best-third" : "") + ").", need.cls === "no" ? "" : "teal")}
    ${stat("Win group", pct0(f.win[sel]), "Chance of finishing 1st in the group.", "gold")}
    ${EFF.bestThirds > 0 ? stat("As 3rd", pct0(f.thirdAdv[sel]), `Chance of finishing 3rd and surviving the best-${EFF.bestThirds} third-place cut.`) : ""}
    ${stat("Points", String(a.curPoints), "Points won so far, from games already played.")}
  </div>`;

  // cross-group sensitivity (cached per team) — also gives own-match advance %
  if (!state.sens[sel]) state.sens[sel] = sensitivity(EFF, sel, SENS_SIMS);
  const sens = state.sens[sel];

  // own next match: advance % per Win / Draw / Lose
  let outcomes = "";
  if (sens.ownNext && sens.ownNextMatch) {
    const opp = codeOf(sens.ownNextMatch.opponent) || sens.ownNextMatch.opponent;
    const cards = sens.ownNext.map((r) => {
      const top2 = a.nextResults?.find((x) => x.result === r.result)?.top2;
      const clsCard = top2 === "guaranteed" ? "ok" : r.pAdvance >= 0.6 ? "ok" : r.pAdvance >= 0.3 ? "maybe" : "no";
      const sub = top2 === "guaranteed" ? `seals top ${adv}` : r.pAdvance <= 0.02 ? "out" : EFF.bestThirds > 0 ? "via 3rd place" : "";
      return `<div class="ocard ${clsCard}"><div class="ores">${r.result.toUpperCase()}</div><div class="ochip">${pct0(r.pAdvance)}</div>${sub ? `<div class="ocond">${sub}</div>` : ""}</div>`;
    }).join("");
    outcomes = `<div class="ocards-h">If ${esc(sel)} ${a.ownRemaining === 1 ? "in its last game" : "in its next game"} (${sens.ownNextMatch.isHome ? "vs" : "@"} ${esc(opp)}) ${info("Your chance to reach the knockout for each result of your own match — already counting the third-place route.")}</div>
      <p class="muted impactnote">chance to advance:</p>
      <div class="ocards">${cards}</div>`;
  } else {
    outcomes = `<div class="ocards-h">Group complete ${info("All your games are played; advancing now depends only on other groups' results.")}</div>
      <div class="ocards"><div class="ocard ${need.cls}"><div class="ores">ADVANCE</div><div class="ochip">${pct0(f.adv[sel])}</div><div class="ocond">depends on other groups</div></div></div>`;
  }

  // matches elsewhere — only relevant if the team drops to 3rd place
  let elsewhere = "";
  if (status === "alive" && a.top2.guaranteePts !== 0 && sens.thirdShare >= 0.03) {
    const intro = `<p class="muted impactnote">If ${esc(sel)} drops to 3rd place (about ${pct0(sens.thirdShare)} of the time — e.g. by losing above), it joins the best-${EFF.bestThirds} third-place race, where it survives ≈${pct0(sens.thirdAdvance)}. These other games push that up or down (green = helps you most):</p>`;
    elsewhere = sens.matches.length > 0
      ? `<div class="ocards-h">If ${esc(sel)} finishes 3rd — games that decide the cut ${info("These only matter if you don't finish top " + adv + ". They're other groups' games whose results raise or lower your chance of being one of the best third-placed teams.")}</div>
         ${intro}
         <div class="impacts">${sens.matches.map(impactRow).join("")}</div>`
      : `<div class="ocards-h">If ${esc(sel)} finishes 3rd</div>${intro.replace(" These other games push that up or down (green = helps you most):", " No single other game changes it much.")}`;
  }

  return `<div class="scenhead">
      <div class="grouptag">Group ${esc(g.name)} · ${esc(codeOf(sel))}</div>
      <h2>${esc(sel)}</h2>
    </div>
    <div class="needbig ${need.cls}"><div class="needlbl">${a.ownRemaining > 0 && status === "alive" ? "To seal top " + adv : "Status"} ${info(`The simplest own result that guarantees a top-${adv} place no matter what else happens. (You may still advance as a 3rd-placed team — see below.)`)}</div><div class="needbigval">${need.big}</div><div class="needbigsub">${need.sub}</div></div>
    ${stats}
    ${outcomes}
    ${elsewhere}`;
}
function impactRow(m: Sensitivity["matches"][number]): string {
  const best = Math.max(...m.rows.map((r) => r.pAdvance));
  const worst = Math.min(...m.rows.map((r) => r.pAdvance));
  const lbl = (o: number) => (o === 1 ? "Draw" : o === 0 ? `${codeOf(m.home) || m.home} win` : `${codeOf(m.away) || m.away} win`);
  const chips = m.rows.map((r) => `<span class="ichip ${r.pAdvance === best ? "best" : r.pAdvance === worst ? "worst" : ""}">${esc(lbl(r.outcome))} <b>${pct0(r.pAdvance)}</b></span>`).join("");
  return `<div class="impact"><div class="imatch"><span class="igrp">Grp ${esc(m.group)}</span> ${esc(codeOf(m.home) || m.home)} <span class="iv">v</span> ${esc(codeOf(m.away) || m.away)}</div><div class="ichips">${chips}</div></div>`;
}

// ---------- palette ----------
function paletteHtml(): string {
  const list = paletteList();
  if (state.qi >= list.length) state.qi = Math.max(0, list.length - 1);
  return `<div class="palette" data-action="palette-bg"><div class="palbox">
    <input id="paletteInput" class="palinput" placeholder="Search any team…" autocomplete="off" />
    <div class="pallist">${list.length ? list.map((t, i) => `<div class="palrow${i === state.qi ? " on" : ""}" data-team="${esc(t.n)}"><span class="code">${esc(codeOf(t.n))}</span><span class="nm">${esc(t.n)}</span><span class="grp">Group ${esc(t.g)}</span></div>`).join("") : `<div class="palempty">No match</div>`}</div>
    <div class="palhint"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close</div>
  </div></div>`;
}
function paletteList(): Array<{ n: string; g: string }> {
  const q = state.q.toLowerCase();
  return EFF.groups.flatMap((g) => g.teams.map((n) => ({ n, g: g.name }))).filter((t) => q === "" || t.n.toLowerCase().includes(q) || codeOf(t.n).toLowerCase().includes(q)).slice(0, 8);
}

// ---------- methodology ----------
function methodHtml(): string {
  const t = EFF;
  return `<div class="method">
    <b>Strength-free.</b> Teams, groups, fixtures and results are live from football-data.org — nothing hardcoded.
    <b>Scenarios &amp; status</b> are exact: every combination of the remaining group results is enumerated (2026 tiebreakers; goal-difference-edge cases are flagged), so a "guaranteed"/"eliminated" verdict is never shown unless mathematically certain.
    <b>Percentages</b> are ${state.sims.toLocaleString()} Monte-Carlo runs where every unplayed match is neutral — no favourites. ${t.advancePerGroup * t.groups.length + t.bestThirds} advance: top ${t.advancePerGroup} per group${t.bestThirds > 0 ? ` + ${t.bestThirds} best thirds` : ""}.
  </div>`;
}
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---------- events ----------
document.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el.id === "autorefresh") {
    state.autoRefresh = (el as HTMLInputElement).checked;
    if (state.autoRefresh) refreshTimer = window.setInterval(() => load(true), REFRESH_MS);
    else if (refreshTimer) clearInterval(refreshTimer);
  } else if (el.id === "simSel") { state.sims = Number((el as HTMLSelectElement).value); resim(); }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if (el.id === "tableQuery") { state.tableQuery = (el as HTMLInputElement).value; paint(); caretEnd("tableQuery", state.tableQuery); }
  else if (el.id === "paletteInput") { state.q = (el as HTMLInputElement).value; state.qi = 0; paint(); }
});
document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.closest(".info")) return; // info tooltips: focus only, no action
  const a = el.closest("[data-action],[data-view],[data-team],[data-sort],[data-filter]") as HTMLElement | null;
  if (!a) return;
  const action = a.dataset.action;
  if (action === "reload") load(false);
  else if (action === "refresh") requestRefresh();
  else if (action === "palette") { state.paletteOpen = true; state.q = ""; state.qi = 0; paint(); }
  else if (action === "palette-bg" && a === el) { state.paletteOpen = false; paint(); }
  else if (a.dataset.view) setView(a.dataset.view as View);
  else if (a.dataset.team) selectTeam(a.dataset.team);
  else if (a.dataset.filter) { state.statusFilter = a.dataset.filter as State["statusFilter"]; paint(); }
  else if (a.dataset.sort) {
    const key = a.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: key === "name" || key === "group" ? 1 : -1 };
    paint();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); state.paletteOpen = !state.paletteOpen; state.q = ""; state.qi = 0; paint(); return; }
  if (!state.paletteOpen) return;
  const list = paletteList();
  if (e.key === "Escape") { state.paletteOpen = false; paint(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); state.qi = Math.min(list.length - 1, state.qi + 1); paint(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); state.qi = Math.max(0, state.qi - 1); paint(); }
  else if (e.key === "Enter") { const t = list[state.qi]; if (t) selectTeam(t.n); }
});

load(false);
