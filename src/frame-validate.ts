// Runtime wire-frame validation (ea-claude-152) — dependency-free.
//
// Validator copied from edge-book-host src/frame-validate.ts (the host's
// gateInboundFrame section is dropped; this file adds the cli's own
// host→agent gate instead). Keep the interpreter byte-for-byte in lockstep
// with the host's — both interpret the same vendored schema.
//
// Interprets the JSON-Schema subset actually present in WIRE_FRAMES_SCHEMA
// (src/wire-schema.ts, generated from the vendored schemas/wire-frames.schema.json):
// $ref into definitions, type (object/string/number/boolean/array), const,
// enum, required, properties, items, anyOf. Unknown properties PASS — the
// contract never sets additionalProperties:false, so old/new client skew is
// tolerated. Error collection caps at MAX_ERRORS.
import { WIRE_FRAMES_SCHEMA } from "./wire-schema.ts";

type Schema = Record<string, unknown>;

const DEFINITIONS = (WIRE_FRAMES_SCHEMA as { definitions: Record<string, Schema> }).definitions;
const MAX_ERRORS = 5;

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

export function validateWireFrame(defName: string, value: unknown): ValidateResult {
  const def = Object.prototype.hasOwnProperty.call(DEFINITIONS, defName)
    ? DEFINITIONS[defName]
    : undefined;
  if (!def) return { ok: false, errors: [`unknown schema definition: ${defName}`] };
  const errors: string[] = [];
  check(def, value, "$", errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;

  const ref = schema.$ref;
  if (typeof ref === "string") { checkRef(ref, value, at, errors); return; }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matched = anyOf.some((branch) => {
      const branchErrors: string[] = [];
      check(branch as Schema, value, at, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matched) errors.push(`${at}: matched no anyOf branch`);
    return;
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.some((v) => v === value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(allowed)}`);
    return;
  }

  const type = schema.type;
  if (typeof type === "string") {
    const actual = typeOf(value);
    if (type === "object" ? actual !== "object" : actual !== type) {
      errors.push(`${at}: expected ${type}, got ${actual}`);
      return;
    }
  }

  if (type === "object") checkObject(schema, value as Record<string, unknown>, at, errors);
  if (type === "array" && Array.isArray(value)) checkArray(schema, value, at, errors);
}

function checkRef(ref: string, value: unknown, at: string, errors: string[]): void {
  const name = ref.replace("#/definitions/", "");
  const target = Object.prototype.hasOwnProperty.call(DEFINITIONS, name)
    ? DEFINITIONS[name]
    : undefined;
  if (!target) { errors.push(`${at}: unresolvable $ref ${ref}`); return; }
  check(target, value, at, errors);
}

function checkObject(schema: Schema, obj: Record<string, unknown>, at: string, errors: string[]): void {
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (errors.length >= MAX_ERRORS) return;
      if (!(typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key))) errors.push(`${at}: missing required property "${String(key)}"`);
    }
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const [key, propSchema] of Object.entries(properties as Record<string, Schema>)) {
      if (errors.length >= MAX_ERRORS) return;
      if (Object.prototype.hasOwnProperty.call(obj, key)) check(propSchema, obj[key], `${at}.${key}`, errors);
    }
  }
  // Properties NOT in the schema pass untouched (forward compatibility).
}

function checkArray(schema: Schema, value: unknown[], at: string, errors: string[]): void {
  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    for (let i = 0; i < value.length; i++) {
      if (errors.length >= MAX_ERRORS) return;
      check(items as Schema, value[i], `${at}[${i}]`, errors);
    }
  }
}

// ── Inbound seam gate (cli side, fail closed) ────────────────────────────────
// Host→agent frame types the schema covers, mapped to their definitions. The
// dial-out client validates these BEFORE any handler logic; an invalid frame
// is logged (paths only) and dropped:
//   - invalid mailbox_deliver is NOT acked → the host redelivers;
//   - invalid rpc replies (send_ok/err, status_ok/err) do NOT resolve the
//     pending request → the existing timeout fires.
const INBOUND_GATES: Record<string, string> = {
  mailbox_deliver: "MailboxDeliverFrame",
  mailbox_send_ok: "MailboxSendOkFrame",
  mailbox_send_err: "MailboxSendErrFrame",
  mailbox_status_ok: "MailboxStatusOkFrame",
  mailbox_status_err: "MailboxStatusErrFrame",
  handle_claim_ok: "HandleClaimOkFrame",
  handle_claim_err: "HandleClaimErrFrame",
};

export type HostGateResult = { ok: true } | { ok: false; frameType: string; errorPaths: string };

/** Validate an inbound host frame against the contract BEFORE handler logic
 *  runs. Frame types the schema does not cover pass through untouched. On
 *  invalid input, returns only the frame type and the error LOCATIONS
 *  (e.g. "$.ts,$.blob_b64") — never frame contents, which may embed
 *  blob_b64 payloads that must not reach the event log. */
export function gateHostFrame(frame: unknown): HostGateResult {
  const type = frame && typeof frame === "object" ? (frame as { type?: unknown }).type : undefined;
  const def = typeof type === "string" && Object.prototype.hasOwnProperty.call(INBOUND_GATES, type)
    ? INBOUND_GATES[type]
    : undefined;
  if (!def) return { ok: true };
  const result = validateWireFrame(def, frame);
  if (result.ok) return { ok: true };
  const paths = result.errors.map((e) => e.split(":")[0] ?? e).join(",");
  return { ok: false, frameType: type as string, errorPaths: paths };
}
