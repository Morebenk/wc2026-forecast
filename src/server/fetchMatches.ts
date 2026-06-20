// Runtime-agnostic proxy logic shared by the Cloudflare Pages Function
// (production) and the Vite dev middleware (local). Uses only global fetch,
// so it runs identically on the Workers runtime and Node 18+.

const FD_URL = "https://api.football-data.org/v4/competitions/WC/matches";

export interface ProxyResponse {
  available: boolean;
  reason?: string;
  fetchedAt?: string;
  matches?: unknown[];
}

/** Collect 1+ keys from env. Accepts a comma-separated FOOTBALL_DATA_API_KEY
 *  and/or numbered FOOTBALL_DATA_API_KEY_2, _3, … — lets us pool several free
 *  accounts to raise the effective rate limit. */
export function collectKeys(env: Record<string, string | undefined>): string[] {
  const raw = [
    env.FOOTBALL_DATA_API_KEY,
    env.FOOTBALL_DATA_API_KEY_2,
    env.FOOTBALL_DATA_API_KEY_3,
    env.FOOTBALL_DATA_API_KEY_4,
  ].filter(Boolean).join(",");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

let roundRobin = 0;

/** Try keys round-robin; on a rate-limit (429) or auth (403) response, fail over
 *  to the next key. Returns the first success. */
export async function fetchWcMatches(keys: string[]): Promise<ProxyResponse> {
  if (keys.length === 0) return { available: false, reason: "no-key" };
  const start = roundRobin++ % keys.length;
  let lastReason = "unavailable";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length];
    try {
      const r = await fetch(FD_URL, { headers: { "X-Auth-Token": key } });
      if (r.ok) {
        const json = (await r.json()) as { matches?: unknown[] };
        return { available: true, fetchedAt: new Date().toISOString(), matches: json.matches ?? [] };
      }
      lastReason = `http-${r.status}`;
      if (r.status !== 429 && r.status !== 403) break; // not a per-key limit — stop
    } catch (e) {
      lastReason = String((e as Error).message);
    }
  }
  return { available: false, reason: lastReason };
}
