// Small formatters used by metrics + Run Inspector surfaces.

export function formatCents(cents: number): string {
  if (cents === 0) return "$0";
  if (cents < 100) return `${cents}¢`;
  const dollars = cents / 100;
  if (dollars < 10) return `$${dollars.toFixed(2)}`;
  if (dollars < 100) return `$${dollars.toFixed(1)}`;
  return `$${Math.round(dollars)}`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

export function formatRelativeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 0) return "in the future";
  return `${formatDurationMs(ms)} ago`;
}
