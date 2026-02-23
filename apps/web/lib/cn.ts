// Tailwind class merge helper used by every UI primitive.
// `clsx` handles conditional classes; `tailwind-merge` resolves conflicts so
// the last conflicting utility wins (`p-2 p-4` → `p-4`).

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
