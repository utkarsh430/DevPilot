// The shared Zod shape for every surface that accepts an LLM provider config —
// the two project-create forms and the project settings card.
//
// One schema, so the input constraints (model-id grammar, base-URL length cap,
// the key's write-only-ness) can't drift between the surfaces. The SSRF check is
// NOT here: it needs DNS and therefore a server module (`project-provider.server.ts`
// → `validateLlmBaseUrl`). This is the shape gate; that is the security gate, and
// every write path runs both.

import { z } from "zod";
import { BASE_URL_MAX } from "@/lib/llm/base-url";
import { LLM_PROVIDERS, MODEL_ID_MAX, MODEL_ID_RE, type LlmProvider } from "@/lib/llm/provider";

export type { LlmProvider };

const PROVIDER_ENUM = LLM_PROVIDERS as readonly LlmProvider[] as [LlmProvider, ...LlmProvider[]];

/** Keys are bounded, not shaped: vendors' formats differ and will keep differing,
 *  so a regex here would only reject valid credentials. The cap is a DoS bound. */
const API_KEY_MAX = 500;

export const LlmProviderFormSchema = z.object({
  /** null = no project override; inherit (tenant » instance » env). */
  provider: z.enum(PROVIDER_ENUM).nullable(),
  baseUrl: z.string().trim().max(BASE_URL_MAX).nullable().optional(),
  model: z
    .string()
    .trim()
    .max(MODEL_ID_MAX)
    .regex(MODEL_ID_RE, "Model id may only contain letters, digits, and . _ : - /")
    .nullable()
    .optional(),
  /** The provider API key, in plaintext, travelling ONE WAY: in. It is written
   *  straight to the encrypted vault and never read back out to any client.
   *  Undefined = leave whatever is stored alone; "" or null = clear it. */
  apiKey: z.string().max(API_KEY_MAX).nullable().optional(),
});

export type LlmProviderFormInput = z.input<typeof LlmProviderFormSchema>;
