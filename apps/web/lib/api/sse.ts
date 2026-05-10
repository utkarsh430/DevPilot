// Phase 1 / M14 — Server-Sent Events helpers for the public platform surface.
//
// Two shapes are emitted from this module:
//   1. Run-step events for `POST /v1/agents/{id}/runs?stream=true`. Each
//      event is JSON with `{ runId, idx, kind, payload, status }` so the
//      caller can render the in-progress trace.
//   2. OpenAI-shaped chunks for `POST /v1/chat/completions` with
//      `stream: true`. We hand-craft these (no `openai` npm dep) to match
//      `{ id, object: "chat.completion.chunk", choices: [{ delta: { content }, finish_reason }] }`.
//
// In both cases the stream terminates with the OpenAI-canonical `data: [DONE]\n\n`
// marker so generic SSE clients (including LangChain / LiteLLM / curl pipes
// that strip the marker) keep working.
//
// Backpressure: we use `ReadableStream` (Web Streams API). Each `write` is
// awaited so the runtime applies natural backpressure when the client is
// slow to consume.

export const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable buffering on Vercel + nginx-flavored intermediaries.
  "X-Accel-Buffering": "no",
};

export type SseEmit = {
  write: (data: unknown) => Promise<void>;
  writeRaw: (s: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Create an SSE response backed by a ReadableStream. `producer` is invoked
 * with an emit handle; the response is returned to the client immediately
 * and the producer runs in the background. Closing the emit handle
 * terminates the stream with the OpenAI `[DONE]` marker.
 */
export function sseResponse(
  producer: (emit: SseEmit) => Promise<void>,
  extraHeaders?: HeadersInit,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const writeRaw = async (s: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(s));
      };
      const emit: SseEmit = {
        write: async (data) => {
          await writeRaw(`data: ${JSON.stringify(data)}\n\n`);
        },
        writeRaw,
        close: async () => {
          if (closed) return;
          // Write [DONE] BEFORE flipping `closed`. writeRaw short-circuits
          // when `closed` is true; setting it first would silently drop the
          // terminator (caught by phase1-m14-accept T3).
          try {
            await writeRaw("data: [DONE]\n\n");
          } finally {
            closed = true;
            controller.close();
          }
        },
      };
      try {
        await producer(emit);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await emit.write({ error: msg });
        } catch {
          // swallow — stream may already be closed
        }
      } finally {
        await emit.close();
      }
    },
  });

  const headers = new Headers(SSE_HEADERS);
  if (extraHeaders) {
    const extra = new Headers(extraHeaders);
    extra.forEach((v, k) => headers.set(k, v));
  }
  return new Response(stream, { status: 200, headers });
}

/**
 * Build an OpenAI-shaped chat completion chunk. `content` is appended to
 * the assistant message; `finishReason` is non-null only on the final
 * delta. Pass an empty string for the first delta (role-only) to mirror
 * the OpenAI wire shape exactly.
 */
export function openAiChunk(args: {
  id: string;
  model: string;
  created: number;
  content?: string;
  role?: "assistant";
  finishReason?: "stop" | "length" | null;
}) {
  const delta: Record<string, unknown> = {};
  if (args.role) delta.role = args.role;
  if (typeof args.content === "string") delta.content = args.content;
  return {
    id: args.id,
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: args.finishReason ?? null,
      },
    ],
  };
}

/**
 * Build a non-streaming OpenAI-shaped completion object.
 */
export function openAiCompletion(args: {
  id: string;
  model: string;
  created: number;
  content: string;
  promptTokens: number;
  completionTokens: number;
}) {
  return {
    id: args.id,
    object: "chat.completion",
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: args.content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      total_tokens: args.promptTokens + args.completionTokens,
    },
  };
}
