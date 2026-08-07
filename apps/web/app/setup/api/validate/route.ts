// POST /setup/api/validate — boot-wizard credential checks. Double-gated:
// requires the console-printed setup token AND an instance that is still
// unconfigured; either failing kills the surface. Values are validated and
// discarded — nothing is stored here (that's the write route).
//
// On serverless hosts the route is disabled outright: the token lives on
// `globalThis` (per-process), so on a multi-instance lambda fleet the unlock
// POST can land on an instance that minted a different token. The serverless
// wizard is read-only copy-paste guidance and needs no in-app validation.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isBootConfigured } from "@/lib/setup/boot-status";
import { verifySetupToken } from "@/lib/setup/setup-token";
import { isServerlessHost } from "@/lib/setup/env-file";
import { validateEncryptionKey, validateSupabase } from "@/lib/setup/validators";
import { valid } from "@/lib/setup/types";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token") }),
  z.object({
    kind: z.literal("supabase"),
    url: z.string().min(1).max(2_000),
    publishableKey: z.string().min(1).max(4_000),
    secretKey: z.string().min(1).max(4_000),
  }),
  z.object({ kind: z.literal("encryption_key"), value: z.string().min(1).max(4_000) }),
]);

export async function POST(request: Request) {
  if (isBootConfigured()) {
    return NextResponse.json({ error: "This instance is already configured." }, { status: 403 });
  }
  if (isServerlessHost()) {
    return NextResponse.json(
      {
        error:
          "Validation isn't available on serverless hosts - follow the copy-paste instructions instead.",
      },
      { status: 403 },
    );
  }
  if (!verifySetupToken(request.headers.get("x-setup-token"))) {
    return NextResponse.json(
      { error: "Wrong or missing setup token — copy it from the server console." },
      { status: 401 },
    );
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const body = parsed.data;
  switch (body.kind) {
    case "token":
      // Reaching this line means the header already verified.
      return NextResponse.json(valid("Unlocked"));
    case "supabase":
      return NextResponse.json(await validateSupabase(body));
    case "encryption_key":
      return NextResponse.json(validateEncryptionKey(body.value));
  }
}
