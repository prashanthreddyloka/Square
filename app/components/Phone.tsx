"use client";

import { useEffect, useRef, useState } from "react";
import { money, other } from "../../lib/ledger";
import type { UserId } from "../../lib/types";
import type { AppState, ChatLine, PublicNegotiation } from "./types";

type Tab = "chat" | "ledger" | "rules";

export function Phone(props: {
  me: UserId;
  state: AppState;
  chat: ChatLine[];
  pending: PublicNegotiation | null;
  busy: boolean;
  onSend: (text: string, image?: string) => Promise<void>;
  onDecide: (n: PublicNegotiation, d: "approved" | "declined") => Promise<void>;
  onConnect: () => Promise<void>;
  onSavePolicy: (p: { autoApproveMax: number; weeklyCap: number; instructions: string; memory: string[] }) => Promise<void>;
}) {
  const { me, state } = props;
  const user = state.users[me];
  const friend = state.users[other(me)];
  const bal = state.balances[me];
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <section className="phone" aria-label={`${user.name}'s phone`} style={{ ["--accent" as string]: user.color }}>
      <div className="screen">
        <div className="notch"><span /></div>
        <header className="ph-head">
          <div className="avatar" style={{ background: user.color }} aria-hidden>{user.name[0]}</div>
          <div className="ph-who">
            <strong>{user.name}</strong>
            <span>
              {user.paypal.status === "linked" ? "Agent connected to PayPal" : "Agent not connected to PayPal yet"}
            </span>
          </div>
        </header>
        <div className="balance">
          <div className="lbl">
            {bal.direction === "even"
              ? `You and ${friend.name} are`
              : bal.direction === "invoiced"
                ? `${bal.label}, waiting on PayPal`
                : bal.direction === "owe"
                  ? `You owe ${friend.name}`
                  : `${friend.name} owes you`}
          </div>
          <div className={`amt ${bal.direction}`}>{bal.direction === "even" ? "All square" : money(bal.amount)}</div>
        </div>
        <nav className="tabs" role="tablist">
          {(["chat", "ledger", "rules"] as Tab[]).map((t) => (
            <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "chat" ? "Agent" : t === "ledger" ? "Shared expenses" : "Rules"}
            </button>
          ))}
        </nav>
        {tab === "chat" && <ChatTab {...props} />}
        {tab === "ledger" && <LedgerTab me={me} state={state} />}
        {tab === "rules" && <RulesTab {...props} />}
      </div>
    </section>
  );
}

function ChatTab({ me, state, chat, pending, busy, onSend, onDecide }: Parameters<typeof Phone>[0]) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const friend = state.users[other(me)];
  const awaitingMe = pending && pending.approval?.userId === me;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length, awaitingMe]);

  async function submit(t: string, image?: string) {
    if (!t.trim() && !image) return;
    setSending(true);
    setText("");
    try {
      await onSend(t.trim(), image);
    } finally {
      setSending(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    shrink(f).then((dataUrl) => submit(text || `Here's the receipt, split it with ${friend.name}.`, dataUrl));
  }

  const hints = me === "alex"
    ? [`I paid $18 for coffee and pastries`, `${friend.name} paid $40 for the museum`]
    : [`I paid $30 for tapas`, `I paid $22 for the train to Sintra`];

  return (
    <>
      <div className="ph-body" ref={bodyRef}>
        {chat.map((c, i) => (
          <div key={i} className={`bubble ${c.role}`}>
            {c.image && <img src={c.image} alt="Receipt you sent" />}
            {c.text}
          </div>
        ))}
        {awaitingMe && pending && <ApprovalCard n={pending} me={me} state={state} busy={busy} onDecide={onDecide} />}
        {chat.length <= 1 && (
          <div className="hints" aria-label="Try saying">
            {hints.map((h) => (
              <button key={h} className="hint" onClick={() => submit(h)} disabled={sending}>{h}</button>
            ))}
          </div>
        )}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
        <button type="button" className="icon-btn" aria-label="Attach a receipt photo" onClick={() => fileRef.current?.click()} disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>
        </button>
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Tell your agent what you paid for`} aria-label="Message your agent" disabled={sending} />
        <button className="icon-btn send" aria-label="Send" disabled={sending || !text.trim()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    </>
  );
}

function ApprovalCard({ n, me, state, busy, onDecide }: { n: PublicNegotiation; me: UserId; state: AppState; busy: boolean; onDecide: (n: PublicNegotiation, d: "approved" | "declined") => Promise<void> }) {
  const friend = state.users[other(me)];
  return (
    <div className="approve" role="group" aria-label="Payment waiting for your approval">
      <h3>Send {money(n.agreedAmount)} to {friend.name}?</h3>
      <p>{n.approval?.reason} Your agents agreed on this together.</p>
      <ul>
        <li><span>{friend.name}&rsquo;s opening statement</span><span>{money(n.initialTotal)}</span></li>
        {n.disputes.map((d) => (
          <li key={d.itemId}>
            <span>{d.accepted ? <s>{d.itemLabel}</s> : d.itemLabel}</span>
            <span>{d.accepted ? "removed" : "kept"}</span>
          </li>
        ))}
        <li><strong>Agreed</strong><strong>{money(n.agreedAmount)}</strong></li>
      </ul>
      <div className="row">
        <button className="btn full" onClick={() => onDecide(n, "approved")} disabled={busy}>Approve and pay</button>
        <button className="btn secondary" onClick={() => onDecide(n, "declined")} disabled={busy}>Not now</button>
      </div>
    </div>
  );
}

function LedgerTab({ me, state }: { me: UserId; state: AppState }) {
  const open = state.expenses.filter((e) => !e.settledIn);
  const settled = state.expenses.filter((e) => e.settledIn);
  const name = (u: UserId) => (u === me ? "You" : state.users[u].name);
  const Exp = ({ e }: { e: (typeof open)[number] }) => (
    <div className="exp">
      <div className="exp-top">
        <span>{e.description}</span>
        <span>{money(e.items.reduce((s, i) => s + i.amount, 0))}</span>
      </div>
      <div className="exp-meta">{name(e.paidBy)} paid, {e.source === "receipt" ? "from a receipt" : e.source === "chat" ? "added by chat" : e.date}</div>
      {e.items.length > 1 && (
        <ul className="exp-items">
          {e.items.map((i) => (
            <li key={i.id}>
              <span>{i.label} <span className="who">{i.sharedBy.length === 2 ? "shared" : `${name(i.sharedBy[0])} only`}</span></span>
              <span>{money(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="ph-body">
      {open.length === 0 && <div className="bubble note">Nothing open. Tell your agent about the next thing you pay for.</div>}
      {open.map((e) => <Exp key={e.id} e={e} />)}
      {settled.length > 0 && (
        <div className="settled">
          <div className="section-label">Settled</div>
          {settled.map((e) => <Exp key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
}

function RulesTab({ me, state, busy, onConnect, onSavePolicy }: Parameters<typeof Phone>[0]) {
  const user = state.users[me];
  const [a, setA] = useState(String(user.policy.autoApproveMax));
  const [w, setW] = useState(String(user.policy.weeklyCap));
  const [ins, setIns] = useState(user.policy.instructions);
  const [mem, setMem] = useState(user.policy.memory.join("\n"));
  const [saved, setSaved] = useState(false);
  const pp = user.paypal;

  return (
    <div className="ph-body">
      <div className="pp-card">
        {pp.status === "linked" ? (
          <>
            <strong className="ok">PayPal allowance approved</strong>
            Your agent can pay friends from {pp.payerEmail} within the limits below.
            <div><code>allowance {pp.allowanceRef}, payer {pp.payerRef}</code></div>
          </>
        ) : (
          <>
            <strong>Connect PayPal</strong>
            Approve once in PayPal so your agent can settle up for you. You can still negotiate without it; friends will get an invoice instead.
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={onConnect} disabled={busy}>Connect PayPal</button>
            </div>
          </>
        )}
      </div>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          await onSavePolicy({ autoApproveMax: Number(a), weeklyCap: Number(w), instructions: ins, memory: mem.split("\n") });
          setSaved(true);
          setTimeout(() => setSaved(false), 1800);
        }}
      >
        <label className="field">
          <span>Pay without asking up to <small>per settle-up</small></span>
          <div className="money-input"><input inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} /></div>
        </label>
        <label className="field">
          <span>Never send more than <small>per week</small></span>
          <div className="money-input"><input inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} /></div>
        </label>
        <label className="field">
          <span>How your agent should negotiate</span>
          <textarea rows={4} value={ins} onChange={(e) => setIns(e.target.value)} />
        </label>
        <label className="field">
          <span>What your agent knows about you <small>one per line</small></span>
          <textarea rows={3} value={mem} onChange={(e) => setMem(e.target.value)} />
        </label>
        <button className="btn" disabled={busy}>{saved ? "Rules saved" : "Save rules"}</button>
      </form>
    </div>
  );
}

/** Phone photos are large; scale receipts down to 1600px JPEG before sending them to the agent. */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("That file isn't an image I can read."));
    img.src = url;
  });
}
