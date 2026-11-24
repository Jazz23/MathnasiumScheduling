import { useEffect, useState, type FormEvent } from "react";
import { CenterSetup } from "./CenterSetup";
import { DemandView } from "./DemandView";
import { RadiusSchedule } from "./RadiusSchedule";
import { Roster } from "./Roster";
import { SlingPanel } from "./SlingPanel";

const TABS = [
  { id: "demand", label: "Demand", render: () => <DemandView /> },
  { id: "center", label: "Center", render: () => <CenterSetup /> },
  { id: "roster", label: "Roster", render: () => <Roster /> },
  { id: "radius", label: "Radius", render: () => <RadiusSchedule /> },
  { id: "sling", label: "Sling", render: () => <SlingPanel /> },
] as const;
type TabId = (typeof TABS)[number]["id"];

type Status = { state: "loading" } | { state: "signed-out" } | { state: "signed-in"; username: string };

// "Login with Radius". Radius can't be embedded in an iframe, so this is our
// own form; the Worker signs in to Radius with these credentials and keeps
// them (encrypted) so the app can keep acting on the user's account.
export function RadiusLogin() {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [formOpen, setFormOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>("demand");
  // Tabs mount the first time they're opened (the Demand tab reads Radius and
  // Sling), then stay mounted so switching keeps each one's state.
  const [opened, setOpened] = useState<Set<TabId>>(() => new Set(["demand"]));
  const openTab = (id: TabId) => {
    setTab(id);
    setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (res) => {
        if (!res.ok) return setStatus({ state: "signed-out" });
        const { username } = (await res.json()) as { username: string };
        setStatus({ state: "signed-in", username });
      })
      .catch(() => setStatus({ state: "signed-out" }));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/radius", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { username?: string; error?: string };
      if (!res.ok || !data.username) throw new Error(data.error ?? "Sign-in failed.");
      setStatus({ state: "signed-in", username: data.username });
      setFormOpen(false);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut(unlink: boolean) {
    if (unlink && !confirm("Unlink Radius? The app will delete your saved Radius password.")) return;
    await fetch(unlink ? "/api/auth/radius" : "/api/auth/logout", { method: unlink ? "DELETE" : "POST" });
    setStatus({ state: "signed-out" });
  }

  if (status.state === "loading") return null;

  if (status.state === "signed-in") {
    return (
      <div className="schedule">
        <header className="schedule-bar">
          <p>
            Connected to Radius as <strong>{status.username}</strong>
          </p>
          <div className="radius-actions">
            <button type="button" className="radius-secondary" onClick={() => signOut(false)}>
              Log out
            </button>
            <button type="button" className="radius-secondary" onClick={() => signOut(true)}>
              Unlink Radius
            </button>
          </div>
        </header>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => openTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {TABS.map(
          (t) =>
            opened.has(t.id) && (
              <div key={t.id} className="tab-panel" hidden={tab !== t.id}>
                {t.render()}
              </div>
            ),
        )}
      </div>
    );
  }

  if (!formOpen) {
    return (
      <button type="button" className="radius-button" onClick={() => setFormOpen(true)}>
        Log in with Radius
      </button>
    );
  }

  return (
    <form className="radius-card radius-form" onSubmit={submit}>
      <h2>Log in with Radius</h2>
      <p className="radius-note">
        Use your Mathnasium Radius username and password. They're saved encrypted so this app can keep
        accessing your Radius account.
      </p>
      <label>
        Username
        <input
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
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
          {busy ? "Signing in…" : "Log in"}
        </button>
        <button type="button" className="radius-secondary" onClick={() => setFormOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
