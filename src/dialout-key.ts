// Dial-out transport key + pairing-code material (split from dialout.ts).
// The transport key (host-dialout-key.json) defines channel_id =
// sha256(agent_key) and is TOFU-locked by the host; it is SEPARATE from the
// identity keypair (identity.json) that defines the DID. Frame shapes here
// (pair_register / sessions_revoke) are FROZEN by the host repo's
// docs/wire-protocol.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EdgeBookStore } from "./edge-book.ts";

export const DIALOUT_KEY_FILE = "host-dialout-key.json"; // persisted name — doctor checks its presence
const KEY_FILE = DIALOUT_KEY_FILE;
// 10 minutes — the host clamp's maximum. The window must absorb the relay
// latency between code mint and the human actually reading it (ea-claude-112).
export const DEFAULT_PAIR_TTL_MS = 10 * 60 * 1000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface DialoutKey {
  schema: "edge-book-host-dialout-key/0.1";
  key_id: string;
  agent_key: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
}

export interface PairRegistration {
  code: string;
  // Host-clock deadline from pair_register_ok (ea-claude-112). Absent when
  // the host predates the field (old-host degradation — estimate from ttl_ms).
  expires_at?: number;
  frame: {
    type: "pair_register";
    code: string;
    ttl_ms: number;
    request_id: string;
  };
}

export interface SessionsRevokeFrame {
  type: "sessions_revoke";
  request_id: string;
}

function now(): string {
  return new Date().toISOString();
}

function keyId(agentKey: string): string {
  return `agent_${crypto.createHash("sha256").update(agentKey).digest("base64url").slice(0, 32)}`;
}

export function channelIdForKey(key: DialoutKey): string {
  return crypto.createHash("sha256").update(key.agent_key).digest("hex");
}

async function chmodBestEffort(file: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(file, mode);
  } catch {
    // Some mounted filesystems do not honor POSIX modes.
  }
}

export async function loadOrCreateDialoutKey(store: EdgeBookStore): Promise<DialoutKey> {
  const file = store.file(KEY_FILE);
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DialoutKey>;
    if (existing.agent_key && existing.public_key_pem && existing.private_key_pem && existing.key_id) return existing as DialoutKey;
    if (existing.public_key_pem && existing.private_key_pem && existing.key_id) {
      const migrated = {
        ...existing,
        agent_key: `ed25519:${Buffer.from(existing.public_key_pem, "utf8").toString("base64")}`
      } as DialoutKey;
      migrated.key_id = keyId(migrated.agent_key);
      await fs.writeFile(file, `${JSON.stringify(migrated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmodBestEffort(file, 0o600);
      return migrated;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyDer = pair.publicKey.export({ type: "spki", format: "der" });
  const agentKey = `ed25519:${Buffer.from(publicKeyDer).toString("base64")}`;
  const key: DialoutKey = {
    schema: "edge-book-host-dialout-key/0.1",
    key_id: keyId(agentKey),
    agent_key: agentKey,
    public_key_pem: publicKeyPem,
    private_key_pem: privateKeyPem,
    created_at: now()
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(key, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmodBestEffort(file, 0o600);
  return key;
}

export function generatePairingCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  }
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export async function createPairRegistration(store: EdgeBookStore, ttlMs = DEFAULT_PAIR_TTL_MS): Promise<PairRegistration> {
  const code = generatePairingCode();
  return {
    code,
    frame: {
      type: "pair_register",
      code,
      ttl_ms: ttlMs,
      request_id: crypto.randomUUID()
    }
  };
}

export async function createSessionsRevokeFrame(store: EdgeBookStore): Promise<SessionsRevokeFrame> {
  await loadOrCreateDialoutKey(store);
  return {
    type: "sessions_revoke",
    request_id: crypto.randomUUID()
  };
}
