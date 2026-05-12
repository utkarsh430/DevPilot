"use client";

// Markdown renderer for plan-mode assistant bubbles. Hand-rolled tag styles
// because Tailwind v4 doesn't ship the typography plugin and a chat bubble
// only needs a small subset of prose styles. No `rehype-raw` — assistant
// content is plain markdown, never HTML, and disabling raw HTML closes the
// obvious XSS surface from prompt injection.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

export function MessageMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        // min-w-0 + overflow-wrap:anywhere lets long unbreakable tokens (JWTs,
        // URLs, base64 blobs) wrap inside the bubble instead of pushing the
        // flex parent wider. The chat bubbles set max-w-[80%] but a token
        // like an entire JWT will otherwise blow past that.
        "text-foreground min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraphs: tight vertical rhythm matching chat bubble density.
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
          // Headings — chat-bubble register. Tight margins; no big size bumps
          // (an agent emitting `# TITLE` shouldn't dominate the bubble).
          // Sized like uppercase-ish dividers more than browser <h1>.
          h1: ({ children }) => (
            <h2 className="text-foreground/90 mb-1.5 mt-3 text-[13px] font-semibold uppercase tracking-wider">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="text-foreground mb-1.5 mt-3 text-[13px] font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-muted-foreground mb-1 mt-2 text-xs font-semibold uppercase tracking-wider">
              {children}
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="text-foreground mb-1 mt-2 text-xs font-semibold">{children}</h5>
          ),
          // Lists
          ul: ({ children }) => <ul className="my-2 list-disc pl-5 [&>li]:my-0.5">{children}</ul>,
          ol: ({ children }) => (
            <ol className="my-2 list-decimal pl-5 [&>li]:my-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          // Strong / em
          strong: ({ children }) => (
            <strong className="text-foreground font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          // Inline + block code. ReactMarkdown passes a single `code` for both;
          // the `node.position`/`inline` distinction is gone in v9, so we use
          // the presence of a newline in the child string as the heuristic.
          code: ({ className: cls, children, ...rest }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text);
            if (isBlock) {
              return (
                <code
                  className={cn(
                    "bg-muted text-foreground block overflow-x-auto whitespace-pre rounded-md border px-3 py-2 font-mono text-[12px] leading-relaxed",
                    cls,
                  )}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  "bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[12px]",
                  cls,
                )}
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-muted text-foreground my-2 overflow-x-auto rounded-md border p-0">
              {children}
            </pre>
          ),
          // Tables (gfm)
          table: ({ children }) => (
            <div className="my-2 w-full overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-border bg-muted/40 border-b text-left">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="text-foreground px-2 py-1 font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-border/60 border-t px-2 py-1 align-top">{children}</td>
          ),
          // Links — open in new tab; we explicitly include rel for safety.
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-chart-1 hover:text-chart-1/80 underline underline-offset-2"
            >
              {children}
            </a>
          ),
          // Blockquote
          blockquote: ({ children }) => (
            <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-border my-3" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
