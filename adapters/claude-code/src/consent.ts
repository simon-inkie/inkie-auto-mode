/**
 * io-auto-mode — Mission Control consent-receipt reader.
 *
 * When the core classifier returns `ask` or `block`, this layer checks for a
 * valid Mission Control consent receipt and may upgrade the decision to
 * `allow`. It NEVER downgrades an allow, and fails closed: any error in this
 * layer (missing config, malformed receipt, bad HMAC, clock skew, rename
 * race) means no upgrade — behaviour is exactly that of the classifier
 * without this layer.
 *
 * The receipt is the authoritative consent artefact, written by the Mission
 * Control daemon into MC's DATA_ROOT/consent/ when a human taps a decision
 * card. That directory must be write-denied to agents in their fileZones
 * config, so the gate protects its own evidence store. The human-readable
 * approval text in the agent's own thread file is never consulted — only a
 * signed receipt counts.
 *
 * Friction classes map onto the core verdict itself:
 *   - `block` (destructive class): receipt must carry confirmed:true (the
 *     two-tap), and the receipt is CONSUMED on upgrade — atomic rename to
 *     `<id>.used.json` BEFORE the allow is emitted, so one tap is one
 *     execution and concurrent calls have exactly one winner.
 *   - `ask` (standard class): receipt is multi-use within its TTL.
 *
 * Threat model: this defends against sloppy self-authorisation and
 * prompt-injected forgery, not against a shell adversary already running as
 * the same uid. The symmetric HMAC means the verifier also holds the signing
 * key — worth revisiting asymmetrically if the signer ever lives in its own
 * trust domain.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * v1 consent is Bash-command-shaped only: a scope is tool names plus
 * command patterns. A `paths` field for path-bearing tools (Edit/Write via
 * the file-hook) is deliberately NOT declared until it is wired — a dead
 * field in the interface would imply receipts can express something the
 * reader never checks.
 */
export interface ConsentScope {
  tools?: string[];
  patterns?: string[];
}

export interface ConsentReceipt {
  decisionId: string;
  agent?: string;
  option?: string;
  confirmed?: boolean;
  authorises?: ConsentScope;
  tappedAt: string;
  expiresAt: string;
  hmac: string;
}

export interface ConsentUpgrade {
  decisionId: string;
  consumed: boolean;
  receiptPath: string;
}

export interface ConsentEnv {
  /** Directory holding receipt JSON files. Unset → layer disabled. */
  consentDir?: string;
  /** Shared HMAC key. Unset → layer disabled. */
  hmacKey?: string;
  /** Clock source, injectable for tests. */
  now?: () => number;
}

/**
 * Resolve the consent layer's own config. Deliberately separate from the
 * classifier's ClassifierConfig: this is adapter-level, disabled unless
 * BOTH the directory and the key are present.
 */
export function loadConsentEnv(): ConsentEnv {
  const env: ConsentEnv = {};
  if (process.env.IO_AUTO_MODE_CONSENT_DIR) {
    env.consentDir = process.env.IO_AUTO_MODE_CONSENT_DIR;
  } else {
    try {
      const raw = readFileSync(
        resolve(homedir(), ".io-auto-mode", "config.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as { consentDir?: string };
      if (typeof parsed.consentDir === "string" && parsed.consentDir.length > 0) {
        env.consentDir = parsed.consentDir;
      }
    } catch {
      // no config — layer stays disabled
    }
  }
  if (process.env.MC_CONSENT_HMAC_KEY) {
    env.hmacKey = process.env.MC_CONSENT_HMAC_KEY;
  }
  return env;
}

/**
 * Canonical payload for signing: the receipt object minus `hmac`, with keys
 * sorted at every level so writer and verifier agree byte-for-byte.
 */
export function canonicalPayload(receipt: Record<string, unknown>): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const { hmac: _hmac, ...payload } = receipt;
  return JSON.stringify(sortValue(payload));
}

export function signReceipt(
  receipt: Record<string, unknown>,
  key: string,
): string {
  return createHmac("sha256", key).update(canonicalPayload(receipt)).digest("hex");
}

function verifyHmac(receipt: ConsentReceipt, key: string): boolean {
  const expected = signReceipt(receipt as unknown as Record<string, unknown>, key);
  const got = receipt.hmac;
  if (typeof got !== "string" || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Glob-lite for command patterns: literal text with `*` wildcards only. */
export function commandMatchesPattern(command: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.split("*").join("[\\s\\S]*")}$`);
  return re.test(command);
}

function scopeMatches(
  scope: ConsentScope | undefined,
  tool: string,
  command: string,
): boolean {
  // An absent or empty scope authorises nothing — a receipt must say what
  // it is for. (A tap is consent to AN action, never to any action.)
  if (!scope) return false;
  if (!Array.isArray(scope.tools) || !scope.tools.includes(tool)) return false;
  if (!Array.isArray(scope.patterns) || scope.patterns.length === 0) return false;
  return scope.patterns.some((p) => commandMatchesPattern(command, p));
}

function withinTtl(receipt: ConsentReceipt, nowMs: number): boolean {
  const tapped = Date.parse(receipt.tappedAt);
  const expires = Date.parse(receipt.expiresAt);
  if (Number.isNaN(tapped) || Number.isNaN(expires)) return false;
  return nowMs >= tapped && nowMs <= expires;
}

/**
 * Extract a declared decision-id from a leading `MC_ACTING_ON=<id>`
 * assignment in the command, if present. The scope match remains the real
 * gate — a lying declaration buys nothing.
 */
export function declaredDecisionId(command: string): string | null {
  const m = command.match(/^\s*MC_ACTING_ON=([A-Za-z0-9_-]+)\s/);
  return m ? m[1] : null;
}

/**
 * The declaration prefix is metadata, not the action: scope patterns
 * describe the command the human authorised, so matching runs against the
 * command with the leading assignment stripped. Stripping is safe — only
 * the benign `MC_ACTING_ON=` assignment is removed; whatever follows is
 * still matched in full.
 */
export function effectiveCommand(command: string): string {
  return command.replace(/^\s*MC_ACTING_ON=[A-Za-z0-9_-]+\s+/, "");
}

/**
 * Attempt a consent upgrade for a pending action the core classifier did
 * not allow. Returns the upgrade evidence, or null (= no upgrade, caller
 * keeps the original decision). Never throws.
 */
export function tryConsentUpgrade(params: {
  tool: string;
  command: string;
  decision: "ask" | "block";
  env?: ConsentEnv;
}): ConsentUpgrade | null {
  try {
    const env = params.env ?? loadConsentEnv();
    if (!env.consentDir || !env.hmacKey) return null;

    const nowMs = (env.now ?? Date.now)();
    const declared = declaredDecisionId(params.command);
    const command = effectiveCommand(params.command);

    let names: string[];
    try {
      names = readdirSync(env.consentDir).filter(
        (n) => n.endsWith(".json") && !n.endsWith(".used.json"),
      );
    } catch {
      return null;
    }

    // Declared id first, then the rest — scope-match is the real gate
    // either way, the declaration only sets preference order.
    names.sort((a, b) => {
      const ad = declared !== null && a === `${declared}.json` ? 0 : 1;
      const bd = declared !== null && b === `${declared}.json` ? 0 : 1;
      return ad - bd;
    });

    for (const name of names) {
      const receiptPath = join(env.consentDir, name);
      let receipt: ConsentReceipt;
      try {
        receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as ConsentReceipt;
      } catch {
        continue; // malformed receipt is never consent
      }

      if (typeof receipt.decisionId !== "string" || receipt.decisionId.length === 0) continue;
      if (!verifyHmac(receipt, env.hmacKey)) continue;
      if (!withinTtl(receipt, nowMs)) continue;
      if (!scopeMatches(receipt.authorises, params.tool, command)) continue;

      if (params.decision === "block") {
        // Destructive class: two-tap required, and the receipt is consumed
        // atomically BEFORE the allow is emitted. Exactly one concurrent
        // caller wins the rename; losers fall through and re-ask.
        if (receipt.confirmed !== true) continue;
        const usedPath = receiptPath.replace(/\.json$/, ".used.json");
        try {
          renameSync(receiptPath, usedPath);
        } catch {
          continue; // already consumed (or unwritable) — not our consent
        }
        return { decisionId: receipt.decisionId, consumed: true, receiptPath: usedPath };
      }

      // Standard class: multi-use within TTL.
      return { decisionId: receipt.decisionId, consumed: false, receiptPath };
    }
    return null;
  } catch {
    return null; // fail closed — any surprise means no upgrade
  }
}
