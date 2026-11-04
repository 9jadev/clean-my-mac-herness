// Claude version of the harness: same three phases as agent-deepseek.ts.
//   Phase 1: Claude scans with scan_folder (the SDK's tool runner drives the loop).
//   Phase 2: Claude turns its findings into a cleanup plan (structured output, validated by zod).
//   Phase 3: the shared walkthrough asks before running anything.
//
// Usage:
//   npm run agent -- "What's using the most space in my home folder?"
//   npm run agent -- --dry-run "..."   (walk through, but never run anything)
//   npm run agent -- --no-log "..."    (don't write a transcript to ./logs)

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Plan } from "./shared/plan";
import { PLAN_REQUEST, SCAN_PATH_DESCRIPTION, SCAN_TOOL_DESCRIPTION, SCAN_TOP_DESCRIPTION, SYSTEM } from "./shared/prompts";
import { ScanLog, runScanTool } from "./shared/scan-tool";
import { Transcript } from "./shared/transcript";
import { runCleanup } from "./shared/walkthrough";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY or an `ant auth login` profile
const MODEL = "claude-opus-5-5";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const dryRun = flags.has("--dry-run");
const question = argv.filter((a) => !a.startsWith("--")).join(" ") || "What's using the most space in my home folder?";
const transcript = new Transcript("claude", !flags.has("--no-log"));
const scanned = new ScanLog();

const scanTool = betaZodTool({
  name: "scan_folder",
  description: SCAN_TOOL_DESCRIPTION,
  inputSchema: z.object({
    path: z.string().describe(SCAN_PATH_DESCRIPTION),
    top: z.number().int().min(1).max(50).optional().describe(SCAN_TOP_DESCRIPTION),
  }),
  run: ({ path, top }) => runScanTool(path, top ?? 10, scanned),
});

transcript.log("start", { model: MODEL, question, dryRun });

// --- Phase 1: scan -----------------------------------------------------------

const runner = client.beta.messages.toolRunner({
  model: MODEL,
  max_tokens: 16000,
  max_iterations: 20,
  output_config: { effort: "medium" },
  // If the model declines, the API retries on a fallback model automatically.
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: SYSTEM,
  tools: [scanTool],
  messages: [{ role: "user", content: question }],
});

let final: Anthropic.Beta.BetaMessage | undefined;
for await (const message of runner) {
  final = message;
  transcript.log("response", { stop: message.stop_reason, content: message.content, usage: message.usage });
}

if (!final) {
  console.error("No response.");
  process.exit(1);
}
if (final.stop_reason === "refusal") {
  console.error("The model declined this request.");
  process.exit(1);
}
for (const block of final.content) {
  if (block.type === "text") console.log(block.text);
}
if (final.stop_reason === "tool_use" || final.stop_reason === "max_tokens") {
  console.error(`\n(stopped early: ${final.stop_reason}; no cleanup plan)`);
  process.exit(1);
}

// --- Phase 2: cleanup plan ---------------------------------------------------

// The runner's history may not include its last reply yet; add it if it's missing.
const history: Anthropic.Beta.BetaMessageParam[] = [...runner.params.messages];
if (history.at(-1)?.role !== "assistant") history.push({ role: "assistant", content: final.content });

console.error("  → building cleanup plan");
const planResponse = await client.beta.messages.parse({
  model: MODEL,
  max_tokens: 16000,
  output_config: { effort: "medium", format: betaZodOutputFormat(Plan) },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: SYSTEM,
  // The history contains scan_folder calls, so the tool must still be defined; "none" stops new calls.
  tools: [scanTool],
  tool_choice: { type: "none" },
  messages: [...history, { role: "user", content: PLAN_REQUEST }],
});
transcript.log("plan_response", { stop: planResponse.stop_reason, usage: planResponse.usage });

if (planResponse.stop_reason === "refusal") {
  console.error("The model declined to build a cleanup plan.");
  process.exit(1);
}
if (!planResponse.parsed_output) {
  console.error(`Couldn't read the cleanup plan (stop reason: ${planResponse.stop_reason}).`);
  process.exit(1);
}

// --- Phase 3: walkthrough ----------------------------------------------------

await runCleanup(planResponse.parsed_output, scanned, { dryRun, transcript });
if (transcript.file) console.error(`  (transcript: ${transcript.file})`);
