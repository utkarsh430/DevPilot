"use client";

import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

/**
 * Thin wrapper that maps our theme tokens onto sonner. The provider is
 * mounted once in the app shell so any client component can `import { toast }`
 * from sonner and call it directly.
 */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="system"
      richColors
      closeButton
      toastOptions={{
        style: {
          background: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
          border: "1px solid hsl(var(--border))",
          fontSize: "0.875rem",
        },
        classNames: {
          toast: "rounded-md shadow-lg",
        },
      }}
      {...props}
    />
  );
}

export { toast } from "sonner";
