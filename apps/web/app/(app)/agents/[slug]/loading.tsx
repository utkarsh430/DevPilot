import { PromptViewSkeleton } from "./prompt-view-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PromptViewSkeleton />
    </div>
  );
}
