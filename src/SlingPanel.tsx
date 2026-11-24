import { useEffect, useState, type FormEvent } from "react";
import { ensureProxyWorker } from "./RadiusSchedule";

// Served by the server's Sling proxy (server/sling.ts).
const PROXY_SW = "/sling/__proxy-sw.js";
const SLING_HOME = "/sling/";

type Status = { state: "loading" } | { state: "unlinked" } | { state: "linked"; email: string } | { state: "error" };

// The Sling tab: a "Log in to Sling" form until Sling is linked, then the
// Sling web app embedded through the proxy.
export function SlingPanel() {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    fetch("/api/sling")
      .then(async (res) => {
        const data = (await res.json()) as { linked?: boolean; email?: string };
        setStatus(data.linked && data.email ? { state: "linked", email: data.email } : { state: "unlinked" });
      })
      .catch(() => setStatus({ state: "error" }));
  }, []);

  useEffect(() => {
    if (status.state !== "linked") return;
    if (!("serviceWorker" in navigator)) return setStatus({ state: "error" });
    ensureProxyWorker(PROXY_SW, "/sling/").then(
      () => setFrameReady(true),
      (err) => {
        console.error(err);
        setStatus({ state: "error" });
      },
    );
  }, [status.state]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { signIn?: string; error?: string };
      if (!res.ok || !data.signIn) throw new Error(data.error ?? "Sign-in failed.");
      setPassword("");
      // The sign-in runs in the background; check on it until it finishes.
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetch(`/api/sling/sign-in/${encodeURIComponent(data.signIn)}`);
        const result = (await poll.json()) as { state?: string; email?: string | null; error?: string };
        if (!poll.ok) throw new Error(result.error ?? "Sign-in failed.");
        if (result.state === "failed") throw new Error(result.error ?? "Sign-in failed.");
        if (result.state === "done" && result.email) {
          setStatus({ state: "linked", email: result.email });
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!confirm("Unlink Sling? The app will delete your saved Sling password.")) return;
    await fetch("/api/sling", { method: "DELETE" });
    setFrameReady(false);
    setStatus({ state: "unlinked" });
  }

  if (status.state === "loading") return <p className="radius-note">Loading…</p>;
  if (status.state === "error") {
    return (
      <p className="radius-error" role="alert">
        Couldn't load Sling in this browser.
      </p>
    );
  }

  if (status.state === "linked") {
    return (
      <>
        <div className="sling-bar">
          <p className="radius-note">
            Connected to Sling as <strong>{status.email}</strong>
          </p>
          <button type="button" className="radius-secondary" onClick={unlink}>
            Unlink Sling
          </button>
        </div>
        {frameReady ? (
          <iframe className="radius-frame" title="Sling" src={SLING_HOME} />
        ) : (
          <p className="radius-note">Loading Sling…</p>
        )}
      </>
    );
  }

  return (
    <form className="radius-card radius-form" onSubmit={submit}>
      <h2>Log in to Sling</h2>
      <p className="radius-note">
        Use your getsling.com email and password. They're saved encrypted so this app can keep you signed in to
        Sling. Signing in solves Sling's captcha automatically and can take up to a minute.
      </p>
      <label>
        Email
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && (
        <p className="radius-error" role="alert">
          {error}
        </p>
      )}
      <div className="radius-actions">
        <button type="submit" className="radius-button" disabled={busy}>
          {busy ? "Signing in (solving captcha)…" : "Log in"}
        </button>
      </div>
    </form>
  );
}
