import { NextResponse } from "next/server";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (e: unknown, status = 400) => NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });

export function baseUrl(req: Request) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

import { getDB } from "./store";

export const isUser = (u: unknown): u is string => typeof u === "string" && Object.prototype.hasOwnProperty.call(getDB().users, u);
