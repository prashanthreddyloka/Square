import type { DB, PayPalLink } from "./types";

/**
 * On a hosted demo the disk can be wiped on restart, and visitors don't have sandbox logins.
 * If an allowance was approved once, its vault token can be pinned in env vars so the
 * agent starts connected: ALEX_VAULT_TOKEN, ALEX_PAYER_ID (and the same for MAYA_).
 */
function pinnedLink(prefix: "ALEX" | "MAYA", email: string): PayPalLink {
  const token = process.env[`${prefix}_VAULT_TOKEN`];
  if (!token) return { status: "unlinked" };
  return {
    status: "linked",
    paymentTokenId: token,
    payerId: process.env[`${prefix}_PAYER_ID`] || "",
    payerEmail: email,
    linkedAt: new Date().toISOString(),
    mode: "live",
  };
}

// A long weekend in Lisbon. Maya fronted the big costs, Alex covered a few small ones.
export function seedDB(): DB {
  return {
    users: {
      alex: {
        id: "alex",
        name: "Alex",
        sandboxEmail: process.env.ALEX_SANDBOX_EMAIL || "alex@personal.example.com",
        color: "#2F5BEA",
        paypal: pinnedLink("ALEX", process.env.ALEX_SANDBOX_EMAIL || "alex@personal.example.com"),
        policy: {
          autoApproveMax: 150,
          weeklyCap: 500,
          instructions:
            "Only pay for what I actually used. Dispute anything I didn't consume. Be friendly, Maya is my best friend. Ask me before sending more than my auto-approve limit.",
          memory: [
            "Alex doesn't drink alcohol.",
            "Alex left the fado show at intermission because he felt sick.",
          ],
        },
      },
      maya: {
        id: "maya",
        name: "Maya",
        sandboxEmail: process.env.MAYA_SANDBOX_EMAIL || "maya@personal.example.com",
        color: "#7B4BD1",
        paypal: pinnedLink("MAYA", process.env.MAYA_SANDBOX_EMAIL || "maya@personal.example.com"),
        policy: {
          autoApproveMax: 100,
          weeklyCap: 400,
          instructions:
            "Happy to drop anything the other person genuinely didn't have, like food or drinks. Don't drop shared bookings such as rent, tickets or rides: those were bought for both of us whether or not they got used.",
          memory: ["Maya booked the Airbnb and the fado tickets for both of them."],
        },
      },
    },
    expenses: [
      {
        id: "exp_airbnb",
        description: "Airbnb in Alfama, 3 nights",
        paidBy: "maya",
        date: "2026-10-23",
        source: "seed",
        items: [{ id: "i_airbnb", label: "Apartment, 3 nights", amount: 424, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_dinner",
        description: "Dinner at Taberna da Rua",
        paidBy: "maya",
        date: "2026-10-24",
        source: "seed",
        items: [
          { id: "i_petiscos", label: "Bacalhau and petiscos", amount: 52, kind: "consumable", sharedBy: ["alex", "maya"] },
          { id: "i_wine", label: "Bottle of vinho verde", amount: 24, kind: "consumable", sharedBy: ["alex", "maya"] },
          { id: "i_nata", label: "Pastéis de nata", amount: 10, kind: "consumable", sharedBy: ["alex", "maya"] },
        ],
      },
      {
        id: "exp_fado",
        description: "Fado show tickets",
        paidBy: "maya",
        date: "2026-10-24",
        source: "seed",
        items: [{ id: "i_fado", label: "2 tickets, Clube de Fado", amount: 60, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_groceries",
        description: "Groceries at Pingo Doce",
        paidBy: "alex",
        date: "2026-10-23",
        source: "seed",
        items: [{ id: "i_groceries", label: "Breakfast groceries", amount: 38, kind: "consumable", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_ride",
        description: "Ride to the airport",
        paidBy: "alex",
        date: "2026-10-26",
        source: "seed",
        items: [{ id: "i_ride", label: "Ride to LIS", amount: 26, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
    ],
    negotiations: [],
    webhookEvents: [],
  };
}
