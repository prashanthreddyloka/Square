import crypto from "node:crypto";
import type { AgentMessage, User, UserId } from "./types";

const ROOT = process.env.SQUARE_SIGNING_SECRET || "square-dev-signing-secret-change-me";

// Each agent gets its own passport key, derived from the server root key.
function agentKey(agent: UserId | "square") {
  return crypto.createHmac("sha256", ROOT).update(`agent:${agent}`).digest();
}

export function sha256(v: unknown) {
  return crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
}

export function sign(agent: UserId | "square", payload: unknown) {
  return crypto.createHmac("sha256", agentKey(agent)).update(JSON.stringify(payload)).digest("hex");
}

export function verify(agent: UserId | "square", payload: unknown, sig: string) {
  const expected = sign(agent, payload);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function signMessage(m: Omit<AgentMessage, "sig">): AgentMessage {
  return { ...m, sig: sign(m.from, { type: m.type, text: m.text, data: m.data ?? null, ts: m.ts }) };
}

export function verifyMessage(m: AgentMessage) {
  if (!m.sig) return false;
  return verify(m.from, { type: m.type, text: m.text, data: m.data ?? null, ts: m.ts }, m.sig);
}

/**
 * An agent credential is what one agent shows another before money moves.
 * It is issued and signed by Square (not by PayPal). It binds the agent to PayPal account
 * information Square received when the human approved an allowance through PayPal
 * (the payer ID on the vaulted payment token), and to a hash of the human's current rules.
 * A production system would anchor this in a standard such as AP2 mandates.
 */
export interface TrustCard {
  issuer: "square";
  agent: string;
  human: string;
  paypalLinked: boolean; // the human approved an allowance through PayPal and Square holds the resulting token
  payerRef: string | null; // masked PayPal payer ID
  canPay: boolean; // has a vaulted PayPal allowance
  policyHash: string;
  issuedAt: string;
  sig: string;
}

export function issueTrustCard(user: User): TrustCard {
  const body = {
    issuer: "square" as const,
    agent: `square-agent:${user.id}`,
    human: user.name,
    paypalLinked: user.paypal.status === "linked",
    payerRef: user.paypal.payerId ? `••••${user.paypal.payerId.slice(-4)}` : null,
    canPay: Boolean(user.paypal.paymentTokenId),
    policyHash: sha256(user.policy).slice(0, 16),
    issuedAt: new Date().toISOString(),
  };
  return { ...body, sig: sign("square", body) };
}

export function checkTrustCard(card: TrustCard) {
  const { sig, ...body } = card;
  return verify("square", body, sig);
}
