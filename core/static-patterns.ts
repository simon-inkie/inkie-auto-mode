import type { ClassifierDecision } from './types.js';

/**
 * Hard-coded BLOCK patterns — always block, non-overridable.
 * These are TypeScript constants compiled into the hook for tamper resistance.
 */
const STATIC_BLOCK: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*\/\s*$/i, reason: 'Delete root filesystem' },
  { pattern: /\brm\s+(-[a-z]*\s+)*~\/?\s*$/i, reason: 'Delete entire home directory' },
  // Match `rm -rf /home` or `rm -rf /home/` with nothing further — the top-level
  // dir itself. Explicit sub-paths like `/home/simon/project/build` fall through
  // to the LLM classifier, which can reason about whether the specific path is
  // safe. Without this narrowing, every `rm -rf /home/<user>/<anything>` was
  // being false-positive blocked.
  { pattern: /\brm\s+(-[a-z]*\s+)*\/(home|etc|var|usr|boot|sys|proc|lib|bin|sbin)\/?(\s|$)/i, reason: 'Delete critical system directory' },
  { pattern: /\|\s*(bash|sh|zsh|eval)\b/, reason: 'Pipe to shell interpreter' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh)/, reason: 'Download and execute pattern (curl | bash)' },
  { pattern: /\bwget\b.*\|\s*(bash|sh)/, reason: 'Download and execute pattern (wget | bash)' },
  { pattern: /\beval\s*\$\(/, reason: 'Eval with command substitution' },
  { pattern: /cat\s+~\/\.(ssh|aws|gnupg)\//, reason: 'Credential file access' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Direct disk device write' },
  { pattern: /chmod\s+777\s+\//, reason: 'chmod 777 on root paths' },
  { pattern: /\bsudo\s+(rm|chmod|chown|mkfs|dd)\b/, reason: 'sudo with destructive command' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format command' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'dd writing to device' },
  { pattern: />\s*\/etc\//, reason: 'Overwrite system config file' },
  { pattern: /curl\b.*-[a-zA-Z]*d\s*@/, reason: 'Data exfiltration via curl POST' },
  { pattern: /\.env\b.*\|.*curl\b/i, reason: 'Env file piped to curl (exfiltration)' },
  { pattern: /\.env\b.*\|.*wget\b/i, reason: 'Env file piped to wget (exfiltration)' },
  { pattern: /cat.*\.env\b.*\|.*(?:curl|wget|nc|ncat)\b/i, reason: 'Env file content sent externally' },
  { pattern: /grep.*\.env\b.*\|.*(?:curl|wget|nc|ncat)\b/i, reason: 'Env file key extraction and exfiltration' },
  { pattern: /\bnc\s+-[a-z]*l/, reason: 'Netcat listener (reverse shell risk)' },
  { pattern: /\/etc\/sudoers/, reason: 'Sudoers file access' },
  { pattern: /\bsystemctl\s+(enable|start|restart)\b/, reason: 'Systemd service manipulation' },
  { pattern: /crontab\s+-/, reason: 'Cron job modification' },
];

/**
 * Hard-coded ALLOW patterns — conservative, structurally safe.
 * Only fires if command has NO shell chaining operators.
 */
const STATIC_ALLOW: Array<{ pattern: RegExp; reason: string }> = [
  // Filesystem reads
  { pattern: /^ls\b/, reason: 'List directory' },
  { pattern: /^pwd\s*$/, reason: 'Print working directory' },
  { pattern: /^echo\s/, reason: 'Echo command' },
  { pattern: /^cat\s+(?!\/etc\/|~\/\.|\/home\/[^/]+\/\.)/, reason: 'Cat (safe paths)' },
  { pattern: /^head\s/, reason: 'Head command' },
  { pattern: /^tail\s/, reason: 'Tail command' },
  { pattern: /^wc\s/, reason: 'Word count' },
  { pattern: /^less\s/, reason: 'Less pager' },
  { pattern: /^file\s/, reason: 'File type check' },
  { pattern: /^stat\s/, reason: 'File stat' },
  { pattern: /^du\s/, reason: 'Disk usage' },
  { pattern: /^df\s/, reason: 'Disk free' },
  { pattern: /^readlink\s/, reason: 'Read symlink' },
  { pattern: /^realpath\s/, reason: 'Resolve path' },
  { pattern: /^which\s/, reason: 'Which command lookup' },
  { pattern: /^type\s/, reason: 'Type command lookup' },

  // Search
  { pattern: /^grep\b/, reason: 'Grep search' },
  { pattern: /^rg\s/, reason: 'Ripgrep search' },
  { pattern: /^find\s+(?!.*(-exec|-delete|-ok))/, reason: 'Find without -exec/-delete' },
  { pattern: /^sed\s+-n\s/, reason: 'Sed print-only (no -i)' },
  { pattern: /^awk\s/, reason: 'Awk (read-only by default)' },

  // Git (read + common write operations)
  { pattern: /^git\s+(status|log|diff|branch|show|blame|remote|tag|stash list|rev-parse|ls-files|ls-remote)\b/, reason: 'Git read operation' },
  { pattern: /^git\s+(fetch|pull|checkout|switch|add|commit|merge|rebase|stash|cherry-pick)\b/, reason: 'Git standard write operation' },
  { pattern: /^git\s+push\b(?!.*--force)/, reason: 'Git push (no --force)' },

  // Directory ops — mkdir/cd/touch are safe; cp/mv go to LLM (can overwrite critical files)
  { pattern: /^mkdir\s/, reason: 'Create directory' },
  { pattern: /^cd\s/, reason: 'Change directory' },
  { pattern: /^touch\s/, reason: 'Touch file' },

  // Dev tooling — only non-arbitrary-execution tools get static allow
  { pattern: /^(pnpm|npm|yarn|bun)\s+(install|add|remove|run|exec|test|build|start|dev|typecheck|lint|benchmark|view|info|why|outdated|ls)\b/, reason: 'Package manager operation' },
  { pattern: /^tsc\b/, reason: 'TypeScript compiler' },
  { pattern: /^vitest\b/, reason: 'Vitest runner' },
  { pattern: /^jest\b/, reason: 'Jest runner' },
  // node/python/npx/tsx are arbitrary code execution — go to LLM
  { pattern: /^docker\s+(ps|images|logs|inspect|stats)\b/, reason: 'Docker read-only' },
  // docker exec → LLM (arbitrary command in container)
  // curl → LLM (can exfiltrate data via POST)

  // Platform tools — read-only subcommands only
  { pattern: /^openclaw\s+(--version|status|doctor|plugins|hooks|gateway)\b/, reason: 'OpenClaw read-only' },
  { pattern: /^gh\s+(pr|issue)\s+(view|list|status|checks)\b/, reason: 'GitHub CLI read-only' },
  // gh api, supabase, claude CLI → LLM (can mutate state)

  // System info
  { pattern: /^(uname|hostname|whoami|id|date|uptime|free|env|printenv|locale|lsb_release)\b/, reason: 'System info command' },
  { pattern: /^ps\s/, reason: 'Process list' },
  { pattern: /^(journalctl|systemctl\s+status)\b/, reason: 'Systemd read-only' },
  { pattern: /^lsof\s/, reason: 'List open files' },
  { pattern: /^ss\s/, reason: 'Socket stats' },

  // Chmod (non-recursive, non-root)
  { pattern: /^chmod\s+\+x\s/, reason: 'Make executable' },
];

/**
 * Known-safe pipe suffixes and redirections. These are stripped from the
 * command before checking ALLOW patterns, so `grep foo | head -5` is treated
 * as just `grep foo` for pattern matching purposes.
 *
 * NEVER add a command that can execute code or write files (interpreters,
 * `tee`, anything with an output-file flag). Stripping happens BEFORE the
 * SHELL_CHAIN_PATTERN guard in evaluateStatic, so a suffix listed here takes
 * its pipe with it: the guard never sees the chain, and a benign prefix then
 * launders the payload into a static ALLOW that the LLM classifier never gets
 * to see. `ls | python3 -c '<anything>'` and `ls | tee <anywhere>` were both
 * silently allowed this way until 2026-07-25. Only inert output filters here.
 */
const SAFE_SUFFIXES = [
  /\s*\|\s*(head|tail|wc|sort|uniq|less|cat|tr|cut|column|jq)\b[^|;`]*/g,
  /\s*\|\s*grep\b[^|;`]*/g,
  /\s*\|\s*sed\s+-n\b[^|;`]*/g,
  /\s*\|\s*awk\b[^|;`]*/g,
  /\s*2>\s*\/dev\/null/g,
  /\s*2>&1/g,
  /\s*\|\|\s*(echo|true|:)\b[^;`]*/g,
  /\s*&&\s*(echo|true|:)\b[^;`]*/g,
];

/** Characters/sequences that indicate shell chaining or redirection — disqualifies ALLOW */
const SHELL_CHAIN_PATTERN = /[|;&`]|\$\(|>>|>\s*[\/~]/;

/**
 * User-configurable patterns (loaded once at startup, immutable after).
 * Additive only — cannot override hard-coded patterns.
 */
let userBlockPatterns: RegExp[] = [];
let userAllowPatterns: RegExp[] = [];

export function loadUserPatterns(blockPatterns: string[], allowPatterns: string[]): void {
  userBlockPatterns = blockPatterns.map(p => new RegExp(p));
  userAllowPatterns = allowPatterns.map(p => new RegExp(p));
}

/**
 * Evaluate a command against static patterns.
 * Returns a decision if matched, or null to fall through to LLM.
 */
export function evaluateStatic(command: string): ClassifierDecision | null {
  const trimmed = command.trim();

  // Check hard-coded BLOCK patterns first (highest priority)
  for (const { pattern, reason } of STATIC_BLOCK) {
    if (pattern.test(trimmed)) {
      return { decision: 'block', reason, stage: 'static', durationMs: 0 };
    }
  }

  // Check user-configured BLOCK patterns
  for (const pattern of userBlockPatterns) {
    if (pattern.test(trimmed)) {
      return { decision: 'block', reason: 'Matched user block pattern', stage: 'static', durationMs: 0 };
    }
  }

  // Strip known-safe suffixes (| head, | grep, 2>/dev/null, || echo, etc.)
  // before checking allow patterns. This lets `grep foo | head -5` match the
  // `grep` allow pattern without being blocked by the shell-chain guard.
  let stripped = trimmed;
  for (const suffix of SAFE_SUFFIXES) {
    stripped = stripped.replace(suffix, '');
  }
  stripped = stripped.trim();

  // ALLOW patterns fire if the stripped command has no remaining shell operators
  if (!SHELL_CHAIN_PATTERN.test(stripped)) {
    // Check hard-coded ALLOW patterns
    for (const { pattern, reason } of STATIC_ALLOW) {
      if (pattern.test(stripped)) {
        return { decision: 'allow', reason, stage: 'static', durationMs: 0 };
      }
    }

    // Check user-configured ALLOW patterns
    for (const pattern of userAllowPatterns) {
      if (pattern.test(stripped)) {
        return { decision: 'allow', reason: 'Matched user allow pattern', stage: 'static', durationMs: 0 };
      }
    }
  }

  // No match — fall through to LLM
  return null;
}

/** Export for testing/benchmark visibility */
export { STATIC_BLOCK, STATIC_ALLOW };
