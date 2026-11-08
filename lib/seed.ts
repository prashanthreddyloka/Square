import type { DB, PayPalLink, User } from "./types";

/**
 * On a hosted demo the disk can be wiped on restart, and visitors don't have sandbox logins.
 * If an allowance was approved once, its vault token can be pinned in env vars so the
 * agent starts connected: ALEX_VAULT_TOKEN, ALEX_PAYER_ID (and the same for MAYA_, SAM_, PRIYA_).
 */
function pinnedLink(prefix: string, email: string): PayPalLink {
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

function member(id: string, name: string, color: string, policy: User["policy"]): User {
  const prefix = id.toUpperCase();
  const email = process.env[`${prefix}_SANDBOX_EMAIL`] || `${id}@personal.example.com`;
  return { id, name, color, sandboxEmail: email, paypal: pinnedLink(prefix, email), policy };
}

/**
 * Four friends, three groups:
 * - Lisbon trip (everyone). Alex and Maya's shared costs are the main story ($253 opening, $241 after disputes).
 * - Apartment 4B (Maya and Priya are roommates): bills over several weeks.
 * - Friday lunches (Alex and Sam, from work).
 * A settle-up between two people covers every group they share, in one PayPal payment.
 */
export const DB_VERSION = 3;

export function seedDB(): DB {
  return {
    version: DB_VERSION,
    users: {
      alex: member("alex", "Alex", "#2F5BEA", {
        autoApproveMax: 150,
        weeklyCap: 500,
        instructions:
          "Only pay for what I actually used. Dispute anything I didn't consume. Be friendly, these are my closest friends. Ask me before sending more than my auto-approve limit.",
        memory: ["Alex doesn't drink alcohol.", "Alex left the fado show at intermission because he felt sick."],
      }),
      maya: member("maya", "Maya", "#7B4BD1", {
        autoApproveMax: 100,
        weeklyCap: 400,
        instructions:
          "Happy to drop anything the other person genuinely didn't have, like food or drinks. Don't drop shared bookings such as rent, tickets or rides: those were bought for everyone whether or not they got used.",
        memory: ["Maya booked the Airbnb and the fado tickets for herself and Alex."],
      }),
      sam: member("sam", "Sam", "#0F7B63", {
        autoApproveMax: 100,
        weeklyCap: 300,
        instructions: "Keep it simple and fair. Lessons and tickets are per person, so everyone who signed up pays their share.",
        memory: ["Sam booked the surf lessons for Sam, Priya and Alex."],
      }),
      priya: member("priya", "Priya", "#B4531A", {
        autoApproveMax: 50,
        weeklyCap: 250,
        instructions: "Only pay for what I actually had. Ask me before paying anything over my limit.",
        memory: ["Priya doesn't drink alcohol."],
      }),
    },
    groups: [
      { id: "lisbon", name: "Lisbon trip", members: ["alex", "maya", "sam", "priya"] },
      { id: "apt4b", name: "Apartment 4B", members: ["maya", "priya"] },
      { id: "lunch", name: "Friday lunches", members: ["alex", "sam"] },
    ],
    expenses: [
      {
        id: "exp_airbnb",
        description: "Airbnb in Alfama, 3 nights",
        paidBy: "maya",
        date: "2026-10-23",
        source: "seed",
        group: "lisbon",
        items: [{ id: "i_airbnb", label: "Apartment, 3 nights", amount: 424, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_dinner",
        description: "Dinner at Taberna da Rua",
        paidBy: "maya",
        date: "2026-10-24",
        source: "seed",
        group: "lisbon",
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
        group: "lisbon",
        items: [{ id: "i_fado", label: "2 tickets, Clube de Fado", amount: 60, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_groceries",
        description: "Groceries at Pingo Doce",
        paidBy: "alex",
        date: "2026-10-23",
        source: "seed",
        group: "lisbon",
        items: [{ id: "i_groceries", label: "Breakfast groceries", amount: 38, kind: "consumable", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_ride",
        description: "Ride to the airport",
        paidBy: "alex",
        date: "2026-10-26",
        source: "seed",
        group: "lisbon",
        items: [{ id: "i_ride", label: "Ride to LIS", amount: 26, kind: "shared-fixed", sharedBy: ["alex", "maya"] }],
      },
      {
        id: "exp_surf",
        description: "Surf lessons in Ericeira",
        paidBy: "sam",
        date: "2026-10-25",
        source: "seed",
        group: "lisbon",
        items: [{ id: "i_surf", label: "3 surf lessons", amount: 180, kind: "shared-fixed", sharedBy: ["sam", "priya", "alex"] }],
      },
      {
        id: "exp_sintra",
        description: "Train to Sintra",
        paidBy: "priya",
        date: "2026-10-25",
        source: "seed",
        group: "lisbon",
        items: [{ id: "i_sintra", label: "4 return tickets", amount: 48, kind: "shared-fixed", sharedBy: ["alex", "maya", "sam", "priya"] }],
      },
      {
        id: "exp_market",
        description: "Dinner at Time Out Market",
        paidBy: "maya",
        date: "2026-10-25",
        source: "seed",
        group: "lisbon",
        items: [
          { id: "i_plates", label: "Shared plates", amount: 90, kind: "consumable", sharedBy: ["maya", "sam", "priya"] },
          { id: "i_sangria", label: "Jug of sangria", amount: 30, kind: "consumable", sharedBy: ["maya", "sam", "priya"] },
        ],
      },
      {
        id: "exp_electric",
        description: "Electric bill, October",
        paidBy: "maya",
        date: "2026-10-01",
        source: "seed",
        group: "apt4b",
        items: [{ id: "i_electric", label: "Electricity, October", amount: 84, kind: "shared-fixed", sharedBy: ["maya", "priya"] }],
      },
      {
        id: "exp_internet",
        description: "Internet, October",
        paidBy: "priya",
        date: "2026-10-15",
        source: "seed",
        group: "apt4b",
        items: [{ id: "i_internet", label: "Fiber internet, October", amount: 60, kind: "shared-fixed", sharedBy: ["maya", "priya"] }],
      },
      {
        id: "exp_costco",
        description: "Costco run",
        paidBy: "maya",
        date: "2026-11-02",
        source: "seed",
        group: "apt4b",
        items: [
          { id: "i_pantry", label: "Pantry and cleaning supplies", amount: 82, kind: "consumable", sharedBy: ["maya", "priya"] },
          { id: "i_party_wine", label: "Wine for the housewarming", amount: 36, kind: "consumable", sharedBy: ["maya", "priya"] },
        ],
      },
      {
        id: "exp_lunch1",
        description: "Lunch at Sweetgreen",
        paidBy: "alex",
        date: "2026-10-16",
        source: "seed",
        group: "lunch",
        items: [{ id: "i_lunch1", label: "Two salads", amount: 34, kind: "consumable", sharedBy: ["alex", "sam"] }],
      },
      {
        id: "exp_lunch2",
        description: "Lunch at the taco truck",
        paidBy: "sam",
        date: "2026-10-30",
        source: "seed",
        group: "lunch",
        items: [{ id: "i_lunch2", label: "Tacos for two", amount: 28, kind: "consumable", sharedBy: ["alex", "sam"] }],
      },
      {
        id: "exp_lunch3",
        description: "Lunch at Joe's Pizza",
        paidBy: "alex",
        date: "2026-11-06",
        source: "seed",
        group: "lunch",
        items: [{ id: "i_lunch3", label: "Pizza and drinks", amount: 40, kind: "consumable", sharedBy: ["alex", "sam"] }],
      },
    ],
    negotiations: [],
    webhookEvents: [],
  };
}
