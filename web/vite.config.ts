import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page always talks to its own address (/ws, /auth): in production Caddy
// serves the page and passes those to the hub; in development Vite does the
// same for a hub on this PC, or for the VPS with `npm run dev:vps`
// (HUB=http://host:port to point anywhere else).
const VPS = "https://alphahedgedesk.duckdns.org";

/**
 * Every build is stamped, and the same stamp is written to dist/version.json. The page compares
 * the two while it runs (core/version.ts): a deploy puts a new version.json on the server, the
 * open tabs notice within a couple of minutes and offer a refresh. Nothing on the hub takes part,
 * so deploying the website never interrupts the feed.
 */
const buildId = new Date().toISOString();

export default defineConfig(({ mode, command }) => {
  const hub = process.env.HUB ?? (mode === "vps" ? VPS : "http://127.0.0.1:8080");
  return {
    define: {
      // "dev" while `vite` serves: there is no version.json to compare against, so no page nags.
      __BUILD_ID__: JSON.stringify(command === "build" ? buildId : "dev"),
    },
    plugins: [
      react(),
      {
        name: "markethub-version",
        apply: "build",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: buildId }) });
        },
      },
    ],
    resolve: {
      // Our fork of openalgo-charts, from its TypeScript source (vendor/openalgo-charts/FORK.md).
      alias: [{ find: /^openalgo-charts$/, replacement: fileURLToPath(new URL("./vendor/openalgo-charts/src/index.ts", import.meta.url)) }],
    },
    build: {
      target: "es2022",
      sourcemap: false,
    },
    server: {
      port: 5173,
      proxy: {
        // changeOrigin: Caddy on the VPS answers only to its own host name.
        // Origin too: the hub lets browsers open /ws only from its own site.
        "/ws": { target: hub.replace(/^http/, "ws"), ws: true, changeOrigin: true, headers: { origin: hub } },
        "/auth": { target: hub, changeOrigin: true },
        "/history": { target: hub, changeOrigin: true },
        "/straddle_history": { target: hub, changeOrigin: true },
      },
    },
  };
});
