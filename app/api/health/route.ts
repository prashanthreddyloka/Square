import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Public liveness check for the host's health probe. Returns no app data. */
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
