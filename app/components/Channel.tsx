"use client";

import { money } from "../../lib/ledger";
import type { AgentMessage, UserId } from "../../lib/types";
import type { AppState, PublicNegotiation } from "./types";

const KIND: Record<AgentMessage["type"], string> = {
  HELLO: "handshake",
  VERIFY: "credential check",
  PROPOSE: "statement",
  DISPUTE: "dispute",
  RULING: "ruling",
  AGREE: "agreement",
  ESCALATE: "needs approval",
  APPROVED: "approved",
  DECLINED: "declined",
  SETTLE: "payment step",
  CONFIRM: "payment verified",
  INVOICE: "invoice sent",
  PENDING: "not settled yet",
  ERROR: "problem",
};

const kindClass = (t: AgentMessage["type"]) =>
  t === "DISPUTE" || t === "DECLINED" || t === "ERROR"
    ? "kind-dispute"
    : t === "AGREE" || t === "CONFIRM" || t === "SETTLE" || t === "APPROVED"
      ? "kind-agree"
      : t === "ESCALATE" || t === "PENDING"
        ? "kind-escalate"
        : "";

export function Channel(props: {
  state: AppState;
  pair: [UserId, UserId];
  current: PublicNegotiation | null;
  reveal: number;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onRetry: (n: PublicNegotiation) => void;
}) {
  const { state, pair, current, reveal, busy, error, onStart, onRetry } = props;
  const key = [...pair].sort().join("|");
  const s = state.pairs.find((p) => p.key === key)!;
  const active = state.negotiations.find((n) => n.pair === key && ["negotiating", "awaiting_approval", "awaiting_payer", "settling", "payout_pending", "payout_failed", "unverified", "failed"].includes(n.status));
  const waiting = Boolean(active);
  const shown = current ? current.messages.slice(0, reveal) : [];
  const done = current && reveal >= current.messages.length;
  const left: UserId = pair[0];
  const name = (u: AgentMessage["from"]) => (u === "square" ? "Square" : `${state.users[u].name}'s agent`);
  const earlier = state.negotiations.filter((n) => n.pair === key && n.id !== current?.id && (n.status === "settled" || n.status === "invoiced"));

  return (
    <section className="channel" aria-label="Agent channel">
      <div className="channel-head">
        <div>
          <h2>Between the agents</h2>
          <p>
            {s.total > 0
              ? `${state.users[s.debtor].name} owes ${state.users[s.creditor].name} ${money(s.total)} before any questions. Their agents will check every line, settle on PayPal, and only ask when a rule says to.`
              : `Nothing open between ${state.users[pair[0]].name} and ${state.users[pair[1]].name}. Add an expense on either phone and the agents will take it from there.`}
          </p>
        </div>
        <button className="go" onClick={onStart} disabled={busy || waiting || s.total === 0}>
          {busy ? "Agents talking" : active?.status === "awaiting_approval" ? "Waiting on approval" : waiting ? "Finish the open settle-up" : "Let our agents settle up"}
        </button>
      </div>

      {error && <div className="err" role="alert">{error}</div>}

      <div className="tape" aria-live="polite">
        {!current && (
          <div className="tape-empty">
            <strong>No settle-ups yet</strong>
            When you start one, every message the two agents exchange prints here, signed, so you can see exactly how they got to the number.
          </div>
        )}
        {shown.map((m) => (
          <Entry key={m.id} m={m} state={state} color={m.from === "square" ? undefined : state.users[m.from].color} align={m.from === "square" ? "center" : m.from === left ? "left" : "right"} name={name(m.from)} />
        ))}
        {done && current?.status === "settled" && current.settlement && <ReceiptBlock n={current} state={state} />}
      </div>

      {done && current?.retryable && (
        <div className="retry" role="status">
          <p>
            {current.status === "payout_pending"
              ? `PayPal hasn't confirmed the payout to ${state.users[current.creditor].name} yet. The expenses stay open until it does.`
              : current.status === "failed"
                ? "Nothing was charged. You can try the settlement again."
                : `${state.users[current.debtor].name} was charged once. Retrying never charges again; it only finishes the payout and the check.`}
          </p>
          <button className="btn" onClick={() => onRetry(current)} disabled={busy}>
            {current.status === "payout_pending" ? "Check PayPal again" : "Retry settlement"}
          </button>
        </div>
      )}

      {earlier.length > 0 && (
        <details className="history">
          <summary>Earlier settle-ups</summary>
          <ul>
            {earlier.map((n) => (
              <li key={n.id}>
                {n.status === "invoiced"
                  ? `${state.users[n.creditor].name} invoiced ${state.users[n.debtor].name} ${money(n.agreedAmount)} through PayPal`
                  : `${state.users[n.debtor].name} paid ${state.users[n.creditor].name} ${money(n.agreedAmount)} on ${new Date(n.settlement!.settledAt).toLocaleDateString()}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.webhookEvents.length > 0 && (
        <details className="history">
          <summary>PayPal webhook events</summary>
          <ul>
            {state.webhookEvents.slice(0, 8).map((e) => (
              <li key={e.id}>{e.type}{e.summary ? `: ${e.summary}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Entry({ m, state, align, name, color }: { m: AgentMessage; state: AppState; align: "left" | "right" | "center"; name: string; color?: string }) {
  const d = (m.data || {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <div className={`entry ${m.from} ${align === "right" ? "right" : ""} ${kindClass(m.type)}`} style={color ? { ["--who" as string]: color } : undefined}>
      <div className="entry-head">
        <span><span className="from">{name}</span> <span className="kind">{KIND[m.type]}</span></span>
        <span className="sig" title={m.sig}>{m.sig ? `signed ${m.sig.slice(0, 8)}` : ""}</span>
      </div>
      <div className="entry-text">{m.text}</div>

      {m.type === "HELLO" && d.trustCard && (
        <div className="ids">
          Issued by Square; PayPal allowance {d.trustCard.paypalLinked ? `linked (payer ${d.trustCard.payerRef})` : "not linked"}; rules hash {d.trustCard.policyHash}
        </div>
      )}

      {m.type === "VERIFY" && (
        <ul className="checks">
          <li className={d.creditorCardValid && d.debtorCardValid ? "" : "bad"}>credentials signed by Square</li>
          <li className={d.debtorPayPalLinked ? "" : "bad"}>payer approved a PayPal allowance</li>
          <li className={d.debtorCanPay ? "" : "bad"}>payer has an agent allowance</li>
        </ul>
      )}

      {m.type === "PROPOSE" && Array.isArray(d.lines) && (
        <table className="lines">
          <tbody>
            {d.lines.map((l: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
              const multi = new Set(d.lines.map((x: any) => x.group)).size > 1; // eslint-disable-line @typescript-eslint/no-explicit-any
              const head = multi && (i === 0 || d.lines[i - 1].group !== l.group);
              return [
                head && (
                  <tr key={`g-${l.group}-${i}`} className="group-row"><td colSpan={2}>{state.groups.find((g) => g.id === l.group)?.name ?? "Other"}</td></tr>
                ),
                <tr key={l.itemId} className={l.signed < 0 ? "credit" : ""}>
                  <td>{l.label}</td>
                  <td className="amt">{l.signed < 0 ? `−${money(-l.signed)}` : money(l.signed)}</td>
                </tr>,
              ];
            })}
            <tr className="total"><td>Owed</td><td className="amt">{money(d.total)}</td></tr>
          </tbody>
        </table>
      )}

      {m.type === "DISPUTE" && Array.isArray(d.disputes) && (
        <table className="lines">
          <tbody>
            {d.disputes.map((x: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
              <tr key={x.itemId}><td><strong>{x.itemLabel}</strong>: {x.reason}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {m.type === "RULING" && Array.isArray(d.rulings) && (
        <table className="lines">
          <tbody>
            {d.rulings.map((x: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
              <tr key={x.itemId}>
                <td>
                  <span className={x.accepted ? "struck" : ""}>{x.itemLabel}</span>: {x.why}
                  {x.check === "replaced" && <span className="checknote"> (rewritten by Square to match the decision)</span>}
                </td>
                <td className={`amt ${x.accepted ? "tag-removed" : "tag-kept"}`}>{x.accepted ? "removed" : "kept"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {m.type === "AGREE" && typeof d.amount === "number" && (
        <div className="ids">agreed {money(d.amount)}; agreement {d.agreementHash}</div>
      )}

      {m.type === "SETTLE" && (
        <div className="ids">
          {d.orderId ? `PayPal order ${d.orderId}; capture ${d.captureId}` : `PayPal payout batch ${d.payoutBatchId} (${String(d.payoutStatus || "").toLowerCase()})`}
        </div>
      )}

      {m.type === "CONFIRM" && Array.isArray(d.toolCalls) && (
        <div className="ids">
          {d.verified ? "verified" : "not verified"}: order {String(d.orderStatus || "").toLowerCase()}{d.amount ? ` for $${d.amount}` : ""}; checked with PayPal Agent Toolkit: {d.toolCalls.map((c: any) => `${c.name}(${Object.values(c.input || {}).join(", ")})`).join(", ")} {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
        </div>
      )}

      {m.type === "PENDING" && (
        <div className="ids">PayPal payout batch {d.payoutBatchId}: {String(d.payoutStatus || "").toLowerCase()}</div>
      )}

      {m.type === "INVOICE" && (
        <div className="ids">
          PayPal invoice {d.invoiceId} sent with the PayPal Agent Toolkit{d.url ? <>; <a href={d.url} target="_blank" rel="noreferrer">view invoice</a></> : null}
        </div>
      )}
    </div>
  );
}

function ReceiptBlock({ n, state }: { n: PublicNegotiation; state: AppState }) {
  const s = n.settlement!;
  return (
    <div className="receipt">
      <div className="stamp">Settled</div>
      <div>{state.users[n.debtor].name} paid {state.users[n.creditor].name}</div>
      <div className="big">{money(s.amount)}</div>
      <div className="small">
        PayPal {s.mode === "live" ? "sandbox" : "demo"} order {s.orderId}
        <br />receipt {s.receipt.id}; ledger {s.receipt.ledgerHash}; agreement {s.receipt.agreementHash}
        <br />signed {s.receipt.sig.slice(0, 24)}
      </div>
    </div>
  );
}
