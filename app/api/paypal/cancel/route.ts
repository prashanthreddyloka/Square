import { NextResponse } from "next/server";
import { mutate } from "../../../../lib/store";
import { baseUrl, isUser } from "../../../../lib/http";

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user");
  if (isUser(user)) mutate((d) => { d.users[user].paypal = { status: "unlinked" }; });
  return NextResponse.redirect(`${baseUrl(req)}/?linked=cancelled`);
}
