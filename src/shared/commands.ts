// Decides whether a model-suggested cleanup command may run.
//
// This is an allowlist: a command runs only if it is one of a few known cleanup commands, or an
// `rm` of a single path inside the plan item. Commands are split into argv here and run without a
// shell, so newlines, variables, globs and chaining can't do anything even if they slipped through.

import { absPath, deleteBlockReason, isInside, realTarget } from "./paths";
import { expandHome } from "../tools/scan";

export type CommandCheck = { ok: true; argv: string[] } | { ok: false; reason: string };

// Keep in sync with the list in PLAN_REQUEST (prompts.ts).
const TOOL_COMMANDS: { base: string[]; flags?: string[] }[] = [
  { base: ["npm", "cache", "clean", "--force"] },
  { base: ["yarn", "cache", "clean"] },
  { base: ["pnpm", "store", "prune"] },
  { base: ["brew", "cleanup"], flags: ["-s", "--prune=all"] },
  { base: ["pip", "cache", "purge"] },
  { base: ["pip3", "cache", "purge"] },
  { base: ["docker", "system", "prune"], flags: ["-a", "--all", "-f", "--force"] },
  { base: ["docker", "image", "prune"], flags: ["-a", "--all", "-f", "--force"] },
  { base: ["docker", "builder", "prune"], flags: ["-a", "--all", "-f", "--force"] },
  { base: ["xcrun", "simctl", "delete", "unavailable"] },
  { base: ["flutter", "pub", "cache", "clean"], flags: ["-f", "--force"] },
  { base: ["dart", "pub", "cache", "clean"], flags: ["-f", "--force"] },
  { base: ["pod", "cache", "clean", "--all"] },
  { base: ["go", "clean", "-cache"] },
  { base: ["go", "clean", "-modcache"] },
];

const RM_FLAGS = new Set(["-r", "-R", "-f", "-rf", "-fr", "-Rf", "-fR"]);

/** Splits a command into words. Supports '…' and "…" quoting; rejects anything shell-like. */
export function tokenize(command: string): string[] | { error: string } {
  if (/[\u0000-\u001f\u007f]/.test(command)) return { error: "contains line breaks or control characters" };
  if (/[;&|`<>$\\*?[\]{}!#]/.test(command)) {
    return { error: "contains shell syntax (chaining, pipes, redirects, variables, globs or escapes)" };
  }

  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === " ") {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) return { error: "has an unclosed quote" };
  if (inToken) tokens.push(current);
  if (tokens.length === 0) return { error: "is empty" };
  return tokens;
}

export function checkCommand(command: string, itemPath: string): CommandCheck {
  const tokens = tokenize(command.trim());
  if (!Array.isArray(tokens)) return { ok: false, reason: tokens.error };
  if (tokens[0] === "sudo") return { ok: false, reason: "uses sudo" };

  // Known tool cleanup commands: exact base words, then only the listed optional flags.
  for (const { base, flags = [] } of TOOL_COMMANDS) {
    if (tokens.length < base.length || !base.every((w, i) => tokens[i] === w)) continue;
    const extra = tokens.slice(base.length);
    const bad = extra.find((f) => !flags.includes(f));
    if (bad !== undefined) return { ok: false, reason: `uses an option that isn't allowed here (${bad})` };
    return { ok: true, argv: tokens };
  }

  if (tokens[0] !== "rm") return { ok: false, reason: `isn't one of the allowed cleanup commands (${tokens[0]})` };

  // rm [-r|-f|-rf…] <one path>
  const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
  const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const badFlag = flags.find((f) => !RM_FLAGS.has(f));
  if (badFlag) return { ok: false, reason: `uses an rm option that isn't allowed (${badFlag})` };
  if (operands.length !== 1) return { ok: false, reason: "must remove exactly one path" };

  const operand = operands[0];
  if (operand.startsWith("~") && operand !== "~" && !operand.startsWith("~/")) {
    return { ok: false, reason: `refers to another user's home folder (${operand})` };
  }
  const target = realTarget(operand);
  const blocked = deleteBlockReason(target);
  if (blocked) return { ok: false, reason: `would delete a protected location: ${blocked}` };
  if (!isInside(target, realTarget(itemPath))) {
    return { ok: false, reason: `deletes ${target}, which is not ${absPath(itemPath)} or inside it` };
  }
  return { ok: true, argv: ["rm", ...flags, expandHome(target)] };
}
