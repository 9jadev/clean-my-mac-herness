// Writes a JSONL log of each run (model calls, plan, what the user chose) to ./logs,
// for debugging and for checking the agent's behaviour later. Disable with --no-log.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class Transcript {
  readonly file: string | null = null;

  constructor(label: string, enabled: boolean) {
    if (!enabled) return;
    try {
      mkdirSync("logs", { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.file = join("logs", `${label}-${stamp}.jsonl`);
    } catch {
      this.file = null;
    }
  }

  log(type: string, data: Record<string, unknown> = {}) {
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify({ t: new Date().toISOString(), type, ...data })}\n`);
    } catch {
      // Logging must never break a run.
    }
  }
}
