// Generic, tournament-agnostic model. Everything here is built at runtime from
// the live API — no team, group, or result is hardcoded — so the same engine
// works for any World Cup edition.

export interface TeamRef {
  name: string;
  code: string; // three-letter abbreviation (from the API), best-effort
}

export interface GroupMatch {
  home: string; // team name
  away: string;
  played: boolean;
  hg: number; // home goals (0 if not played)
  ag: number;
}

export interface Group {
  name: string; // e.g. "A"
  teams: string[]; // team names, first-seen order
  matches: GroupMatch[];
}

export interface Tournament {
  edition: string;
  groups: Group[];
  /** team name -> three-letter code, for compact display. */
  codes: Record<string, string>;
  /** Teams advancing automatically per group (top N). */
  advancePerGroup: number;
  /** Additional best-ranked Nth-place teams that advance across all groups. */
  bestThirds: number;
}

export type Status = "clinched" | "alive" | "eliminated";

export interface Forecast {
  /** P(reach knockout): top-N or best-ranked third place. By team name. */
  adv: Record<string, number>;
  /** P(win the group). */
  win: Record<string, number>;
  /** P(advance specifically as a qualifying third-place team). */
  thirdAdv: Record<string, number>;
  /** Finishing-position distribution, index 0 = 1st. Length = group size. */
  pos: Record<string, number[]>;
  /** Final-points distribution, index = points value. */
  pointsDist: Record<string, number[]>;
  /** Deterministic mathematical status from remaining fixtures. */
  status: Record<string, Status>;
}

export interface SampleRow {
  name: string;
  pts: number;
  gd: number;
  gf: number;
  rank: number; // 1-based finishing position in the group
  advanced: boolean;
}
export interface SampleResult {
  groups: Array<{ name: string; rows: SampleRow[] }>;
  thirds: Array<{ name: string; group: string; pts: number; gd: number; advanced: boolean }>;
}

export type Guarantee = "guaranteed" | "possible" | "impossible";

export interface NextResultLine {
  result: "Win" | "Draw" | "Lose";
  top2: Guarantee;
  winGroup: Guarantee;
  gdDependent: boolean; // top-2 hinges on goal difference, not points
  condition: string; // "", or "...unless X", or "depends on other results"
}

export interface TeamAnalysis {
  team: string;
  ownRemaining: number; // matches the team still has to play
  otherRemaining: number; // other remaining matches in the group
  curPoints: number;
  maxOwnPts: number; // 3 * ownRemaining
  /** Minimal own points to guarantee / make possible a top-N finish. null = impossible. */
  top2: { guaranteePts: number | null; possiblePts: number | null };
  winGroup: { guaranteePts: number | null; possiblePts: number | null };
  nextMatch?: { opponent: string; isHome: boolean };
  /** Per next-match result breakdown — only when exactly one own match remains. */
  nextResults?: NextResultLine[];
}

export interface MatchImpactRow {
  outcome: 0 | 1 | 2; // 0 home win, 1 draw, 2 away win
  pAdvance: number; // team's advance chance given this result
  share: number; // how often this result occurs in the model
}
export interface MatchImpact {
  group: string;
  home: string;
  away: string;
  ownGroup: boolean;
  swing: number; // max - min advance% across this match's results
  rows: MatchImpactRow[];
}
export interface Sensitivity {
  advance: number; // baseline advance probability
  thirdShare: number; // P(team finishes 3rd in its group)
  thirdAdvance: number; // P(advance | finishes 3rd) — survives the best-thirds cut
  /** External matches that move the team's survival, CONDITIONAL on it finishing 3rd. */
  matches: MatchImpact[];
  ownNext?: Array<{ result: "Win" | "Draw" | "Lose"; pAdvance: number }>;
  ownNextMatch?: { opponent: string; isHome: boolean };
}
