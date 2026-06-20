import type { Group, GroupMatch, Tournament } from "../engine/types";

export interface LiveMeta {
  fetchedAt?: string;
  matchesPlayed: number;
  matchesTotal: number;
}

export type LoadResult =
  | { ok: true; tournament: Tournament; meta: LiveMeta }
  | { ok: false; reason: string };

interface FdTeam {
  name?: string | null;
  tla?: string | null;
  shortName?: string | null;
}
interface FdMatch {
  stage?: string;
  group?: string | null;
  status?: string;
  homeTeam?: FdTeam;
  awayTeam?: FdTeam;
  score?: { fullTime?: { home?: number | null; away?: number | null } };
  competition?: { name?: string };
  season?: { startDate?: string };
}
interface ProxyPayload {
  available: boolean;
  reason?: string;
  fetchedAt?: string;
  matches?: FdMatch[];
}

function codeFor(t: FdTeam): string {
  if (t.tla) return t.tla;
  const n = t.shortName ?? t.name ?? "???";
  return n.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "???";
}

function buildTournament(matches: FdMatch[]): { tournament: Tournament; played: number; total: number } | null {
  const groupMap = new Map<string, Group>();
  const codes = new Map<string, string>();
  let played = 0;
  let total = 0;
  let edition = "World Cup";

  for (const m of matches) {
    if (m.stage !== "GROUP_STAGE" || !m.group) continue;
    const home = m.homeTeam?.name;
    const away = m.awayTeam?.name;
    if (!home || !away) continue; // draw not finalised yet

    if (m.competition?.name) {
      const year = m.season?.startDate ? new Date(m.season.startDate).getFullYear() : "";
      edition = year ? `${m.competition.name} ${year}` : m.competition.name;
    }
    codes.set(home, codeFor(m.homeTeam!));
    codes.set(away, codeFor(m.awayTeam!));

    const key = m.group.replace(/^GROUP_/, "").trim().toUpperCase();
    if (!groupMap.has(key)) groupMap.set(key, { name: key, teams: [], matches: [] });
    const grp = groupMap.get(key)!;
    if (!grp.teams.includes(home)) grp.teams.push(home);
    if (!grp.teams.includes(away)) grp.teams.push(away);

    const ft = m.score?.fullTime;
    const isPlayed = m.status === "FINISHED" && ft?.home != null && ft?.away != null;
    const match: GroupMatch = {
      home, away,
      played: isPlayed,
      hg: isPlayed ? (ft!.home as number) : 0,
      ag: isPlayed ? (ft!.away as number) : 0,
    };
    grp.matches.push(match);
    total++;
    if (isPlayed) played++;
  }

  const groups = [...groupMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (groups.length === 0) return null;

  const tournament: Tournament = {
    edition,
    groups,
    codes: Object.fromEntries(codes),
    advancePerGroup: 2,
    // 2026-style 48-team format advances the 8 best third-placed teams; classic
    // 8-group formats advance none. Inferred from group count, editable in the UI.
    bestThirds: groups.length >= 12 ? 8 : 0,
  };
  return { tournament, played, total };
}

export async function fetchTournament(): Promise<LoadResult> {
  let data: ProxyPayload;
  try {
    const r = await fetch("/api/wc/matches");
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    data = (await r.json()) as ProxyPayload;
  } catch (e) {
    return { ok: false, reason: `network: ${String((e as Error).message)}` };
  }
  if (!data.available) return { ok: false, reason: data.reason ?? "unavailable" };
  if (!data.matches) return { ok: false, reason: "empty" };

  const built = buildTournament(data.matches);
  if (!built) return { ok: false, reason: "no-group-matches" };

  return {
    ok: true,
    tournament: built.tournament,
    meta: { fetchedAt: data.fetchedAt, matchesPlayed: built.played, matchesTotal: built.total },
  };
}
