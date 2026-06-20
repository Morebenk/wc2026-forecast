/// <reference types="@cloudflare/workers-types" />
import { collectKeys, fetchWcMatches } from "../../../src/server/fetchMatches";

interface Env {
  FOOTBALL_DATA_API_KEY?: string;
  FOOTBALL_DATA_API_KEY_2?: string;
  FOOTBALL_DATA_API_KEY_3?: string;
  FOOTBALL_DATA_API_KEY_4?: string;
  /** Optional KV namespace binding (id "WC_CACHE") for a globally-shared cache. */
  WC_CACHE?: KVNamespace;
}

const TTL = 60; // seconds the upstream result is reused for
const CACHE_KEY = "wc:matches:v1";
const EDGE_URL = "https://wc-cache.internal/matches"; // synthetic key for the Cache API

// GET /api/wc/matches
//
// Safety net for public deployment: the football-data.org key pool is shared by
// ALL visitors, so we must never let request volume reach upstream. Three layers,
// cheapest first:
//   1. KV (global, ~1 upstream call/min worldwide) — used if a WC_CACHE binding exists.
//   2. Cache API (per-colo, ~1 call/min per data centre) — always available, zero setup.
//   3. Upstream fetch — only on a true miss; only successes are cached.
// Combined with the client-side refresh throttle, a user mashing "Refresh" can't
// drain the quota for everyone.
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  if (env.WC_CACHE) {
    const hit = await env.WC_CACHE.get(CACHE_KEY);
    if (hit) return jsonResponse(hit, "kv");
  }

  const cache = caches.default;
  const edgeReq = new Request(EDGE_URL);
  const edgeHit = await cache.match(edgeReq);
  if (edgeHit) return edgeHit;

  const data = await fetchWcMatches(collectKeys({
    FOOTBALL_DATA_API_KEY: env.FOOTBALL_DATA_API_KEY,
    FOOTBALL_DATA_API_KEY_2: env.FOOTBALL_DATA_API_KEY_2,
    FOOTBALL_DATA_API_KEY_3: env.FOOTBALL_DATA_API_KEY_3,
    FOOTBALL_DATA_API_KEY_4: env.FOOTBALL_DATA_API_KEY_4,
  }));
  const body = JSON.stringify(data);

  // Only cache real successes — never pin an error/rate-limit response.
  if (data.available) {
    if (env.WC_CACHE) context.waitUntil(env.WC_CACHE.put(CACHE_KEY, body, { expirationTtl: TTL }));
    const res = jsonResponse(body, "miss");
    context.waitUntil(cache.put(edgeReq, res.clone()));
    return res;
  }
  // Failure: short no-store so the next visitor can retry immediately.
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};

function jsonResponse(body: string, src: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${TTL}, s-maxage=${TTL}`,
      "X-Cache": src,
    },
  });
}
