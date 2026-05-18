import { z } from "zod";
import { LlmProviderFormSchema } from "@/lib/llm/provider-form";

export const SetProjectLlmProviderSchema = LlmProviderFormSchema.extend({
  projectId: z.string().uuid("projectId must be a uuid"),
});
