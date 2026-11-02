import type { publicState } from "../../lib/view";

export type AppState = ReturnType<typeof publicState> & {
  modes: { paypal: "live" | "demo"; ai: "claude" | "openai" | "demo" };
};
export type PublicNegotiation = AppState["negotiations"][number];
export type Balance = AppState["balances"]["alex"];

export type ChatLine = { role: "me" | "agent" | "note"; text: string; image?: string };
