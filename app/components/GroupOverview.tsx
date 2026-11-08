"use client";

import { useState } from "react";
import { money } from "../../lib/ledger";
import type { UserId } from "../../lib/types";
import type { AppState, PairBalance } from "./types";

const STATUS: Record<string, string> = {
  negotiating: "agents talking",
  awaiting_approval: "waiting on approval",
  awaiting_payer: "waiting on PayPal",
  settling: "settling",
  payout_pending: "payout pending",
  payout_failed: "payout needs a retry",
  unverified: "checking PayPal",
  failed: "needs a retry",
};

export const ALL = "all";

type Row = { key: string; a: UserId; b: UserId; debtor: UserId; creditor: UserId; total: number };

/**
 * Everyone's position, across all groups or inside one. Settle-ups are always between two people
 * and cover every group they share, so picking a pair opens their two phones.
 */
export function GroupOverview({ state, group, onGroup, onOpen }: { state: AppState; group: string; onGroup: (g: string) => void; onOpen: (a: UserId, b: UserId) => void }) {
  const [focus, setFocus] = useState<UserId | null>(null);
  const g = state.groups.find((x) => x.id === group) ?? null;
  const ids = g ? g.members : Object.keys(state.users);
  const totals = g ? g.totals : state.members;
  const rows: Row[] = g ? g.pairs : state.pairs;
  const owing = rows.filter((p) => p.total > 0);
  const overall = (key: string) => state.pairs.find((p) => p.key === key)!;
  const shown = focus ? rows.filter((p) => p.a === focus || p.b === focus) : rows.filter((p) => p.total > 0 || overall(p.key).active || (!g && overall(p.key).invoiced > 0));
  const toSettle = owing.reduce((s, p) => s + p.total, 0);
  const pick = (id: string) => {
    setFocus(null);
    onGroup(id);
  };

  return (
    <section className="group" aria-label="Groups">
      <nav className="group-tabs" role="tablist" aria-label="Groups">
        <button role="tab" aria-selected={!g} className="gtab" onClick={() => pick(ALL)}>All groups</button>
        {state.groups.map((x) => (
          <button key={x.id} role="tab" aria-selected={group === x.id} className="gtab" onClick={() => pick(x.id)}>
            {x.name}
            <span className="gtab-faces" aria-hidden>
              {x.members.map((m) => <span key={m} style={{ background: state.users[m].color }} />)}
            </span>
          </button>
        ))}
      </nav>

      <div className="group-head">
        <h2>{g ? g.name : "Everyone you share money with"}</h2>
        <p>
          {g
            ? `${g.members.map((m) => state.users[m].name).join(", ")}. ${g.expenseCount} expenses. ${toSettle > 0 ? `${money(toSettle)} open in this group.` : "Nothing open in this group."}`
            : `${state.groups.length} groups, ${state.expenses.length} expenses. ${toSettle > 0 ? `${money(toSettle)} to settle across ${owing.length} pairs.` : "Everyone is square."}`}{" "}
          When two people settle, their agents cover every group they share in one PayPal payment.
        </p>
      </div>

      <div className="members" role="list">
        {ids.map((id) => {
          const u = state.users[id];
          const m = totals[id];
          const selected = focus === id;
          const n = rows.filter((p) => p.total > 0 && (p.a === id || p.b === id)).length;
          return (
            <button
              key={id}
              role="listitem"
              className={`member ${selected ? "selected" : ""}`}
              style={{ ["--accent" as string]: u.color }}
              aria-pressed={selected}
              onClick={() => setFocus(selected ? null : id)}
            >
              <span className="avatar" style={{ background: u.color }} aria-hidden>{u.name[0]}</span>
              <span className="m-name">{u.name}</span>
              <span className={`m-net ${m.net > 0 ? "owed" : m.net < 0 ? "owe" : "even"}`}>
                {m.net > 0 ? `is owed ${money(m.net)}` : m.net < 0 ? `owes ${money(-m.net)}` : "all square"}
              </span>
              <span className="m-sub">
                {m.owes > 0 && m.owed > 0 ? `owes ${money(m.owes)}, owed ${money(m.owed)}` : n ? `with ${n} friend${n === 1 ? "" : "s"}` : "nothing open"}
              </span>
              <span className="m-pp">{u.paypal.status === "linked" ? "PayPal allowance set" : "pays per approval"}</span>
            </button>
          );
        })}
      </div>

      <div className="pairs">
        <div className="section-label">
          {focus ? `${state.users[focus].name} with each friend${g ? ` in ${g.name}` : ""}` : "Who owes whom"}
          {focus && <button className="ghost" onClick={() => setFocus(null)}>Show everyone</button>}
        </div>
        {shown.length === 0 && <div className="pair-empty">Nothing open here. Add an expense from any pair and the agents will pick it up.</div>}
        {shown.map((p) => (
          <PairRow key={p.key} row={p} all={overall(p.key)} inGroup={Boolean(g)} state={state} focus={focus} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function PairRow({ row, all, inGroup, state, focus, onOpen }: { row: Row; all: PairBalance; inGroup: boolean; state: AppState; focus: UserId | null; onOpen: (a: UserId, b: UserId) => void }) {
  const name = (u: UserId) => state.users[u].name;
  const gname = (id: string) => state.groups.find((x) => x.id === id)?.name ?? "Other";
  // Keep the focused person on the left phone; otherwise keep the group's order.
  const [left, right] = focus && row.b === focus ? [row.b, row.a] : [row.a, row.b];
  const who = (d: UserId, c: UserId) => (
    <><strong style={{ color: state.users[d].color }}>{name(d)}</strong> owes <strong style={{ color: state.users[c].color }}>{name(c)}</strong></>
  );
  const sameAsOverall = all.total === row.total && (all.debtor === row.debtor || row.total === 0);
  return (
    <button className="pair" onClick={() => onOpen(left, right)} aria-label={`Open ${name(left)} and ${name(right)}`}>
      <span className="pair-faces" aria-hidden>
        <span className="avatar" style={{ background: state.users[left].color }}>{name(left)[0]}</span>
        <span className="avatar" style={{ background: state.users[right].color }}>{name(right)[0]}</span>
      </span>
      <span className="pair-text">
        <span>
          {row.total > 0 ? who(row.debtor, row.creditor) : <><strong>{name(left)}</strong> and <strong>{name(right)}</strong> are {all.invoiced > 0 && !inGroup ? "waiting on a PayPal invoice" : "square here"}</>}
        </span>
        {all.active && <span className="pair-status">{STATUS[all.active] || all.active.replace("_", " ")}</span>}
        {!inGroup && all.byGroup.length > 1 && (
          <span className="pair-groups">
            {all.byGroup.map((x) => (
              <span key={x.group} title={x.amount < 0 ? `${name(all.creditor)} owes ${name(all.debtor)} in ${gname(x.group)}` : undefined}>
                {gname(x.group)} {x.amount < 0 ? "−" : ""}{money(Math.abs(x.amount))}
              </span>
            ))}
          </span>
        )}
        {inGroup && !sameAsOverall && (
          <span className="pair-groups">
            <span>
              Across all their groups: {all.total > 0 ? <>{name(all.debtor)} owes {money(all.total)}</> : "all square"}
            </span>
          </span>
        )}
      </span>
      <span className="pair-amt">{row.total > 0 ? money(row.total) : !inGroup && all.invoiced > 0 ? money(all.invoiced) : ""}</span>
      <span className="pair-go" aria-hidden>Open</span>
    </button>
  );
}
