// The scan_folder tool body shared by both harnesses, plus a record of every path the model
// has been shown, so plan items can be checked against what was actually scanned.

import { join } from "node:path";
import { scan, toModelView, type ScanResult } from "../tools/scan";
import { absPath } from "./paths";

export class ScanLog {
  private seen = new Set<string>();

  record(result: ScanResult) {
    this.seen.add(absPath(result.root).toLowerCase());
    for (const item of result.items) this.seen.add(absPath(join(result.root, item.name)).toLowerCase());
  }

  has(path: string): boolean {
    return this.seen.has(absPath(path).toLowerCase());
  }
}

/** Runs one scan and always returns a string, so errors go back to the model instead of crashing. */
export async function runScanTool(path: string, top: number, log: ScanLog): Promise<string> {
  const n = Number.isInteger(top) ? Math.min(Math.max(top, 1), 50) : 10;
  console.error(`  → scanning ${path}`);
  try {
    const result = await scan(path, n);
    log.record(result);
    return JSON.stringify(toModelView(result));
  } catch (err) {
    return `Error scanning ${path}: ${(err as Error).message}`;
  }
}
