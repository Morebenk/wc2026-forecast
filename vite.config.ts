import { defineConfig, loadEnv, type Plugin } from "vite";
import { collectKeys, fetchWcMatches } from "./src/server/fetchMatches";

const TTL_MS = 60_000;

/**
 * Local-dev only: mirrors the Cloudflare Pages Function at /api/wc/matches so
 * `npm run dev` has live data with HMR, without running wrangler. Production
 * uses functions/api/wc/matches.ts. Both share fetchWcMatches() — one source
 * of truth. Cached 60s to respect the free rate limit.
 */
function worldCupApi(keys: string[]): Plugin {
  let cache: { ts: number; body: string } | null = null;
  return {
    name: "wc-live-data-dev",
    configureServer(server) {
      server.middlewares.use("/api/wc/matches", async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (cache && Date.now() - cache.ts < TTL_MS) {
          res.end(cache.body);
          return;
        }
        const data = await fetchWcMatches(keys);
        const body = JSON.stringify(data);
        if (data.available) cache = { ts: Date.now(), body };
        res.end(body);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [worldCupApi(collectKeys(env))],
    server: { open: true },
  };
});
