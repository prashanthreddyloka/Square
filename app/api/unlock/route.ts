import crypto from "node:crypto";
import { NextResponse } from "next/server";

const hash = (code: string) => crypto.createHash("sha256").update(`square-access:${code}`).digest("hex");

export async function POST(req: Request) {
  const expected = process.env.SQUARE_ACCESS_CODE;
  if (!expected) return NextResponse.json({ ok: true });
  const { code } = await req.json().catch(() => ({ code: "" }));
  const a = Buffer.from(hash(String(code || "")));
  const b = Buffer.from(hash(expected));
  if (!crypto.timingSafeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return NextResponse.json({ error: "That code isn't right." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("sq_access", hash(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !req.url.startsWith("http://localhost"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
