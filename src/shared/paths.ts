// Path rules the harness enforces itself, whatever the model says.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome } from "../tools/scan";

const HOME = (() => {
  try {
    return realpathSync.native(homedir());
  } catch {
    return homedir();
  }
})();

/** Absolute, normalised path ("..", "~" and trailing slashes resolved). */
export function absPath(p: string): string {
  const abs = resolve(expandHome(p.trim()));
  return abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
}

/** Like absPath, but resolves symlinks in the parent so links can't point somewhere else. */
export function realTarget(p: string): string {
  const abs = absPath(p);
  if (abs === "/") return abs;
  try {
    return join(realpathSync.native(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

// macOS disks are case-insensitive by default, so all comparisons ignore case.
const norm = (p: string) => p.toLowerCase();

export function isInside(child: string, parent: string, orEqual = true): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (orEqual && c === p) return true;
  return c.startsWith(p === "/" ? "/" : `${p}/`);
}

/** True if the two paths are the same, or one contains the other. */
function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

const inHome = (rel: string) => join(HOME, rel);

// Places holding credentials or irreplaceable personal data. An item that is inside one of these,
// or contains one (e.g. ~/Library), is always treated as sensitive.
const SENSITIVE: [string, string][] = [
  [".ssh", "SSH keys"],
  [".gnupg", "GPG keys"],
  [".aws", "AWS credentials"],
  [".azure", "Azure credentials"],
  [".kube", "Kubernetes credentials"],
  [".config/gcloud", "Google Cloud credentials"],
  [".netrc", "saved passwords"],
  [".password-store", "password store"],
  ["Library/Keychains", "keychains (saved passwords)"],
  ["Library/Messages", "Messages history"],
  ["Library/Mail", "email"],
  ["Library/Cookies", "browser cookies"],
  ["Library/Safari", "Safari data"],
  ["Library/Calendars", "calendars"],
  ["Library/Mobile Documents", "iCloud Drive files"],
  ["Library/Group Containers/group.com.apple.notes", "Notes"],
  ["Library/Application Support/MobileSync", "iPhone/iPad backups"],
  ["Library/Application Support/AddressBook", "contacts"],
  ["Library/Application Support/1Password", "password manager data"],
  ["Library/Application Support/Google/Chrome", "Chrome profile"],
  ["Library/Application Support/Firefox", "Firefox profile"],
  ["Library/Application Support/BraveSoftware", "Brave profile"],
  ["Library/Application Support/Microsoft Edge", "Edge profile"],
  ["Library/Application Support/Arc", "Arc profile"],
];

// The user's own files. Never auto-cleaned; at most "caution".
const USER_FILES = ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Public"];

// Folders that must never be removed as a whole (their contents may be).
const PROTECTED = [
  "",
  "Library",
  "Library/Application Support",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Caches",
  "Library/Preferences",
  "Applications",
  ...USER_FILES,
];

export function sensitiveReason(p: string): string | null {
  const abs = absPath(p);
  if (/\.photoslibrary(\/|$)/i.test(abs)) return "Photos library";
  for (const [rel, why] of SENSITIVE) if (overlaps(abs, inHome(rel))) return why;
  return null;
}

/** "Documents", "Downloads", … if the path is (or contains) the user's own files. */
export function userFilesFolder(p: string): string | null {
  const abs = absPath(p);
  for (const rel of USER_FILES) if (overlaps(abs, inHome(rel))) return rel;
  return null;
}

/** Why `target` may not be deleted, or null if it may (still subject to the item-path check). */
export function deleteBlockReason(target: string): string | null {
  const t = realTarget(target);
  if (!isInside(t, HOME, false)) return `${t} is outside your home folder`;
  for (const rel of PROTECTED) if (isInside(inHome(rel), t)) return `${t} is or contains ~/${rel || ""}`.replace(/\/$/, "");
  const s = sensitiveReason(t);
  if (s) return `${t} holds or contains ${s}`;
  return null;
}
