import { useEffect, useState } from "react";

// Served by the Worker's Radius proxy (src/server/radiusProxy.ts).
const PROXY_SW = "/radius/__proxy-sw.js";
const CALENDAR = "/radius/Scheduling/Calendar";

// Registers the proxy's service worker and waits until it's active, so it
// controls the iframe from its first load.
export async function ensureProxyWorker(script: string, scope: string): Promise<void> {
  const registration = await navigator.serviceWorker.register(script, { scope });
  if (registration.active) return;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return;
  await new Promise<void>((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      if (worker.state === "redundant") reject(new Error("Service worker failed to install"));
    });
  });
}

// The Radius scheduling calendar, embedded through the proxy.
export function RadiusSchedule() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return setState("error");
    ensureProxyWorker(PROXY_SW, "/radius/").then(
      () => setState("ready"),
      (err) => {
        console.error(err);
        setState("error");
      },
    );
  }, []);

  if (state === "error") {
    return (
      <p className="radius-error" role="alert">
        Couldn't load the Radius schedule in this browser.
      </p>
    );
  }
  if (state === "loading") return <p className="radius-note">Loading schedule…</p>;
  return <iframe className="radius-frame" title="Radius schedule" src={CALENDAR} />;
}
