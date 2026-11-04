// Read-only scan tool: lists the largest items directly inside a folder.

import { execFile } from "node:child_process";
import { readdir, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScanItem {
  name: string;
  path: string;
  type: "dir" | "file";
  sizeBytes: number;
  size: string; // human-readable, e.g. "12.4 GB"
}

export interface ScanResult {
  root: string;
  total: string;
  shown: number;     // how many items we return (top N)
  hidden: number;    // how many smaller items we left out
  unreadable: number; // paths we couldn't read (permissions)
  items: ScanItem[];
  warnings: string[];
}

// "~/Library" -> "/Users/you/Library"
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Free space (bytes available to the user) on the disk holding `p`. Used to report how much
// space a cleanup actually freed: tool commands like `brew cleanup` touch more than one folder,
// so measuring a single path would be misleading.
export async function freeBytes(p = homedir()): Promise<number | null> {
  try {
    const s = await statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// What the model sees: no raw byte counts or repeated full paths, to save tokens.
export function toModelView(r: ScanResult) {
  return {
    root: r.root,
    total: r.total,
    items: r.items.map((i) => ({ name: i.name, type: i.type, size: i.size })),
    ...(r.hidden > 0 ? { hidden: r.hidden } : {}),
    ...(r.unreadable > 0 ? { unreadable: r.unreadable, warnings: r.warnings } : {}),
  };
}

export async function scan(inputPath: string, top = 10): Promise<ScanResult> {
  const root = resolve(expandHome(inputPath));

  // 1. List what's directly inside the folder (skip symlinks so we don't
  //    double-count or wander into other disks).
  const entries = await readdir(root, { withFileTypes: true });
  const children = entries
    .filter((e) => !e.isSymbolicLink())
    .map((e) => ({
      name: e.name,
      path: join(root, e.name),
      type: (e.isDirectory() ? "dir" : "file") as "dir" | "file",
    }));

  if (children.length === 0) {
    return { root, total: "0 B", shown: 0, hidden: 0, unreadable: 0, items: [], warnings: [] };
  }

  // 2. Ask `du` for the on-disk size of each child, in KB.
  //    -s = one total per argument, -k = kilobytes, -x = stay on this disk.
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(
      "du",
      ["-skx", ...children.map((c) => c.path)],
      { maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (err) {
    // du exits with an error code when SOME paths are unreadable,
    // but it still prints sizes for everything else. Keep that output.
    const e = err as { stdout?: string; stderr?: string };
    if (!e.stdout) throw err;
    stdout = e.stdout;
    stderr = e.stderr ?? "";
  }

  // 3. Parse lines like "123456\t/Users/you/Library/Caches"
  const sizes = new Map<string, number>();
  for (const line of stdout.trim().split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024);
  }

  const all: ScanItem[] = children
    .filter((c) => sizes.has(c.path))
    .map((c) => {
      const sizeBytes = sizes.get(c.path)!;
      return { ...c, sizeBytes, size: formatBytes(sizeBytes) };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  // 4. Report permission problems honestly, so the model knows
  //    its picture of the disk is incomplete.
  const errorLines = stderr.split("\n").filter(Boolean);
  const totalBytes = all.reduce((sum, item) => sum + item.sizeBytes, 0);
  const items = all.slice(0, top);

  return {
    root,
    total: formatBytes(totalBytes),
    shown: items.length,
    hidden: all.length - items.length,
    unreadable: errorLines.length,
    items,
    warnings: errorLines.slice(0, 5),
  };
}
