// Ambient declarations for the in-browser terminal stack (Track 3).
//
// These packages are listed in package.json but the user installs deps out-
// of-band — typecheck must pass before `pnpm install`. Once the real types
// from the published packages are present in node_modules, TypeScript prefers
// them over these ambient stubs (real .d.ts files in node_modules win module
// resolution), so this file becomes a no-op the moment dependencies are
// installed.
//
// Keep these shapes minimal — just what RunTerminalPanel.tsx + attach-
// registry.ts touch. If you start using more APIs, either install the deps
// or extend this file.

declare module "@xterm/xterm" {
  export interface ITerminalOptions {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    cursorBlink?: boolean;
    scrollback?: number;
    theme?: Record<string, string>;
    convertEol?: boolean;
    allowProposedApi?: boolean;
  }

  export class Terminal {
    constructor(options?: ITerminalOptions);
    cols: number;
    rows: number;
    open(parent: HTMLElement): void;
    write(data: string | Uint8Array): void;
    onData(cb: (data: string) => void): { dispose: () => void };
    onResize(cb: (size: { cols: number; rows: number }) => void): {
      dispose: () => void;
    };
    loadAddon(addon: unknown): void;
    focus(): void;
    scrollToBottom(): void;
    dispose(): void;
  }
}

declare module "@xterm/addon-fit" {
  export class FitAddon {
    constructor();
    activate(terminal: unknown): void;
    dispose(): void;
    fit(): void;
    proposeDimensions(): { cols: number; rows: number } | undefined;
  }
}

declare module "@xterm/addon-web-links" {
  export class WebLinksAddon {
    constructor(handler?: (event: MouseEvent, uri: string) => void);
    activate(terminal: unknown): void;
    dispose(): void;
  }
}

// xterm ships its CSS as part of the package — we import it via a side-effect
// import. Next.js / webpack's css loader resolves it at build time, so the
// runtime import works; TypeScript just needs to know the module exists.
declare module "@xterm/xterm/css/xterm.css";

// node-pty — native addon. We dynamically import in a try/catch so the
// route gracefully degrades when the addon isn't built on a host. The
// ambient shape mirrors what the real types export.
declare module "node-pty" {
  export interface IPty {
    pid: number;
    cols: number;
    rows: number;
    onData(cb: (data: string) => void): { dispose: () => void };
    onExit(cb: (exit: { exitCode: number; signal?: number }) => void): {
      dispose: () => void;
    };
    resize(cols: number, rows: number): void;
    write(data: string): void;
    kill(signal?: string): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string };
    encoding?: string | null;
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
}
