// Filesystem/JSON persistence helpers for the agent home directory.
// Invariant: writeJson is ATOMIC (temp + rename) — the host proxies many
// concurrent /api/* calls at one agent; readers must never observe a
// half-written file. readJsonl tolerates a partial trailing line from a
// concurrent append.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveHome(home?: string): string {
  if (home?.trim()) return path.resolve(home.trim());
  if (process.env.EDGE_BOOK_HOME?.trim()) return path.resolve(process.env.EDGE_BOOK_HOME.trim());
  return path.join(os.homedir(), ".openclaw", "edge-book");
}

export function now(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

export async function ensureHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await chmodBestEffort(home, 0o700);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    // Belt-and-suspenders: a read that raced a (now atomic) write could, on some
    // filesystems, briefly observe a partial file. Retry once before failing.
    if (error instanceof SyntaxError) {
      try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { /* fall through */ }
    }
    throw error;
  }
}

export async function chmodBestEffort(file: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(file, mode);
  } catch {
    // Non-POSIX filesystems may not support chmod; doctor reports this separately.
  }
}

export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write: a concurrent reader (the host proxies many /api/* calls at
  // once) must never observe a half-written file. Write a unique temp then
  // rename — rename is atomic on POSIX, so readers see the old or new file whole,
  // never a truncation ("Unexpected end of JSON input"). Unique suffix avoids two
  // concurrent writers clobbering the same temp.
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (mode !== undefined) await chmodBestEffort(tmp, mode);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    const out: T[] = [];
    for (const line of text.split(/\n/)) {
      if (!line) continue;
      // Tolerate a partial trailing line from a concurrent append — skip it
      // rather than failing the whole read.
      try { out.push(JSON.parse(line) as T); } catch { /* partial/corrupt line */ }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
