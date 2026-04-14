"use client";

// Topbar bell + popover inbox.
//
// Consumes the shared NotificationsProvider context (one Realtime channel
// per app load — see notifications-provider.tsx). The unread badge tracks
// `unreadCount`; clicking an item marks it read and routes to its `href`.

import * as React from "react";
import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { useNotificationsContext } from "./notifications-provider";

export function NotificationsBell() {
  const { items, unreadCount, markRead, markAllRead, isLive } = useNotificationsContext();
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center",
                "border-background bg-destructive text-destructive-foreground rounded-full border px-1 text-[9px] font-medium leading-none",
              )}
              aria-hidden
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[22rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">Notifications</span>
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                isLive ? "bg-success" : "bg-warning",
              )}
              aria-hidden
              title={isLive ? "Live" : "Reconnecting"}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={unreadCount === 0}
            onClick={() => {
              void markAllRead();
            }}
          >
            <CheckCheck className="h-3 w-3" /> Mark all read
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="text-muted-foreground px-6 py-10 text-center text-xs">
            You&apos;re all caught up.
          </div>
        ) : (
          <ul className="max-h-[26rem] divide-y overflow-y-auto">
            {items.map((item) => {
              const unread = item.readAt === null;
              const inner = (
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    {unread ? (
                      <span className="bg-chart-1 h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden />
                    ) : null}
                    <span
                      className={cn(
                        "truncate text-xs",
                        unread ? "text-foreground font-medium" : "text-muted-foreground",
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>
                  {item.body ? (
                    <p className="text-muted-foreground line-clamp-2 pl-3.5 text-[11px]">
                      {item.body}
                    </p>
                  ) : null}
                </div>
              );
              const handleClick = () => {
                if (unread) void markRead(item.id);
                setOpen(false);
              };
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      onClick={handleClick}
                      className="hover:bg-accent/40 block px-3 py-2"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={handleClick}
                      className="hover:bg-accent/40 block w-full px-3 py-2 text-left"
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-t px-3 py-2 text-right">
          <Link
            href="/settings/notifications"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            Notification settings →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
