import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  tryConsentUpgrade,
  signReceipt,
  declaredDecisionId,
  commandMatchesPattern,
  type ConsentEnv,
} from "../adapters/claude-code/src/consent.js";

const KEY = "test-hmac-key";
const NOW = Date.parse("2026-06-10T16:00:00Z");

let dir: string;

function env(overrides: Partial<ConsentEnv> = {}): ConsentEnv {
  return { consentDir: dir, hmacKey: KEY, now: () => NOW, ...overrides };
}

function writeReceipt(
  overrides: Record<string, unknown> = {},
  opts: { sign?: boolean; key?: string; name?: string } = {},
): string {
  const receipt: Record<string, unknown> = {
    decisionId: "TEST-CARD",
    agent: "test-agent",
    option: "A",
    confirmed: false,
    authorises: { tools: ["Bash"], patterns: ["example-cmd run*"] },
    tappedAt: "2026-06-10T15:55:00Z",
    expiresAt: "2026-06-10T16:25:00Z",
    ...overrides,
  };
  const sign = opts.sign ?? true;
  receipt.hmac = sign
    ? signReceipt(receipt, opts.key ?? KEY)
    : "deadbeef".repeat(8);
  const name = opts.name ?? `${receipt.decisionId as string}.json`;
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(receipt));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-consent-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tryConsentUpgrade: happy path", () => {
  test("upgrades ask on a valid in-scope receipt (standard, multi-use)", () => {
    writeReceipt();
    const cmd = "example-cmd run --flag value --other-flag";
    const first = tryConsentUpgrade({ tool: "Bash", command: cmd, decision: "ask", env: env() });
    assert.ok(first);
    assert.equal(first.decisionId, "TEST-CARD");
    assert.equal(first.consumed, false);

    // Multi-use within TTL: a second matching ask also upgrades.
    const second = tryConsentUpgrade({ tool: "Bash", command: cmd, decision: "ask", env: env() });
    assert.ok(second);
  });

  test("prefers the declared MC_ACTING_ON receipt when several match", () => {
    writeReceipt({ decisionId: "CARD-A", authorises: { tools: ["Bash"], patterns: ["echo *"] } });
    writeReceipt({ decisionId: "CARD-B", authorises: { tools: ["Bash"], patterns: ["echo *"] } });
    const up = tryConsentUpgrade({
      tool: "Bash",
      command: "MC_ACTING_ON=CARD-B echo hello",
      decision: "ask",
      env: env(),
    });
    assert.ok(up);
    assert.equal(up.decisionId, "CARD-B");
  });
});

describe("binding keys fail independently", () => {
  test("expired receipt: no upgrade", () => {
    writeReceipt({ expiresAt: "2026-06-10T15:59:00Z" });
    const up = tryConsentUpgrade({
      tool: "Bash",
      command: "example-cmd run --flag",
      decision: "ask",
      env: env(),
    });
    assert.equal(up, null);
  });

  test("not-yet-valid receipt (tappedAt in the future): no upgrade", () => {
    writeReceipt({ tappedAt: "2026-06-10T16:05:00Z" });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "example-cmd run --flag", decision: "ask", env: env() }),
      null,
    );
  });

  test("scope mismatch, wrong tool: no upgrade", () => {
    writeReceipt();
    assert.equal(
      tryConsentUpgrade({ tool: "Write", command: "example-cmd run --flag", decision: "ask", env: env() }),
      null,
    );
  });

  test("scope mismatch, command outside patterns: no upgrade", () => {
    writeReceipt();
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "rm -rf /tmp/x", decision: "ask", env: env() }),
      null,
    );
  });

  test("absent or empty authorises scope authorises nothing", () => {
    writeReceipt({ authorises: undefined }, { name: "no-scope.json" });
    writeReceipt({ decisionId: "EMPTY", authorises: { tools: [], patterns: [] } });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "anything", decision: "ask", env: env() }),
      null,
    );
  });
});

describe("forgery", () => {
  test("bad HMAC: no upgrade", () => {
    writeReceipt({}, { sign: false });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "example-cmd run --flag", decision: "ask", env: env() }),
      null,
    );
  });

  test("signed with the wrong key: no upgrade", () => {
    writeReceipt({}, { key: "attacker-key" });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "example-cmd run --flag", decision: "ask", env: env() }),
      null,
    );
  });

  test("tampered field after signing: no upgrade", () => {
    const path = writeReceipt();
    const receipt = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    receipt.authorises = { tools: ["Bash"], patterns: ["*"] }; // widen scope post-sign
    writeFileSync(path, JSON.stringify(receipt));
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "rm -rf /", decision: "ask", env: env() }),
      null,
    );
  });
});

describe("destructive class (block): two-tap + single-use", () => {
  test("block + confirmed:false: no upgrade", () => {
    writeReceipt({ confirmed: false });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "example-cmd run --flag", decision: "block", env: env() }),
      null,
    );
  });

  test("block + confirmed:true: upgrade, receipt consumed by atomic rename", () => {
    writeReceipt({ confirmed: true });
    const up = tryConsentUpgrade({
      tool: "Bash",
      command: "example-cmd run --flag",
      decision: "block",
      env: env(),
    });
    assert.ok(up);
    assert.equal(up.consumed, true);
    assert.equal(existsSync(join(dir, "TEST-CARD.json")), false);
    assert.equal(existsSync(join(dir, "TEST-CARD.used.json")), true);
  });

  test("second destructive call after consumption: no upgrade (re-asks)", () => {
    writeReceipt({ confirmed: true });
    const first = tryConsentUpgrade({
      tool: "Bash", command: "example-cmd run --flag", decision: "block", env: env(),
    });
    assert.ok(first);
    const second = tryConsentUpgrade({
      tool: "Bash", command: "example-cmd run --flag", decision: "block", env: env(),
    });
    assert.equal(second, null);
  });

  test("used receipts are never read back as live consent", () => {
    writeReceipt({ confirmed: true }, { name: "OLD.used.json" });
    assert.equal(
      tryConsentUpgrade({ tool: "Bash", command: "example-cmd run --flag", decision: "block", env: env() }),
      null,
    );
    assert.deepEqual(readdirSync(dir), ["OLD.used.json"]);
  });

  test("a confirmed receipt still serves the standard class without being consumed", () => {
    writeReceipt({ confirmed: true });
    const up = tryConsentUpgrade({
      tool: "Bash", command: "example-cmd run --flag", decision: "ask", env: env(),
    });
    assert.ok(up);
    assert.equal(up.consumed, false);
    assert.equal(existsSync(join(dir, "TEST-CARD.json")), true);
  });
});

describe("fail-closed", () => {
  test("layer disabled when consentDir unset", () => {
    writeReceipt();
    assert.equal(
      tryConsentUpgrade({
        tool: "Bash", command: "example-cmd run --flag", decision: "ask",
        env: env({ consentDir: undefined }),
      }),
      null,
    );
  });

  test("layer disabled when hmacKey unset", () => {
    writeReceipt();
    assert.equal(
      tryConsentUpgrade({
        tool: "Bash", command: "example-cmd run --flag", decision: "ask",
        env: env({ hmacKey: undefined }),
      }),
      null,
    );
  });

  test("missing consent dir: no upgrade, no throw", () => {
    assert.equal(
      tryConsentUpgrade({
        tool: "Bash", command: "x", decision: "ask",
        env: env({ consentDir: join(dir, "does-not-exist") }),
      }),
      null,
    );
  });

  test("malformed receipt JSON: skipped, valid sibling still honoured", () => {
    writeFileSync(join(dir, "garbage.json"), "{not json");
    writeReceipt();
    const up = tryConsentUpgrade({
      tool: "Bash", command: "example-cmd run --flag", decision: "ask", env: env(),
    });
    assert.ok(up);
  });
});

describe("helpers", () => {
  test("declaredDecisionId parses a leading assignment only", () => {
    assert.equal(declaredDecisionId("MC_ACTING_ON=CARD-9 example-cmd run"), "CARD-9");
    assert.equal(declaredDecisionId("echo MC_ACTING_ON=CARD-9"), null);
    assert.equal(declaredDecisionId("example-cmd run"), null);
  });

  test("commandMatchesPattern is anchored and literal apart from *", () => {
    assert.equal(commandMatchesPattern("example-cmd run --flag", "example-cmd run*"), true);
    assert.equal(commandMatchesPattern("xexample-cmd run", "example-cmd run*"), false);
    assert.equal(commandMatchesPattern("rm -rf /", "rm -rf /tmp/*"), false);
    // regex metachars in the pattern are literal
    assert.equal(commandMatchesPattern("a.b", "a.b"), true);
    assert.equal(commandMatchesPattern("axb", "a.b"), false);
  });
});
