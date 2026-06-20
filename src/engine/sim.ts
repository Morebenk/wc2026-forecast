import type { Forecast, Group, Guarantee, MatchImpact, NextResultLine, SampleResult, SampleRow, Sensitivity, Status, TeamAnalysis, Tournament } from "./types";

// No team strength. Every unplayed match is neutral: both teams draw goals from
// the same Poisson mean, so probabilities reflect the standings and who-plays-whom,
// not who is "better". Mean 1.3 gives a realistic ~26% draw rate and the goal
// spread that the third-place tiebreakers need.
const LAMBDA = 1.3;

function poisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

interface Stat {
  pts: number;
  gf: number;
  ga: number;
  gd: number;
}
interface ResolvedMatch {
  home: string;
  away: string;
  hg: number;
  ag: number;
}

function emptyStat(): Stat {
  return { pts: 0, gf: 0, ga: 0, gd: 0 };
}

function applyScore(st: Record<string, Stat>, m: ResolvedMatch): void {
  st[m.home].gf += m.hg; st[m.home].ga += m.ag;
  st[m.away].gf += m.ag; st[m.away].ga += m.hg;
  if (m.hg > m.ag) st[m.home].pts += 3;
  else if (m.hg < m.ag) st[m.away].pts += 3;
  else { st[m.home].pts++; st[m.away].pts++; }
}

// Tiebreakers: head-to-head pts -> h2h GD -> h2h goals -> overall GD ->
// overall goals -> drawing of lots (random, no strength). 3-way ties re-apply
// the head-to-head steps among the still-level teams.
function resolveCluster(cluster: string[], ms: ResolvedMatch[], st: Record<string, Stat>): string[] {
  if (cluster.length === 1) return cluster;
  const set = new Set(cluster);
  const h: Record<string, Stat> = {};
  cluster.forEach((n) => (h[n] = emptyStat()));
  for (const m of ms) {
    if (set.has(m.home) && set.has(m.away)) applyScore(h, m);
  }
  cluster.forEach((n) => (h[n].gd = h[n].gf - h[n].ga));
  const sorted = cluster.slice().sort((x, y) => h[y].pts - h[x].pts || h[y].gd - h[x].gd || h[y].gf - h[x].gf);

  const subs: string[][] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (
      j < sorted.length &&
      h[sorted[j]].pts === h[sorted[i]].pts &&
      h[sorted[j]].gd === h[sorted[i]].gd &&
      h[sorted[j]].gf === h[sorted[i]].gf
    ) j++;
    subs.push(sorted.slice(i, j));
    i = j;
  }
  if (subs.length === 1) {
    return cluster.slice().sort(
      (x, y) => st[y].gd - st[x].gd || st[y].gf - st[x].gf || Math.random() - 0.5,
    );
  }
  const out: string[] = [];
  for (const s of subs) out.push(...(s.length === 1 ? s : resolveCluster(s, ms, st)));
  return out;
}

function rankGroup(teams: string[], ms: ResolvedMatch[]): { order: string[]; st: Record<string, Stat> } {
  const st: Record<string, Stat> = {};
  teams.forEach((n) => (st[n] = emptyStat()));
  for (const m of ms) applyScore(st, m);
  teams.forEach((n) => (st[n].gd = st[n].gf - st[n].ga));

  const byPts = teams.slice().sort((x, y) => st[y].pts - st[x].pts);
  const out: string[] = [];
  let i = 0;
  while (i < byPts.length) {
    let j = i;
    while (j < byPts.length && st[byPts[j]].pts === st[byPts[i]].pts) j++;
    const cl = byPts.slice(i, j);
    out.push(...(cl.length === 1 ? cl : resolveCluster(cl, ms, st)));
    i = j;
  }
  return { order: out, st };
}

// ---------------------------------------------------------------------------
// Deterministic status from remaining fixtures: exhaustive W/D/L enumeration of
// each group's remaining matches. Ties on points are resolved by head-to-head
// points; any residual (goal-difference-level) tie is treated optimistically
// for the best-case rank and pessimistically for the worst-case rank. So a
// "clinched"/"eliminated" verdict is mathematically sound (never claimed unless
// guaranteed); borderline goal-difference cases fall back to "alive".
function h2hPoints(set: Set<string>, played: Group["matches"], remaining: Group["matches"], outcomes: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  set.forEach((n) => (h[n] = 0));
  for (const m of played) {
    if (set.has(m.home) && set.has(m.away)) {
      if (m.hg > m.ag) h[m.home] += 3; else if (m.hg < m.ag) h[m.away] += 3; else { h[m.home]++; h[m.away]++; }
    }
  }
  for (let i = 0; i < remaining.length; i++) {
    const m = remaining[i];
    if (set.has(m.home) && set.has(m.away)) {
      const o = outcomes[i];
      if (o === 0) h[m.home] += 3; else if (o === 1) { h[m.home]++; h[m.away]++; } else h[m.away] += 3;
    }
  }
  return h;
}

function enumerateStatus(group: Group, advancePerGroup: number, bestThirds: number): Record<string, Status> {
  const teams = group.teams;
  const played = group.matches.filter((m) => m.played);
  const remaining = group.matches.filter((m) => !m.played);
  const r = remaining.length;

  const base: Record<string, number> = {};
  teams.forEach((t) => (base[t] = 0));
  for (const m of played) {
    if (m.hg > m.ag) base[m.home] += 3; else if (m.hg < m.ag) base[m.away] += 3; else { base[m.home]++; base[m.away]++; }
  }
  const eligibleMax = bestThirds > 0 ? advancePerGroup + 1 : advancePerGroup;
  const minBest: Record<string, number> = {};
  const maxWorst: Record<string, number> = {};
  teams.forEach((t) => { minBest[t] = Infinity; maxWorst[t] = 0; });

  const total = Math.pow(3, r);
  const outcomes = new Array<number>(r);
  for (let s = 0; s < total; s++) {
    const pts: Record<string, number> = { ...base };
    let x = s;
    for (let i = 0; i < r; i++) {
      const o = x % 3; x = (x / 3) | 0; outcomes[i] = o;
      const m = remaining[i];
      if (o === 0) pts[m.home] += 3; else if (o === 1) { pts[m.home]++; pts[m.away]++; } else pts[m.away] += 3;
    }
    for (const t of teams) {
      const pt = pts[t];
      let above = 0;
      const tied: string[] = [];
      for (const u of teams) { if (u === t) continue; if (pts[u] > pt) above++; else if (pts[u] === pt) tied.push(u); }
      let best: number, worst: number;
      if (tied.length === 0) {
        best = worst = above + 1;
      } else {
        const set = new Set([t, ...tied]);
        const h = h2hPoints(set, played, remaining, outcomes);
        let better = 0, equal = 0;
        for (const u of tied) { if (h[u] > h[t]) better++; else if (h[u] === h[t]) equal++; }
        best = above + better + 1;
        worst = above + better + equal + 1;
      }
      if (best < minBest[t]) minBest[t] = best;
      if (worst > maxWorst[t]) maxWorst[t] = worst;
    }
  }

  const out: Record<string, Status> = {};
  for (const t of teams) {
    if (maxWorst[t] <= advancePerGroup) out[t] = "clinched";
    else if (minBest[t] > eligibleMax) out[t] = "eliminated";
    else out[t] = "alive";
  }
  return out;
}

// ---------------------------------------------------------------------------
interface Counters {
  adv: Record<string, number>;
  win: Record<string, number>;
  thirdAdv: Record<string, number>;
  pos: Record<string, number[]>;
  pointsDist: Record<string, number[]>;
}

function maxPoints(groupSize: number): number {
  return 3 * (groupSize - 1);
}

export class Forecaster {
  private t: Tournament;
  private c: Counters;
  private done = 0;
  private status: Record<string, Status>;

  constructor(t: Tournament) {
    this.t = t;
    this.c = { adv: {}, win: {}, thirdAdv: {}, pos: {}, pointsDist: {} };
    this.status = {};
    for (const g of t.groups) {
      g.teams.forEach((n) => {
        this.c.adv[n] = 0; this.c.win[n] = 0; this.c.thirdAdv[n] = 0;
        this.c.pos[n] = new Array(g.teams.length).fill(0);
        this.c.pointsDist[n] = new Array(maxPoints(g.teams.length) + 1).fill(0);
      });
      Object.assign(this.status, enumerateStatus(g, t.advancePerGroup, t.bestThirds));
    }
  }

  get completed(): number {
    return this.done;
  }

  runChunk(n: number): void {
    const { groups, advancePerGroup, bestThirds } = this.t;
    const work: ResolvedMatch[][] = groups.map((g) =>
      g.matches.map((m) => ({ home: m.home, away: m.away, hg: m.hg, ag: m.ag })),
    );
    for (let s = 0; s < n; s++) {
      const thirds: Array<{ name: string; pts: number; gd: number; gf: number }> = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const ms = work[gi];
        for (let mi = 0; mi < g.matches.length; mi++) {
          if (!g.matches[mi].played) { ms[mi].hg = poisson(LAMBDA); ms[mi].ag = poisson(LAMBDA); }
        }
        const { order, st } = rankGroup(g.teams, ms);
        for (let p = 0; p < order.length; p++) this.c.pos[order[p]][p]++;
        for (const n of g.teams) this.c.pointsDist[n][st[n].pts]++;
        this.c.win[order[0]]++;
        for (let p = 0; p < advancePerGroup && p < order.length; p++) this.c.adv[order[p]]++;
        if (bestThirds > 0 && order.length > advancePerGroup) {
          const n3 = order[advancePerGroup];
          thirds.push({ name: n3, pts: st[n3].pts, gd: st[n3].gd, gf: st[n3].gf });
        }
      }
      if (bestThirds > 0) {
        thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || Math.random() - 0.5);
        for (let i = 0; i < bestThirds && i < thirds.length; i++) {
          this.c.adv[thirds[i].name]++; this.c.thirdAdv[thirds[i].name]++;
        }
      }
    }
    this.done += n;
  }

  finalize(): Forecast {
    const d = this.done || 1;
    const f: Forecast = { adv: {}, win: {}, thirdAdv: {}, pos: {}, pointsDist: {}, status: this.status };
    for (const g of this.t.groups) {
      for (const n of g.teams) {
        f.adv[n] = this.c.adv[n] / d;
        f.win[n] = this.c.win[n] / d;
        f.thirdAdv[n] = this.c.thirdAdv[n] / d;
        f.pos[n] = this.c.pos[n].map((v) => v / d);
        f.pointsDist[n] = this.c.pointsDist[n].map((v) => v / d);
      }
    }
    return f;
  }
}

/**
 * "What needs to happen" for a team's next match: fix that match to each result
 * and report the resulting mathematical status. Strength-free — pure structure.
 */
export function nextMatchScenarios(
  t: Tournament,
  group: Group,
  team: string,
): Array<{ label: string; opponent: string; status: Status }> | null {
  const next = group.matches.find((m) => !m.played && (m.home === team || m.away === team));
  if (!next) return null;
  const isHome = next.home === team;
  const opponent = isHome ? next.away : next.home;
  const outcomes: Array<{ label: string; hg: number; ag: number }> = [
    { label: "Win", hg: isHome ? 1 : 0, ag: isHome ? 0 : 1 },
    { label: "Draw", hg: 0, ag: 0 },
    { label: "Lose", hg: isHome ? 0 : 1, ag: isHome ? 1 : 0 },
  ];
  return outcomes.map((o) => {
    const g2: Group = {
      ...group,
      matches: group.matches.map((m) =>
        m === next ? { ...m, played: true, hg: o.hg, ag: o.ag } : m,
      ),
    };
    const st = enumerateStatus(g2, t.advancePerGroup, t.bestThirds);
    return { label: o.label, opponent, status: st[team] };
  });
}

// ---------------------------------------------------------------------------
// Scenario solver: enumerate the remaining group results and report the minimal
// conditions for a team's outcomes. Pure structure, no strength.

function basePoints(teams: string[], played: Group["matches"]): Record<string, number> {
  const p: Record<string, number> = {};
  teams.forEach((t) => (p[t] = 0));
  for (const m of played) {
    if (m.hg > m.ag) p[m.home] += 3; else if (m.hg < m.ag) p[m.away] += 3; else { p[m.home]++; p[m.away]++; }
  }
  return p;
}

/** Best/worst finishing rank (1-based) for `team` given a fully-assigned scenario.
 *  Ties on points use head-to-head points; residual (goal-difference) ties give
 *  the best rank (optimistic) and worst rank (pessimistic). */
function rankRange(team: string, teams: string[], played: Group["matches"], remaining: Group["matches"], outcomes: number[]): { best: number; worst: number } {
  const pts = basePoints(teams, played);
  for (let i = 0; i < remaining.length; i++) {
    const m = remaining[i], o = outcomes[i];
    if (o === 0) pts[m.home] += 3; else if (o === 1) { pts[m.home]++; pts[m.away]++; } else pts[m.away] += 3;
  }
  const pt = pts[team];
  let above = 0;
  const tied: string[] = [];
  for (const u of teams) { if (u === team) continue; if (pts[u] > pt) above++; else if (pts[u] === pt) tied.push(u); }
  if (tied.length === 0) return { best: above + 1, worst: above + 1 };
  const h = h2hPoints(new Set([team, ...tied]), played, remaining, outcomes);
  let better = 0, equal = 0;
  for (const u of tied) { if (h[u] > h[team]) better++; else if (h[u] === h[team]) equal++; }
  return { best: above + better + 1, worst: above + better + equal + 1 };
}

function ownGain(team: string, m: Group["matches"][number], outcome: number): number {
  const home = m.home === team;
  if (outcome === 1) return 1;
  return (outcome === 0 && home) || (outcome === 2 && !home) ? 3 : 0;
}
function matchPhrase(m: Group["matches"][number], code: number): string {
  if (code === 1) return `${m.home} and ${m.away} draw`;
  return code === 0 ? `${m.home} beat ${m.away}` : `${m.away} beat ${m.home}`;
}

export function analyzeTeam(t: Tournament, group: Group, team: string): TeamAnalysis {
  const teams = group.teams;
  const played = group.matches.filter((m) => m.played);
  const remaining = group.matches.filter((m) => !m.played);
  const k = remaining.length;
  const ownIdx: number[] = [];
  remaining.forEach((m, i) => { if (m.home === team || m.away === team) ownIdx.push(i); });
  const ownRemaining = ownIdx.length;
  const maxOwnPts = 3 * ownRemaining;

  let cur = 0;
  for (const m of played) {
    if (m.home === team || m.away === team) {
      const home = m.home === team, gf = home ? m.hg : m.ag, ga = home ? m.ag : m.hg;
      cur += gf > ga ? 3 : gf === ga ? 1 : 0;
    }
  }

  const adv = t.advancePerGroup;
  let failTop2 = -1, possTop2 = Infinity, failWin = -1, possWin = Infinity;
  const outcomes = new Array<number>(k);
  const total = Math.pow(3, k);
  for (let s = 0; s < total; s++) {
    let x = s;
    for (let i = 0; i < k; i++) { outcomes[i] = x % 3; x = (x / 3) | 0; }
    let ownPts = 0;
    for (const i of ownIdx) ownPts += ownGain(team, remaining[i], outcomes[i]);
    const { best, worst } = rankRange(team, teams, played, remaining, outcomes);
    if (worst > adv) failTop2 = Math.max(failTop2, ownPts);
    if (best <= adv) possTop2 = Math.min(possTop2, ownPts);
    if (worst > 1) failWin = Math.max(failWin, ownPts);
    if (best <= 1) possWin = Math.min(possWin, ownPts);
  }
  const guar = (failMax: number) => (failMax < 0 ? 0 : failMax >= maxOwnPts ? null : failMax + 1);

  const analysis: TeamAnalysis = {
    team, ownRemaining, otherRemaining: k - ownRemaining, curPoints: cur, maxOwnPts,
    top2: { guaranteePts: guar(failTop2), possiblePts: possTop2 === Infinity ? null : possTop2 },
    winGroup: { guaranteePts: guar(failWin), possiblePts: possWin === Infinity ? null : possWin },
  };

  if (ownRemaining === 1) {
    const own = remaining[ownIdx[0]];
    const isHome = own.home === team;
    analysis.nextMatch = { opponent: isHome ? own.away : own.home, isHome };
    const others = remaining.map((_, i) => i).filter((i) => i !== ownIdx[0]);
    const resultCodes: Array<{ label: NextResultLine["result"]; code: number }> = [
      { label: "Win", code: isHome ? 0 : 2 },
      { label: "Draw", code: 1 },
      { label: "Lose", code: isHome ? 2 : 0 },
    ];
    analysis.nextResults = resultCodes.map(({ label, code }) => {
      let allWorstTop2 = true, someBestTop2 = false, allBestTop2 = true;
      let allWorstWin = true, someBestWin = false;
      const failCombos: number[][] = [];
      const oTotal = Math.pow(3, others.length);
      for (let s = 0; s < oTotal; s++) {
        let x = s; const combo: number[] = [];
        for (let j = 0; j < others.length; j++) { combo.push(x % 3); x = (x / 3) | 0; }
        outcomes[ownIdx[0]] = code;
        others.forEach((oi, j) => (outcomes[oi] = combo[j]));
        const { best, worst } = rankRange(team, teams, played, remaining, outcomes);
        if (worst > adv) allWorstTop2 = false;
        if (best <= adv) someBestTop2 = true; else { allBestTop2 = false; failCombos.push(combo); }
        if (worst > 1) allWorstWin = false;
        if (best <= 1) someBestWin = true;
      }
      const top2: Guarantee = allWorstTop2 ? "guaranteed" : someBestTop2 ? "possible" : "impossible";
      const winGroup: Guarantee = allWorstWin ? "guaranteed" : someBestWin ? "possible" : "impossible";
      const gdDependent = top2 === "possible" && allBestTop2; // points always enough, GD decides
      let condition = "";
      if (top2 === "possible" && !gdDependent) {
        if (others.length === 1) {
          const m = remaining[others[0]];
          const codes = [...new Set(failCombos.map((c) => c[0]))];
          condition = "out of the top 2 if " + codes.map((c) => matchPhrase(m, c)).join(" or ");
        } else if (others.length === 2 && failCombos.length <= 3) {
          condition = "out of the top 2 if " + failCombos.map((c) => `${matchPhrase(remaining[others[0]], c[0])} and ${matchPhrase(remaining[others[1]], c[1])}`).join(", or ");
        } else {
          condition = "depends on other results in the group";
        }
      }
      return { result: label, top2, winGroup, gdDependent, condition };
    });
  }
  return analysis;
}

/**
 * Cross-group sensitivity: simulate the whole tournament and measure, for every
 * remaining match the team does NOT play, how the team's advance chance changes
 * with that match's result. This is how the third-place race makes a team depend
 * on other groups — surfaced as concrete matches with real numbers, since the
 * best-8-of-12 cut can't be reduced to a single clean "iff" condition.
 */
export function sensitivity(t: Tournament, team: string, sims: number): Sensitivity {
  const teamGroup = t.groups.find((g) => g.teams.includes(team))!.name;
  const teamGi = t.groups.findIndex((g) => g.teams.includes(team));
  const rem: Array<{ gi: number; mi: number; group: string; home: string; away: string; involves: boolean }> = [];
  const remOf: Record<string, number> = {};
  t.groups.forEach((g, gi) => g.matches.forEach((m, mi) => {
    if (!m.played) { remOf[`${gi}:${mi}`] = rem.length; rem.push({ gi, mi, group: g.name, home: m.home, away: m.away, involves: m.home === team || m.away === team }); }
  }));
  const R = rem.length;
  // unconditional counts (used for the team's own next match)
  const tot: number[][] = Array.from({ length: R }, () => [0, 0, 0]);
  const adv: number[][] = Array.from({ length: R }, () => [0, 0, 0]);
  // counts CONDITIONAL on the team finishing 3rd (when external matches matter)
  const tot3: number[][] = Array.from({ length: R }, () => [0, 0, 0]);
  const adv3: number[][] = Array.from({ length: R }, () => [0, 0, 0]);
  let advTotal = 0, thirdTotal = 0, thirdAdv = 0;

  const work = t.groups.map((g) => g.matches.map((m) => ({ home: m.home, away: m.away, hg: m.hg, ag: m.ag, played: m.played })));
  const codes = new Array<number>(R);

  for (let s = 0; s < sims; s++) {
    let advanced = false, isThird = false;
    const thirds: Array<{ name: string; pts: number; gd: number; gf: number }> = [];
    for (let gi = 0; gi < t.groups.length; gi++) {
      const g = t.groups[gi], ms = work[gi];
      for (let mi = 0; mi < ms.length; mi++) {
        if (!ms[mi].played) {
          const hg = poisson(LAMBDA), ag = poisson(LAMBDA);
          ms[mi].hg = hg; ms[mi].ag = ag;
          codes[remOf[`${gi}:${mi}`]] = hg > ag ? 0 : hg < ag ? 2 : 1;
        }
      }
      const { order, st } = rankGroup(g.teams, ms);
      for (let p = 0; p < t.advancePerGroup && p < order.length; p++) if (order[p] === team) advanced = true;
      if (t.bestThirds > 0 && order.length > t.advancePerGroup) {
        const n3 = order[t.advancePerGroup];
        if (gi === teamGi && n3 === team) isThird = true;
        thirds.push({ name: n3, pts: st[n3].pts, gd: st[n3].gd, gf: st[n3].gf });
      }
    }
    if (t.bestThirds > 0) {
      thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || Math.random() - 0.5);
      for (let i = 0; i < t.bestThirds && i < thirds.length; i++) if (thirds[i].name === team) advanced = true;
    }
    if (advanced) advTotal++;
    if (isThird) { thirdTotal++; if (advanced) thirdAdv++; }
    for (let i = 0; i < R; i++) {
      const c = codes[i];
      tot[i][c]++; if (advanced) adv[i][c]++;
      if (isThird) { tot3[i][c]++; if (advanced) adv3[i][c]++; }
    }
  }

  // external matches that move survival, conditional on finishing 3rd
  const matches: MatchImpact[] = [];
  for (let i = 0; i < R; i++) {
    if (rem[i].involves || thirdTotal === 0) continue;
    const rows = ([0, 1, 2] as const).filter((c) => tot3[i][c] > 0).map((c) => ({ outcome: c, pAdvance: adv3[i][c] / tot3[i][c], share: tot3[i][c] / thirdTotal }));
    if (rows.length < 2) continue;
    const ps = rows.map((r) => r.pAdvance);
    matches.push({ group: rem[i].group, home: rem[i].home, away: rem[i].away, ownGroup: rem[i].group === teamGroup, swing: Math.max(...ps) - Math.min(...ps), rows });
  }
  matches.sort((a, b) => b.swing - a.swing);

  const ownIdx = rem.findIndex((r) => r.involves);
  const out: Sensitivity = {
    advance: advTotal / sims,
    thirdShare: thirdTotal / sims,
    thirdAdvance: thirdTotal ? thirdAdv / thirdTotal : 0,
    matches: matches.filter((m) => m.swing >= 0.03).slice(0, 6),
  };
  if (ownIdx >= 0) {
    const isHome = rem[ownIdx].home === team;
    const codeFor: Record<"Win" | "Draw" | "Lose", number> = { Win: isHome ? 0 : 2, Draw: 1, Lose: isHome ? 2 : 0 };
    out.ownNextMatch = { opponent: isHome ? rem[ownIdx].away : rem[ownIdx].home, isHome };
    out.ownNext = (["Win", "Draw", "Lose"] as const).map((result) => {
      const c = codeFor[result];
      return { result, pAdvance: tot[ownIdx][c] ? adv[ownIdx][c] / tot[ownIdx][c] : 0 };
    });
  }
  return out;
}

/** Play out one random tournament (neutral results for unplayed matches). */
export function sampleTournament(t: Tournament): SampleResult {
  const thirds: SampleResult["thirds"] = [];
  const groups = t.groups.map((g) => {
    const ms: ResolvedMatch[] = g.matches.map((m) =>
      m.played ? { home: m.home, away: m.away, hg: m.hg, ag: m.ag }
        : { home: m.home, away: m.away, hg: poisson(LAMBDA), ag: poisson(LAMBDA) },
    );
    const { order, st } = rankGroup(g.teams, ms);
    const rows: SampleRow[] = order.map((n, i) => ({
      name: n, pts: st[n].pts, gd: st[n].gd, gf: st[n].gf, rank: i + 1,
      advanced: i < t.advancePerGroup,
    }));
    if (t.bestThirds > 0 && order.length > t.advancePerGroup) {
      const n3 = order[t.advancePerGroup];
      thirds.push({ name: n3, group: g.name, pts: st[n3].pts, gd: st[n3].gd, advanced: false });
    }
    return { name: g.name, rows };
  });
  thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || Math.random() - 0.5);
  for (let i = 0; i < t.bestThirds && i < thirds.length; i++) {
    thirds[i].advanced = true;
    const grp = groups.find((g) => g.name === thirds[i].group)!;
    const row = grp.rows.find((r) => r.name === thirds[i].name)!;
    row.advanced = true;
  }
  return { groups, thirds };
}
