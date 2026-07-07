// Branded 404 for the authenticated app shell. Several pages call Next's
// notFound() for a missing ticket/project/run/push id (changes/[pendingPushId],
// projects/[projectId], runs/[id]); without this file that falls through to
// Next's bare default 404 instead of matching the error.tsx sibling's styling.

import Link from "next/link";
import { LayoutGrid, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl px-6 py-20">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="bg-muted text-muted-foreground flex h-10 w-10 items-center justify-center rounded-full">
            <SearchX className="h-5 w-5" />
          </div>
          <div>
            <p className="font-display text-lg font-bold tracking-tight">Not found</p>
            <p className="text-muted-foreground mt-1 text-sm">
              This ticket, project, or run doesn&apos;t exist — or it was deleted, or you don&apos;t
              have access to it.
            </p>
          </div>
          <Button asChild size="sm" variant="primary">
            <Link href="/board">
              <LayoutGrid className="h-3.5 w-3.5" />
              Back to board
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
