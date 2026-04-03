"use client";

// Phase 2 / M5a — small clipboard-copy button used on the project detail
// page next to the repo URL. Pulled into its own file because the rest of
// the project-detail page is a server component; this button needs
// `navigator.clipboard` access which is client-only.

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied repo URL");
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      toast.error("Couldn't copy — select the text and copy manually");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={onCopy} aria-label="Copy repo URL">
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copy
        </>
      )}
    </Button>
  );
}
