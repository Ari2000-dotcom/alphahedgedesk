import { useEffect, useState } from "react";

/**
 * Whether the site on the server is newer than the one this tab is running.
 *
 * Every build is stamped (vite.config.ts) and writes the same stamp to `version.json` beside
 * index.html. A tab asks for that file now and then and compares: when a deploy replaces the web
 * folder, the stamp changes and the tab offers a refresh (shell/UpdateToast.tsx) rather than
 * quietly running yesterday's code against today's hub.
 *
 * The hub takes no part in this, so putting a new website up never interrupts the feed.
 *
 * Two details decide how it is written:
 *
 * - Caddy serves the site with `try_files {path} /index.html`, so a *missing* version.json comes
 *   back as the page itself with a 200. The content type is checked before the body is read; a
 *   reply that is not JSON means "nothing to compare", never "a new version".
 * - A deploy renames the whole folder into place, so a request landing in that instant can fail
 *   or arrive half-written. Every error is ignored and the next check decides — a failed check
 *   never offers a refresh on its own.
 */

declare const __BUILD_ID__: string;

/** This tab's build. "dev" under `vite dev`, where there is nothing to compare against. */
export const BUILD_ID: string = __BUILD_ID__;

/** Often enough to hear about a deploy while it still matters; rare enough to cost nothing. */
const CHECK_EVERY_MS = 90_000;

export function useNewVersion(): boolean {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    if (BUILD_ID === "dev") return;
    let stopped = false;

    const check = async () => {
      if (stopped || document.hidden) return;
      try {
        const reply = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!reply.ok || !(reply.headers.get("content-type") ?? "").includes("json")) return;
        const served = (await reply.json()) as { build?: unknown };
        if (typeof served.build === "string" && served.build !== BUILD_ID) {
          stopped = true;
          setNewer(true);
        }
      } catch {
        // Offline, or a deploy swapping the folder underneath: the next check decides.
      }
    };

    // On coming back to the tab as well as on the clock: someone returning after lunch should not
    // wait another minute and a half to be told.
    const onShow = () => void check();
    document.addEventListener("visibilitychange", onShow);
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    void check();
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  return newer;
}
