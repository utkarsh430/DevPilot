import { NextResponse } from "next/server";
import { signOut } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await signOut();
  return NextResponse.redirect(new URL("/login", request.url));
}
