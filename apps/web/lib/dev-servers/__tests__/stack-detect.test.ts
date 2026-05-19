import { describe, expect, it } from "vitest";
import {
  EMPTY_SNAPSHOT,
  decideDevCommand,
  fallbackDevCommand,
  type WorkspaceSnapshot,
} from "../stack-detect";

function snap(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...EMPTY_SNAPSHOT, ...over };
}

const pkg = (body: Record<string, unknown>) => JSON.stringify(body);

describe("decideDevCommand — generic chain (pre-WI-11 behaviour, unchanged)", () => {
  it("prefers scripts.dev", () => {
    expect(decideDevCommand(snap({ packageJson: pkg({ scripts: { dev: "next dev" } }) }))).toBe(
      "pnpm dev",
    );
  });

  it("falls back to scripts.start", () => {
    expect(decideDevCommand(snap({ packageJson: pkg({ scripts: { start: "node ." } }) }))).toBe(
      "pnpm start",
    );
  });

  it("falls through a package.json with no usable scripts", () => {
    expect(
      decideDevCommand(
        snap({ packageJson: pkg({ scripts: { build: "tsc" } }), goMod: "module x" }),
      ),
    ).toBe("go run .");
  });

  it("treats invalid JSON as no package.json rather than deadlocking Run", () => {
    expect(decideDevCommand(snap({ packageJson: "{ not json", cargoToml: "[package]" }))).toBe(
      "cargo run",
    );
  });

  it("reads pyproject [project.scripts], then the fastapi fingerprint, then plain python", () => {
    expect(decideDevCommand(snap({ pyproject: "[project.scripts]\nserve = 'app:main'\n" }))).toBe(
      "serve",
    );
    expect(decideDevCommand(snap({ pyproject: 'dependencies = ["fastapi"]' }))).toBe(
      "uv run uvicorn main:app --reload",
    );
    expect(decideDevCommand(snap({ pyproject: "[project]\nname = 'x'" }))).toBe("python main.py");
  });

  it("defaults to pnpm dev on an empty workspace", () => {
    expect(decideDevCommand(EMPTY_SNAPSHOT)).toBe("pnpm dev");
  });
});

describe("decideDevCommand — platform steering (WI-11)", () => {
  it("mobile: expo dependency without a start script synthesises the expo runner", () => {
    expect(
      decideDevCommand(snap({ packageJson: pkg({ dependencies: { expo: "^51" } }) }), "mobile"),
    ).toBe("pnpm expo start");
  });

  it("mobile: an explicit start script beats the synthesised runner", () => {
    expect(
      decideDevCommand(
        snap({
          packageJson: pkg({ dependencies: { expo: "^51" }, scripts: { start: "expo start" } }),
        }),
        "mobile",
      ),
    ).toBe("pnpm start");
  });

  it("mobile: bare react-native", () => {
    expect(
      decideDevCommand(
        snap({ packageJson: pkg({ dependencies: { "react-native": "0.74" } }) }),
        "mobile",
      ),
    ).toBe("pnpm react-native start");
  });

  it("mobile: flutter via pubspec.yaml", () => {
    expect(decideDevCommand(snap({ pubspecYaml: "name: myapp" }), "mobile")).toBe("flutter run");
  });

  it("ios: an `ios` script wins (RN/Expo targeting iOS)", () => {
    expect(
      decideDevCommand(snap({ packageJson: pkg({ scripts: { ios: "expo run:ios" } }) }), "ios"),
    ).toBe("pnpm ios");
  });

  it("ios: Package.swift, then a bare xcode project", () => {
    expect(decideDevCommand(snap({ packageSwift: "// swift-tools-version:5.9" }), "ios")).toBe(
      "swift run",
    );
    expect(decideDevCommand(snap({ hasXcodeProject: true }), "ios")).toBe("xcodebuild");
  });

  it("desktop: tauri dir and electron dependency", () => {
    expect(decideDevCommand(snap({ hasTauriDir: true }), "desktop")).toBe("pnpm tauri dev");
    expect(
      decideDevCommand(
        snap({ packageJson: pkg({ dependencies: { electron: "^31" } }) }),
        "desktop",
      ),
    ).toBe("pnpm electron .");
  });

  it("desktop: an electron app's own dev script wins over the synthesised runner", () => {
    expect(
      decideDevCommand(
        snap({
          packageJson: pkg({
            devDependencies: { electron: "^31" },
            scripts: { dev: "electron-vite dev" },
          }),
        }),
        "desktop",
      ),
    ).toBe("pnpm dev");
  });

  it("web and other never steer — they take the generic chain", () => {
    const s = snap({ packageJson: pkg({ dependencies: { expo: "^51" }, scripts: { dev: "x" } }) });
    expect(decideDevCommand(s, "web")).toBe("pnpm dev");
    expect(decideDevCommand(s, "other")).toBe("pnpm dev");
  });
});

// The load-bearing safety property: the platform label is a COARSE steer, never
// an override. A mislabeled project must degrade to the pre-WI-11 disk guess,
// never to a command that hard-fails the spawn.
describe("decideDevCommand — a mislabeled platform is never fatal to Run", () => {
  const nextApp = snap({
    packageJson: pkg({ dependencies: { next: "^15" }, scripts: { dev: "next dev" } }),
  });

  it("a Next.js app mislabeled `mobile` still gets `pnpm dev`, not `pnpm expo start`", () => {
    expect(decideDevCommand(nextApp, "mobile")).toBe("pnpm dev");
  });

  it("...and mislabeled `ios` or `desktop` likewise falls back to the disk guess", () => {
    expect(decideDevCommand(nextApp, "ios")).toBe("pnpm dev");
    expect(decideDevCommand(nextApp, "desktop")).toBe("pnpm dev");
  });

  it("a Go service mislabeled `desktop` still gets `go run .`", () => {
    expect(decideDevCommand(snap({ goMod: "module svc" }), "desktop")).toBe("go run .");
  });

  it("every platform's output survives a naive whitespace argv split (runner contract)", () => {
    const commands = [
      decideDevCommand(snap({ packageJson: pkg({ dependencies: { expo: "^51" } }) }), "mobile"),
      decideDevCommand(snap({ hasXcodeProject: true }), "ios"),
      decideDevCommand(snap({ hasTauriDir: true }), "desktop"),
      decideDevCommand(snap({ pubspecYaml: "name: a" }), "mobile"),
      ...(["web", "mobile", "ios", "desktop", "other"] as const).map((t) => fallbackDevCommand(t)),
    ];
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/['"&|;$<>]/);
      expect(cmd.split(/\s+/).every((part) => part.length > 0)).toBe(true);
    }
  });
});

describe("fallbackDevCommand — no workspace on disk, the label decides alone", () => {
  it("steers per platform and defaults to pnpm dev", () => {
    expect(fallbackDevCommand("mobile")).toBe("pnpm start");
    expect(fallbackDevCommand("ios")).toBe("pnpm ios");
    expect(fallbackDevCommand("web")).toBe("pnpm dev");
    expect(fallbackDevCommand("desktop")).toBe("pnpm dev");
    expect(fallbackDevCommand("other")).toBe("pnpm dev");
    expect(fallbackDevCommand()).toBe("pnpm dev");
  });
});
