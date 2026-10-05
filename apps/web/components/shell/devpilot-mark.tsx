import { cn } from "@/lib/cn";

/**
 * DevPilot brand assets — the chevron-and-arrow mark and the full lockup.
 *
 * Both come from the same source PNG, derived once into `public/brand/`:
 *
 *   devpilot-mark.png / devpilot-mark-dark.png     square mark, 512×512
 *   devpilot-logo.png / devpilot-logo-dark.png     mark + wordmark, 1400×358
 *
 * The wordmark's ink is navy, which vanishes on a dark surface, so each asset
 * has a dark-surface twin with the navy recoloured to porcelain (the orange is
 * untouched). The pair is switched with the `dark:` variant, which globals.css
 * widens to `[data-theme="dark"]` as well as `.dark`; the light-leaning named
 * palettes keep the light asset.
 *
 * Plain `<img>`, not `next/image`: these are static, already-sized brand files
 * served straight from `public/`, and `next/image` does not render under
 * `renderToStaticMarkup`, which is how the presentational components in this
 * repo are tested.
 */

const MARK = { light: "/brand/devpilot-mark.png", dark: "/brand/devpilot-mark-dark.png" };
const LOGO = { light: "/brand/devpilot-logo.png", dark: "/brand/devpilot-logo-dark.png" };
/** Intrinsic sizes, so the browser reserves the box before the bytes arrive. */
const MARK_PX = 512;
const LOGO_PX = { w: 1400, h: 358 };

/**
 * The square mark. Size it with `h-*`/`w-*` on `className` (16px by default).
 * Decorative: the surrounding link or heading carries the accessible name.
 */
export function DevPilotMark({ className }: { className?: string }) {
  return (
    <span
      className={cn("relative inline-block h-4 w-4 shrink-0 align-middle", className)}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, see header */}
      <img
        src={MARK.light}
        alt=""
        width={MARK_PX}
        height={MARK_PX}
        draggable={false}
        className="block h-full w-full object-contain dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, see header */}
      <img
        src={MARK.dark}
        alt=""
        width={MARK_PX}
        height={MARK_PX}
        draggable={false}
        className="hidden h-full w-full object-contain dark:block"
      />
    </span>
  );
}

/**
 * The full lockup: mark + "devpilot" wordmark. Size it by HEIGHT through
 * `className` (`h-7` by default); the width follows the asset's aspect ratio.
 */
export function DevPilotLogo({
  className,
  alt = "DevPilot",
}: {
  className?: string;
  /** Pass `""` when a parent link already names the destination. */
  alt?: string;
}) {
  return (
    <span className={cn("inline-flex h-7 items-center", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, see header */}
      <img
        src={LOGO.light}
        alt={alt}
        width={LOGO_PX.w}
        height={LOGO_PX.h}
        draggable={false}
        className="block h-full w-auto dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, see header */}
      <img
        src={LOGO.dark}
        alt={alt}
        width={LOGO_PX.w}
        height={LOGO_PX.h}
        draggable={false}
        className="hidden h-full w-auto dark:block"
      />
    </span>
  );
}
