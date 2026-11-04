// DeepSeek version of the harness.
//   Phase 1: the model scans the disk with scan_folder and explains where the space goes.
//   Phase 2: the model turns that into a structured cleanup plan (JSON), checked by the harness.
//   Phase 3: we walk through the plan one item at a time. For safe items we show the
//            exact command and what it does, and only run it if the user says yes.
//
// Usage:
//   export DEEPSEEK_API_KEY=...
//   npm run agent:deepseek -- "What's using the most space in my home folder?"
//   npm run agent:deepseek -- --dry-run "..."   (walk through, but never run anything)
//   npm run agent:deepseek -- --no-log "..."    (don't write a transcript to ./logs)
//
// Optional environment variables:
//   DEEPSEEK_MODEL          model name (default "deepseek-chat"; "deepseek-reasoner" also works)
//   DEEPSEEK_MAX_TOKENS     output limit per call (default 8192)
//   DEEPSEEK_STRICT_TOOLS=1 use DeepSeek's beta endpoint with strict tool schemas
//   DEEPSEEK_BASE_URL       override the API URL

import OpenAI from "openai";
import { PLAN_REQUEST, SCAN_PATH_DESCRIPTION, SCAN_TOOL_DESCRIPTION, SCAN_TOP_DESCRIPTION, SYSTEM } from "./shared/prompts";
import { ScanLog, runScanTool } from "./shared/scan-tool";
import { Transcript } from "./shared/transcript";
import { runCleanup } from "./shared/walkthrough";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Set DEEPSEEK_API_KEY first.");
  process.exit(1);
}

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS) || 8192;
const STRICT_TOOLS = process.env.DEEPSEEK_STRICT_TOOLS === "1";
const MAX_ROUNDS = 20;
const PLAN_ATTEMPTS = 3;

const client = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL ?? (STRICT_TOOLS ? "https://api.deepseek.com/beta" : "https://api.deepseek.com"),
  apiKey: process.env.DEEPSEEK_API_KEY,
  timeout: 5 * 60 * 1000, // DeepSeek can be slow under load
  maxRetries: 3,
});

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type CreateParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "model">;

// DeepSeek-only fields that the OpenAI types don't know about.
type DeepSeekUsage = OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
type DeepSeekMessage = OpenAI.Chat.Completions.ChatCompletionMessage & { reasoning_content?: string };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const dryRun = flags.has("--dry-run");
const question = argv.filter((a) => !a.startsWith("--")).join(" ") || "What's using the most space in my home folder?";
const transcript = new Transcript("deepseek", !flags.has("--no-log"));
const scanned = new ScanLog();

// ---------------------------------------------------------------------------
// API calls, with usage tracking
// ---------------------------------------------------------------------------

const usage = { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 };

async function chat(params: CreateParams) {
  const response = await client.chat.completions.create({ model: MODEL, max_tokens: MAX_TOKENS, ...params });
  const u = response.usage as DeepSeekUsage | undefined;
  usage.calls++;
  if (u) {
    usage.prompt += u.prompt_tokens;
    usage.completion += u.completion_tokens;
    usage.cacheHit += u.prompt_cache_hit_tokens ?? 0;
    usage.cacheMiss += u.prompt_cache_miss_tokens ?? 0;
  }
  const choice = response.choices[0];
  transcript.log("response", { finish: choice.finish_reason, message: choice.message, usage: u });
  return response;
}

function printUsage() {
  const hitRate = usage.prompt > 0 ? Math.round((usage.cacheHit / usage.prompt) * 100) : 0;
  console.error(
    `\n  (${usage.calls} API calls · ${usage.prompt.toLocaleString()} prompt tokens, ${hitRate}% from cache · ` +
      `${usage.completion.toLocaleString()} output tokens)`,
  );
  transcript.log("usage", usage);
}

// ---------------------------------------------------------------------------
// Phase 1: scan loop
// ---------------------------------------------------------------------------

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "scan_folder",
      description: SCAN_TOOL_DESCRIPTION,
      ...(STRICT_TOOLS ? { strict: true } : {}),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: SCAN_PATH_DESCRIPTION },
          top: { type: "integer", minimum: 1, maximum: 50, description: SCAN_TOP_DESCRIPTION },
        },
        // Strict mode wants every property listed as required.
        required: STRICT_TOOLS ? ["path", "top"] : ["path"],
        additionalProperties: false,
      },
    },
  },
];

async function runTool(name: string, rawArgs: string): Promise<string> {
  if (name !== "scan_folder") return `Error: unknown tool "${name}"`;
  let args: { path?: unknown; top?: unknown };
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return `Error: arguments were not valid JSON (possibly cut off): ${rawArgs}`;
  }
  if (typeof args.path !== "string" || args.path.length === 0) return 'Error: "path" must be a non-empty string';
  return runScanTool(args.path, typeof args.top === "number" ? args.top : 10, scanned);
}

/** Copy of an assistant reply that is safe to send back (keeps reasoning_content for thinking mode). */
function assistantTurn(msg: DeepSeekMessage): Msg {
  return {
    role: "assistant",
    content: msg.content ?? "",
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
  } as Msg;
}

async function runScanLoop(messages: Msg[]): Promise<string> {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await chat({ messages, tools });
    const choice = response.choices[0];
    const msg = choice.message as DeepSeekMessage;
    messages.push(assistantTurn(msg));

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      if (choice.finish_reason === "length") console.error("\n(summary cut off: hit the output limit)");
      return msg.content ?? "";
    }

    // Run this round's scans in parallel; every tool call needs a matching tool message.
    const results = await Promise.all(
      calls.map((call) =>
        call.type === "function"
          ? runTool(call.function.name, call.function.arguments)
          : Promise.resolve(`Error: unsupported tool call type "${call.type}"`),
      ),
    );
    calls.forEach((call, i) => messages.push({ role: "tool", tool_call_id: call.id, content: results[i] }));
  }

  // Out of rounds: keep what was learned instead of throwing it away.
  console.error(`  (reached ${MAX_ROUNDS} scan rounds; asking for a summary of what was found so far)`);
  messages.push({
    role: "user",
    content: "You've reached the scan limit. Don't scan anything else; summarise what you found so far.",
  });
  const response = await chat({ messages, tools, tool_choice: "none" });
  const msg = response.choices[0].message as DeepSeekMessage;
  messages.push(assistantTurn(msg));
  return msg.content ?? "";
}

// ---------------------------------------------------------------------------
// Phase 2: structured cleanup plan
// ---------------------------------------------------------------------------

/** Parses JSON, tolerating ```json fences or text around the object. */
function extractJson(raw: string): unknown {
  const attempts = [raw, raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) attempts.push(raw.slice(start, end + 1));
  for (const text of attempts) {
    try {
      return JSON.parse(text);
    } catch {
      // try the next form
    }
  }
  return undefined;
}

async function getPlan(messages: Msg[]): Promise<unknown> {
  // A new user turn starts here. Thinking-mode models expect earlier reasoning to be dropped.
  for (const m of messages) if (m.role === "assistant") delete (m as { reasoning_content?: string }).reasoning_content;

  let jsonMode = true;
  let extra = "";
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    const request: Msg = { role: "user", content: PLAN_REQUEST + extra };
    let response;
    try {
      response = await chat({
        messages: [...messages, request],
        temperature: 0,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });
    } catch (err) {
      // Some DeepSeek models don't accept JSON mode. Fall back to asking for plain JSON once.
      if (jsonMode && err instanceof OpenAI.BadRequestError) {
        console.error(`  (JSON mode was rejected: ${err.message}; retrying without it)`);
        jsonMode = false;
        attempt--;
        continue;
      }
      throw err;
    }

    const choice = response.choices[0];
    const raw = choice.message.content ?? "";
    if (choice.finish_reason === "length") {
      console.error("  (plan was cut off; asking for a shorter one)");
      extra = "\n\nYour previous reply was cut off. List at most 8 items and keep every text field under 25 words.";
      continue;
    }
    if (!raw.trim()) {
      console.error("  (got an empty plan; asking again)");
      extra = "\n\nYour previous reply was empty. Reply with the JSON object now.";
      continue;
    }
    const data = extractJson(raw);
    if (data === undefined) {
      console.error("  (plan wasn't valid JSON; asking again)");
      extra = "\n\nYour previous reply was not valid JSON. Reply with only the JSON object, no other text.";
      continue;
    }
    messages.push(request, { role: "assistant", content: raw });
    return data;
  }
  throw new Error(`couldn't get a valid cleanup plan after ${PLAN_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const messages: Msg[] = [
  { role: "system", content: SYSTEM },
  { role: "user", content: question },
];
transcript.log("start", { model: MODEL, question, dryRun, strictTools: STRICT_TOOLS });

try {
  const findings = await runScanLoop(messages);
  console.log(`\n${findings}\n`);

  console.error("  → building cleanup plan");
  const plan = await getPlan(messages);
  printUsage();
  await runCleanup(plan, scanned, { dryRun, transcript });
  if (transcript.file) console.error(`  (transcript: ${transcript.file})`);
} catch (err) {
  printUsage();
  console.error(`\nError: ${(err as Error).message}`);
  transcript.log("error", { message: (err as Error).message });
  if (transcript.file) console.error(`  (transcript: ${transcript.file})`);
  process.exit(1);
}
