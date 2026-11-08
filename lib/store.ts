import fs from "node:fs";
import path from "node:path";
import type { DB } from "./types";
import { DB_VERSION, seedDB } from "./seed";

const FILE = process.env.SQUARE_DB_PATH || path.join(process.cwd(), "data", "db.json");

const g = globalThis as unknown as { __squareDB?: DB };

function load(): DB {
  if (g.__squareDB) return g.__squareDB;
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8")) as DB;
    if (saved.version !== DB_VERSION) throw new Error("old data format");
    g.__squareDB = saved;
  } catch {
    g.__squareDB = seedDB();
    persist();
  }
  return g.__squareDB!;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(g.__squareDB, null, 2));
  } catch {
    // Read-only filesystems (some hosts) keep state in memory only.
  }
}

export function getDB(): DB {
  return load();
}

export function mutate<T>(fn: (db: DB) => T): T {
  const db = load();
  const out = fn(db);
  persist();
  return out;
}

export function resetDB(keepPayPalLinks = true): DB {
  const old = g.__squareDB;
  const fresh = seedDB();
  if (keepPayPalLinks && old) {
    for (const id of Object.keys(fresh.users)) {
      if (fresh.users[id].paypal.status !== "linked" && old.users[id]) fresh.users[id].paypal = old.users[id].paypal;
    }
  }
  g.__squareDB = fresh;
  persist();
  return fresh;
}

export function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
