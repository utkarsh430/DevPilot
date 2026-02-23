import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "devpilot-web",
    time: new Date().toISOString(),
  });
}
