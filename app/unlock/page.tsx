"use client";

import { useState } from "react";

export default function Unlock() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (r.ok) window.location.href = "/";
    else {
      setError((await r.json()).error || "That code isn't right.");
      setBusy(false);
    }
  }

  return (
    <main className="unlock">
      <form onSubmit={submit}>
        <h1 className="wordmark"><span className="glyph" aria-hidden />Square</h1>
        <p>This demo is connected to a PayPal sandbox account. Enter the access code you were given.</p>
        <label className="field">
          <span>Access code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" />
        </label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn full" disabled={busy || !code}>{busy ? "Checking" : "Open the demo"}</button>
      </form>
    </main>
  );
}
