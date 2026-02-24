/**
 * PATH discovery and binary resolution for service environments.
 *
 * When The Companion runs as a macOS launchd or Linux systemd service, it inherits
 * a restricted PATH that omits directories from version managers (nvm, fnm, volta,
 * mise, etc.) and user-local installs (~/.local/bin, ~/.cargo/bin). This module
 * captures the user's real shell PATH at runtime and provides binary resolution
 * that works regardless of how the server was started.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Capture the user's full interactive shell PATH by spawning a login shell.
 * This picks up all version manager initializations (nvm, fnm, volta, mise, etc.).
 * Falls back to probing common directories if shell sourcing fails.
 */
export function captureUserShellPath(): string {
  try {
    const shell = process.env.SHELL || "/bin/bash";
    const captured = execSync(
      `${shell} -lic 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
      },
    );
    const match = captured.match(/___PATH_START___(.+)___PATH_END___/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Shell sourcing failed (timeout, compinit prompt, etc.)
  }

  return buildFallbackPath();
}

/**
 * Build a PATH by probing common binary installation directories.
 * Used as fallback when shell-sourcing fails.
 */
export function buildFallbackPath(): string {
  const home = homedir();
  const xdgDataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const candidates = [
    // Standard system paths
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    // Bun
    join(home, ".bun", "bin"),
    // Claude CLI / user-local installs
    join(home, ".local", "bin"),
    // Cargo / Rust
    join(home, ".cargo", "bin"),
    // Volta (Node version manager)
    join(home, ".volta", "bin"),
    // mise (formerly rtx)
    join(home, ".local", "share", "mise", "shims"),
    // pyenv
    join(home, ".pyenv", "bin"),
    join(home, ".pyenv", "shims"),
    // Go
    join(home, "go", "bin"),
    "/usr/local/go/bin",
    // Deno
    join(home, ".deno", "bin"),
  ];

  // Probe nvm-managed node versions
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin && existsSync(nvmBin)) {
    candidates.push(nvmBin);
  }
  const nvmVersionsDir = join(nvmDir, "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    try {
      for (const v of readdirSync(nvmVersionsDir)) {
        candidates.push(join(nvmVersionsDir, v, "bin"));
      }
    } catch { /* ignore */ }
  }

  // fnm (Fast Node Manager) — support Linux and macOS default layouts.
  // FNM_MULTISHELL_PATH points to the active session's multishell directory
  // (e.g. /tmp/fnm_multishells/<pid>/); its `bin/` sub-path contains the active node.
  const fnmMultishellPath = process.env.FNM_MULTISHELL_PATH;
  if (fnmMultishellPath) {
    candidates.push(join(fnmMultishellPath, "bin"));
  }

  const fnmBaseDirs = [
    process.env.FNM_PATH,
    process.env.FNM_DIR,
    join(xdgDataHome, "fnm"),
    join(home, ".fnm"),
    join(home, "Library", "Application Support", "fnm"),
  ].filter((v): v is string => !!v);

  for (const base of fnmBaseDirs) {
    // fnm default alias target (stable symlink-style entry)
    const aliasDefaultBin = join(base, "aliases", "default", "bin");
    if (existsSync(aliasDefaultBin)) {
      candidates.push(aliasDefaultBin);
    }

    // fnm node-versions layout
    const fnmVersionsDir = join(base, "node-versions");
    if (existsSync(fnmVersionsDir)) {
      try {
        for (const v of readdirSync(fnmVersionsDir)) {
          candidates.push(join(fnmVersionsDir, v, "installation", "bin"));
        }
      } catch { /* ignore */ }
    }
  }

  return [...new Set(candidates.filter((dir) => existsSync(dir)))].join(":");
}

// ─── Enriched PATH (cached) ───────────────────────────────────────────────────

let _cachedPath: string | null = null;

/**
 * Returns an enriched PATH that merges the user's shell PATH (or probed common
 * directories) with the current process PATH. Deduplicates entries.
 * Result is cached after the first call.
 */
export function getEnrichedPath(): string {
  if (_cachedPath) return _cachedPath;

  const currentPath = process.env.PATH || "";
  const userPath = captureUserShellPath();

  // Merge: user shell PATH first (takes precedence), then current process PATH
  const allDirs = [...userPath.split(":"), ...currentPath.split(":")];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }

  _cachedPath = deduped.join(":");
  return _cachedPath;
}

/** Reset the cached PATH (for testing). */
export function _resetPathCache(): void {
  _cachedPath = null;
}

// ─── Binary resolution ────────────────────────────────────────────────────────

/**
 * Resolve a binary name to an absolute path using the enriched PATH.
 * Returns null if the binary is not found anywhere.
 */
export function resolveBinary(name: string): string | null {
  if (name.startsWith("/")) {
    return existsSync(name) ? name : null;
  }

  const enrichedPath = getEnrichedPath();
  try {
    const resolved = execSync(`which ${name.replace(/[^a-zA-Z0-9._@/-]/g, "")}`, {

      encoding: "utf-8",
      timeout: 5_000,
      env: { ...process.env, PATH: enrichedPath },
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * Returns a PATH string suitable for embedding in service definitions
 * (plist/systemd unit). Captures the user's shell PATH at install time.
 */
export function getServicePath(): string {
  return getEnrichedPath();
}
