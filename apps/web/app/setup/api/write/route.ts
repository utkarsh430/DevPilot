// POST /setup/api/write — the boot wizard's single write path. Same double
// gate as validate (console token + still-unconfigured), and the payload is
// further restricted to the four boot keys — the wizard can never grow into a
// general remote env editor. The actual file surgery (allowlist, atomic
// replace, serverless refusal) lives in lib/setup/env-file.

import { NextResponse } from "next/server";
import { z } from "zod";
import { BOOT_ENV_KEYS, isBootConfigured } from "@/lib/setup/boot-status";
import { verifySetupToken } from "@/lib/setup/setup-token";
import { isServerlessHost, writeEnvLocal } from "@/lib/setup/env-file";

export const dynamic = "force-dynamic";

const Body = z.object({
  values: z.record(z.string().min(1).max(8_000)),
});

export async function POST(request: Request) {
  if (isBootConfigured()) {
    return NextResponse.json({ error: "This instance is already configured." }, { status: 403 });
  }
  if (isServerlessHost()) {
    return NextResponse.json(
      {
        error:
          "Writing isn't available on serverless hosts - set the variables in your deployment's environment settings instead.",
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
  const unknown = Object.keys(parsed.data.values).filter(
    (k) => !(BOOT_ENV_KEYS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Not boot-setup keys: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const { path } = await writeEnvLocal(parsed.data.values);
    return NextResponse.json({ ok: true, path });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
