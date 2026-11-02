import { NextResponse, type NextRequest } from "next/server";

/**
 * Two protections for a hosted, credential-connected demo:
 *
 * 1. Access code. When SQUARE_ACCESS_CODE is set, every page and API call requires the
 *    access cookie issued by /unlock. The demo shows both people's phones in one browser,
 *    so the code is what stands between the public internet and approving a payment.
 *    (In a real deployment each person signs in on their own device and can only act
 *    for themselves.)
 * 2. Same-origin writes. POSTs must come from this site with a JSON body, so another
 *    website can't trigger an approval or settlement from a visitor's browser.
 *
 * PayPal's webhook is exempt from both (it is verified by signature), and so is /api/health,
 * which returns only {"ok":true} for the host's health check.
 */
const OPEN_PATHS = ["/unlock", "/api/unlock", "/api/webhooks/paypal", "/api/health"];

async function accessHash(code: string) {
  const data = new TextEncoder().encode(`square-access:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const open = OPEN_PATHS.some((p) => pathname === p);

  if (isApi && req.method !== "GET" && pathname !== "/api/webhooks/paypal") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }
    if (!(req.headers.get("content-type") || "").includes("application/json")) {
      return NextResponse.json({ error: "Requests must be JSON." }, { status: 415 });
    }
  }

  const code = process.env.SQUARE_ACCESS_CODE;
  if (!code || open) return NextResponse.next();
  if (req.cookies.get("sq_access")?.value === (await accessHash(code))) return NextResponse.next();
  if (isApi) return NextResponse.json({ error: "Enter the demo access code first." }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};


