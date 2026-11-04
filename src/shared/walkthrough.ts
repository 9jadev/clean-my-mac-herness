// Phase 3: walk through the plan one item at a time, and only run a command when the user says yes.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { formatBytes, freeBytes } from "../tools/scan";
import { checkCommand } from "./commands";
import { parsePlanItems, reviewPlan, type PlanItem } from "./plan";
import type { ScanLog } from "./scan-tool";
import type { Transcript } from "./transcript";

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Asks one question. A fresh readline is created and closed each time so that, between
 * questions, nothing in this process holds the terminal. That is what lets a command we run
 * (e.g. `flutter pub cache clean`, which asks "Are you sure?") read the user's answer itself.
 * Ctrl+C or Ctrl+D at the prompt counts as "q".
 */
export function ask(question: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePromise(answer.trim().toLowerCase());
    };
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish("q");
    });
    rl.on("close", () => finish("q"));
    rl.question(question).then(finish, () => finish("q"));
  });
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/**
 * Runs a command with the terminal handed over to it completely: it gets our stdin, stdout
 * and stderr directly, the terminal is out of raw mode, and our own stdin is paused, so any
 * question the command asks behaves exactly as if you'd typed the command yourself.
 * Ctrl+C stops only the command, not the walkthrough.
 */
export function runCommand(argv: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();

    const ignoreSigint = () => {};
    process.on("SIGINT", ignoreSigint);

    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", ignoreSigint);
      resolvePromise(r);
    };

    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", timeout: COMMAND_TIMEOUT_MS });
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({
        code: null,
        signal: null,
        error: err.code === "ENOENT" ? `command not found: ${argv[0]}` : err.message,
      }),
    );
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

const SAFETY_LABEL = { safe: "✅ Safe to remove", caution: "⚠️  Be careful", unsafe: "⛔ Don't delete" };

function describeExit(r: RunResult): string {
  if (r.error) return r.error;
  if (r.signal === "SIGTERM") return `stopped after ${COMMAND_TIMEOUT_MS / 60000} minutes`;
  if (r.signal) return `stopped (${r.signal === "SIGINT" ? "Ctrl+C" : r.signal})`;
  return `exit code ${r.code}`;
}

export async function walkthrough(items: PlanItem[], opts: { dryRun: boolean; transcript: Transcript }) {
  const { dryRun, transcript } = opts;
  const summary: string[] = [];
  let freed = 0;

  for (const [i, item] of items.entries()) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${i + 1}/${items.length}] ${item.title}  (${item.size})`);
    console.log(`  Path:      ${item.path}`);
    console.log(`  What:      ${item.whatItIs}`);
    console.log(`  Safety:    ${SAFETY_LABEL[item.safety]} — ${item.safetyReason}`);
    console.log(`  Sensitive: ${item.sensitive ? `🔒 Yes — ${item.sensitiveNote || "may contain private data"}` : "No"}`);

    // Only safe, non-sensitive items with an allowed command are offered for running.
    let skipWhy: string | null = null;
    let argv: string[] | null = null;
    if (item.safety !== "safe") skipWhy = "not marked safe, so nothing will be run. Review it yourself.";
    else if (item.sensitive) skipWhy = "may contain sensitive data, so nothing will be run. Review it yourself.";
    else if (!item.command) skipWhy = "no cleanup command suggested.";
    else {
      const check = checkCommand(item.command, item.path);
      if (check.ok) argv = check.argv;
      else skipWhy = `the suggested command was blocked because it ${check.reason}:\n    ${item.command}`;
    }

    if (skipWhy || !argv) {
      console.log(`  → Skipping: ${skipWhy}`);
      summary.push(`skipped  ${item.title}`);
      transcript.log("skip", { title: item.title, reason: skipWhy });
      continue;
    }

    console.log(`\n  Command:   ${item.command}`);
    console.log(`  Effect:    ${item.commandEffect}`);

    const answer = await ask(`\n  Run this command? [y/N/q] `);
    transcript.log("answer", { title: item.title, answer });
    if (answer === "q" || answer === "quit") {
      summary.push(`stopped  (quit at ${item.title})`);
      break;
    }
    if (answer !== "y" && answer !== "yes") {
      console.log("  → Skipped.");
      summary.push(`declined ${item.title}`);
      continue;
    }
    if (dryRun) {
      console.log(`  → Dry run: would run ${JSON.stringify(argv)}`);
      summary.push(`dry-run  ${item.title}`);
      continue;
    }

    const before = await freeBytes();
    console.log(`\n  ┌─ Running: ${item.command}`);
    console.log(`  │  If it asks you something, type your answer and press Enter: you're talking to the command directly.`);
    console.log(`  │  Ctrl+C stops just this command.`);
    console.log(`  └${"─".repeat(40)}\n`);
    const result = await runCommand(argv);
    const after = await freeBytes();
    const delta = before !== null && after !== null ? after - before : 0;
    if (delta > 0) freed += delta;
    transcript.log("run", { title: item.title, argv, ...result, freedBytes: delta });

    console.log(`\n  ${"─".repeat(40)}`);
    if (result.code === 0) {
      console.log(`  ✓ Done.${delta > 0 ? ` Freed about ${formatBytes(delta)}.` : ""}`);
      summary.push(`ran      ${item.title}${delta > 0 ? `  (−${formatBytes(delta)})` : ""}`);
    } else {
      console.log(`  ✗ Didn't finish: ${describeExit(result)}.`);
      summary.push(`failed   ${item.title}  (${describeExit(result)})`);
    }
  }

  console.log(`\n${"═".repeat(60)}\nSummary`);
  for (const line of summary) console.log(`  ${line}`);
  if (freed > 0) console.log(`\n  Total freed: about ${formatBytes(freed)} (measured as free disk space)`);
}

/** Everything after the model has produced a plan: harness checks, then the walkthrough. */
export async function runCleanup(
  rawPlan: unknown,
  scanned: ScanLog,
  opts: { dryRun: boolean; transcript: Transcript },
) {
  const { kept, dropped } = reviewPlan(parsePlanItems(rawPlan), scanned);
  for (const d of dropped) console.error(`  (dropped "${d.item.title}" at ${d.item.path}: ${d.reason})`);
  opts.transcript.log("plan", { items: kept, dropped });

  if (kept.length === 0) {
    console.log("No cleanup items to walk through.");
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("Not running in an interactive terminal, so I won't ask to run anything.");
    return;
  }
  console.log(`\nLet's go through ${kept.length} item${kept.length === 1 ? "" : "s"}.${opts.dryRun ? " (dry run)" : ""}`);
  await walkthrough(kept, opts);
}
