"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { money } from "../lib/ledger";
import type { UserId } from "../lib/types";
import { Channel } from "./components/Channel";
import { ALL, GroupOverview } from "./components/GroupOverview";
import { Phone } from "./components/Phone";
import type { AppState, ChatLine, PublicNegotiation } from "./components/types";

const STEP_MS = 750;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j as T;
}

type Pair = [UserId, UserId];
const chatKey = (me: UserId, friend: UserId) => `${me}>${friend}`;
const LAST_PAIR = "square.pair";

const greeting = (name: string, friend: string): ChatLine => ({
  role: "agent",
  text: `Hi ${name}. Tell me what you pay for, or send a receipt photo, and I'll keep track of what ${friend} owes and settle up when it makes sense.`,
});

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  // null shows the group; a pair shows those two people's phones and their agents' channel.
  const [view, setView] = useState<Pair | null>(null);
  const [group, setGroup] = useState<string>(ALL);
  const [chats, setChats] = useState<Record<string, ChatLine[]>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const s = await api<AppState>("/api/state");
    setState(s);
    return s;
  }, []);

  const openPair = useCallback((pair: Pair | null, s?: AppState | null) => {
    setView(pair);
    try {
      if (pair) sessionStorage.setItem(LAST_PAIR, pair.join(","));
      else sessionStorage.removeItem(LAST_PAIR);
    } catch {
      // storage can be unavailable; the deep link still works
    }
    const q = new URLSearchParams(window.location.search);
    if (pair) q.set("pair", pair.join(","));
    else q.delete("pair");
    const qs = q.toString();
    window.history.replaceState({}, "", qs ? `/?${qs}` : "/");
    if (!pair || !s) return;
    const key = [...pair].sort().join("|");
    const latest = s.negotiations.find((n) => n.pair === key);
    setCurrentId(latest?.id ?? null);
    setReveal(latest ? latest.messages.length : 0);
    setChats((ch) => {
      const next = { ...ch };
      const [a, b] = pair;
      next[chatKey(a, b)] ??= [greeting(s.users[a].name, s.users[b].name)];
      next[chatKey(b, a)] ??= [greeting(s.users[b].name, s.users[a].name)];
      return next;
    });
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const linked = q.get("linked");
    const paid = q.get("paid");
    refresh().then((s) => {
      // ?pair=alex,maya opens that pair directly; coming back from PayPal reopens the pair you left.
      let pairParam = q.get("pair");
      if (!pairParam && (linked || paid)) {
        try {
          pairParam = sessionStorage.getItem(LAST_PAIR);
        } catch {
          pairParam = null;
        }
      }
      const pair = pairParam?.split(",").filter((u) => s.users[u]);
      openPair(pair && pair.length === 2 && pair[0] !== pair[1] ? (pair as Pair) : null, s);
    });
    if (linked && linked !== "cancelled" && linked !== "error") setBanner(`${linked.charAt(0).toUpperCase() + linked.slice(1)}'s agent is now connected to PayPal.`);
    else if (linked === "cancelled") setBanner("PayPal connection cancelled. Nothing was saved.");
    else if (linked === "error") setBanner(`PayPal connection failed: ${q.get("reason") || "try again."}`);
    if (paid === "settled") setBanner("Paid in PayPal. The agents finished the settle-up.");
    else if (paid === "cancelled") setBanner("PayPal payment cancelled. Nothing was charged.");
    else if (paid === "error") setBanner(`PayPal payment didn't complete: ${q.get("reason") || "try again."}`);
    else if (paid) setBanner(`Paid in PayPal. Settle-up status: ${paid.replace("_", " ")}.`);
    if (linked || paid) {
      q.delete("linked");
      q.delete("paid");
      q.delete("reason");
      window.history.replaceState({}, "", q.toString() ? `/?${q}` : "/");
    }
  }, [refresh, openPair]);

  const current: PublicNegotiation | null = state?.negotiations.find((n) => n.id === currentId) ?? null;
  const msgCount = useRef(0);
  msgCount.current = current?.messages.length ?? 0;

  // Presenter mode (?present=1): the tape advances one message per → key press, for live demos and recordings.
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("present")) return;
    setPresent(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setReveal((r) => Math.min(r + 1, msgCount.current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the newest printed message in view.
  useEffect(() => {
    if (!current || reveal === 0) return;
    const entries = document.querySelectorAll(".tape .entry, .tape .receipt");
    entries[entries.length - 1]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [reveal, current]);

  // Print the agents' messages onto the tape one at a time.
  useEffect(() => {
    if (!current || present) return;
    if (timer.current) clearInterval(timer.current);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setReveal(current.messages.length);
      return;
    }
    timer.current = setInterval(() => {
      setReveal((r) => {
        if (r >= current.messages.length) {
          if (timer.current) clearInterval(timer.current);
          return r;
        }
        return r + 1;
      });
    }, STEP_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [current?.id, current?.messages.length, present]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealed = current ? reveal >= current.messages.length : true;
  const pending = current?.status === "awaiting_approval" && revealed ? current : null;
  const viewKey = view ? [...view].sort().join("|") : "";

  // When a settle-up finishes printing, each human hears about it from their own agent.
  const announced = useRef<string>("");
  useEffect(() => {
    if (!current || !state || !revealed || current.pair !== viewKey) return;
    const key = `${current.id}:${current.status}`;
    if (announced.current === key) return;
    announced.current = key;
    const d = state.users[current.debtor].name;
    const c = state.users[current.creditor].name;
    const amt = money(current.agreedAmount);
    const removed = current.disputes.filter((x) => x.accepted).map((x) => x.itemLabel);
    const kept = current.disputes.filter((x) => !x.accepted).map((x) => x.itemLabel);
    const adj = [removed.length ? `took off “${removed.join("” and “")}”` : "", kept.length ? `kept “${kept.join("” and “")}”` : ""].filter(Boolean).join(", and ");
    const add = (u: UserId, text: string) => {
      const k = chatKey(u, u === current.debtor ? current.creditor : current.debtor);
      setChats((ch) => ({ ...ch, [k]: [...(ch[k] || []), { role: "agent", text }] }));
    };
    if (current.status === "awaiting_approval") {
      add(
        current.debtor,
        current.approval?.mode === "checkout"
          ? `${c}'s agent and I agreed on ${amt}${adj ? ` (we ${adj})` : ""}. Approve it in PayPal and I'll take it from there.`
          : `${c}'s agent and I agreed on ${amt}${adj ? ` (we ${adj})` : ""}. It's above your limit, so I need your OK.`,
      );
      add(current.creditor, `I've agreed ${amt} with ${d}'s agent. Waiting for ${d} to approve.`);
    } else if (current.status === "settled") {
      add(current.debtor, `Done. Paid ${c} ${amt} through PayPal${adj ? `; we ${adj}` : ""}.`);
      add(current.creditor, `${d} paid you ${amt}. I checked PayPal myself before marking it settled.`);
    } else if (current.status === "invoiced") {
      add(current.creditor, `${d} hasn't connected PayPal, so I sent an itemized PayPal invoice for ${amt}.`);
      add(current.debtor, `${c}'s agent sent you a PayPal invoice for ${amt}. Connect PayPal under Rules and I can handle these for you next time.`);
    } else if (current.status === "declined") {
      add(current.creditor, `${d} declined the ${amt} settle-up for now. The expenses stay open.`);
    } else if (current.status === "payout_pending") {
      add(current.debtor, `PayPal took the ${amt} from your allowance, but hasn't confirmed ${c} received it yet. I'll only call it settled once it does.`);
    } else if (current.status === "payout_failed" || current.status === "unverified") {
      add(current.debtor, `The payment to ${c} didn't go through cleanly. You were charged once; retrying won't charge you again.`);
    } else if (current.status === "failed") {
      add(current.debtor, `PayPal didn't complete the charge, so nothing was taken.`);
    }
  }, [current, state, revealed, viewKey]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const startSettle = () =>
    run(async () => {
      if (!view) return;
      const n = await api<PublicNegotiation>("/api/negotiate", { a: view[0], b: view[1] });
      await refresh();
      setReveal(0);
      setCurrentId(n.id);
    });

  const retry = (n: PublicNegotiation) =>
    run(async () => {
      await api("/api/retry", { negotiationId: n.id });
      await refresh();
    });

  const checkout = (n: PublicNegotiation) =>
    run(async () => {
      const r = await api<{ approveUrl: string }>("/api/checkout", { negotiationId: n.id });
      window.location.href = r.approveUrl;
    }) as Promise<void>;

  const decide = (n: PublicNegotiation, d: "approved" | "declined") =>
    run(async () => {
      const k = chatKey(n.debtor, n.creditor);
      setChats((ch) => ({ ...ch, [k]: [...(ch[k] || []), { role: "me", text: d === "approved" ? "Approved." : "Not now." }] }));
      await api<PublicNegotiation>("/api/approve", { negotiationId: n.id, decision: d });
      await refresh();
    });

  const send = (u: UserId, friend: UserId) => async (text: string, image?: string) => {
    const k = chatKey(u, friend);
    const say = (line: ChatLine) => setChats((ch) => ({ ...ch, [k]: [...(ch[k] || []), line] }));
    say({ role: "me", text: text || "Receipt", image });
    try {
      const r = await api<{ reply: string }>("/api/expenses", { author: u, friend, text, image, group: group === ALL ? undefined : group });
      say({ role: "agent", text: r.reply });
      await refresh();
    } catch (e) {
      say({ role: "agent", text: (e as Error).message });
    }
  };

  const connect = (u: UserId) => () =>
    run(async () => {
      const r = await api<{ approveUrl: string }>("/api/paypal/connect", { user: u });
      window.location.href = r.approveUrl;
    }) as Promise<void>;

  const savePolicy = (u: UserId) => (p: { autoApproveMax: number; weeklyCap: number; instructions: string; memory: string[] }) =>
    run(async () => {
      await api("/api/policy", { user: u, ...p });
      await refresh();
    }) as Promise<void>;

  const reset = () =>
    run(async () => {
      await api("/api/reset", { keepPayPal: true });
      setCurrentId(null);
      setReveal(0);
      announced.current = "";
      setChats({});
      const s = await refresh();
      openPair(view, s);
    });

  if (!state) return <main className="top"><p className="tagline">Loading Square</p></main>;

  return (
    <main>
      <header className="top">
        <div className="brand">
          <h1 className="wordmark"><span className="glyph" aria-hidden />Square</h1>
          <p className="tagline">Your agent settles up with your friends&rsquo; agents, on PayPal.</p>
        </div>
        <div className="top-right">
          <span className={`chip ${state.modes.paypal === "live" ? "live" : ""}`}>
            <span className="dot" />{state.modes.paypal === "live" ? "PayPal sandbox connected" : "PayPal demo mode"}
          </span>
          <span className={`chip ${state.modes.ai !== "demo" ? "live" : ""}`}>
            <span className="dot" />
            {state.modes.ai === "claude" ? "Agents run on Claude" : state.modes.ai === "openai" ? "Agents run on OpenAI" : "Agents run on built-in rules"}
          </span>
          <button className="ghost" onClick={reset} disabled={busy}>Reset the trip</button>
        </div>
      </header>
      {banner && <div className="banner" role="status"><div>{banner}</div></div>}
      {!view ? (
        <GroupOverview state={state} group={group} onGroup={setGroup} onOpen={(a, b) => openPair([a, b], state)} />
      ) : (
        <>
          <nav className="crumbs" aria-label="Where you are">
            <button className="ghost back" onClick={() => openPair(null)}>&larr; Whole group</button>
            <span>
              <strong style={{ color: state.users[view[0]].color }}>{state.users[view[0]].name}</strong> and{" "}
              <strong style={{ color: state.users[view[1]].color }}>{state.users[view[1]].name}</strong>
              <span className="crumb-note">
                {" "}· settles {state.groups.filter((g) => g.members.includes(view[0]) && g.members.includes(view[1])).map((g) => g.name).join(" + ")} in one payment
              </span>
            </span>
          </nav>
          <div className="stage">
            {[view[0], "channel", view[1]].map((slot, i) =>
              slot === "channel" ? (
                <Channel key="channel" state={state} pair={view} current={current} reveal={reveal} busy={busy} error={error} onStart={startSettle} onRetry={retry} />
              ) : (
                <Phone
                  key={`${slot}-${i}`}
                  me={slot}
                  friend={i === 0 ? view[1] : view[0]}
                  state={state}
                  chat={chats[chatKey(slot, i === 0 ? view[1] : view[0])] || []}
                  pending={pending}
                  busy={busy}
                  onSend={send(slot, i === 0 ? view[1] : view[0])}
                  onDecide={decide}
                  onCheckout={checkout}
                  onConnect={connect(slot)}
                  onSavePolicy={savePolicy(slot)}
                />
              ),
            )}
          </div>
        </>
      )}
    </main>
  );
}
