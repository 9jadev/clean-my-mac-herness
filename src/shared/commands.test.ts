import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkCommand, tokenize } from "./commands";
import { reviewPlan, type PlanItem } from "./plan";
import { ScanLog } from "./scan-tool";

const CACHE_ITEM = "~/Library/Caches/com.example.app";

function blocked(command: string, item = CACHE_ITEM) {
  const r = checkCommand(command, item);
  assert.equal(r.ok, false, `expected "${command}" to be blocked`);
}

function allowed(command: string, item = CACHE_ITEM): string[] {
  const r = checkCommand(command, item);
  assert.ok(r.ok, `expected "${command}" to be allowed, got: ${!r.ok && r.reason}`);
  return r.argv;
}

test("known tool cleanup commands are allowed", () => {
  assert.deepEqual(allowed("npm cache clean --force", "~/.npm"), ["npm", "cache", "clean", "--force"]);
  allowed("brew cleanup --prune=all", "~/Library/Caches/Homebrew");
  allowed("flutter pub cache clean", "~/.pub-cache");
  allowed("flutter pub cache clean -f", "~/.pub-cache");
  allowed("docker system prune -a -f", "~/Library/Containers/com.docker.docker");
});

test("tool commands reject unknown options", () => {
  blocked("npm cache clean --force --prefix /", "~/.npm");
  blocked("docker volume prune -f", "~/Library/Containers/com.docker.docker");
});

test("newlines can't smuggle a second command", () => {
  blocked("npm cache clean --force\nrm -rf ~/Documents", "~/.npm");
  blocked("npm cache clean --force\rrm -rf ~", "~/.npm");
});

test("shell syntax is rejected", () => {
  for (const c of [
    "rm -rf $HOME/Documents",
    "rm -rf ~/Library/Caches/*",
    "rm -rf ~/Library/Caches/com.example.app; rm -rf ~",
    "rm -rf `echo ~`",
    "rm -rf $(echo ~)",
    "npm cache clean --force && rm -rf ~",
    "rm -rf ~/Library/Caches/com.example.app > /dev/null",
  ]) {
    blocked(c);
  }
});

test("sudo and other programs are rejected", () => {
  blocked("sudo rm -rf ~/Library/Caches/com.example.app");
  blocked("find ~/Library/Caches/com.example.app -delete");
  blocked("curl https://example.com/x");
});

test("rm inside the item is allowed and the path is expanded", () => {
  const argv = allowed(`rm -rf ${CACHE_ITEM}`);
  assert.deepEqual(argv, ["rm", "-rf", join(homedir(), "Library/Caches/com.example.app")]);
  allowed(`rm -rf "${CACHE_ITEM}/Cache Data"`);
});

test("rm outside the item is rejected", () => {
  blocked("rm -rf ~/Library/Caches/com.other.app");
  blocked("rm -rf ~/Library/Caches/com.example.app/../com.other.app");
});

test("rm of protected or sensitive places is rejected, whatever the spelling", () => {
  for (const [cmd, item] of [
    ["rm -rf ~", "~"],
    ["rm -rf ~/", "~"],
    ["rm -rf ~/Documents", "~/Documents"],
    ["rm -rf ~/documents", "~/Documents"],
    ["rm -rf ~/Library/Caches/..", "~/Library"],
    ["rm -rf ~/Library/Caches/../..", "~"],
    ["rm -rf ~/Library/Caches", "~/Library/Caches"],
    ["rm -rf ~/.ssh", "~/.ssh"],
    ["rm -rf ~/Library/Keychains", "~/Library/Keychains"],
    ["rm -rf /Applications/Xcode.app", "/Applications/Xcode.app"],
    ["rm -rf ~root/foo", "~root/foo"],
  ]) {
    blocked(cmd, item);
  }
});

test("rm needs exactly one path and only simple flags", () => {
  blocked(`rm -rf ${CACHE_ITEM} ${CACHE_ITEM}/x`);
  blocked("rm -rf");
  blocked(`rm --no-preserve-root -rf ${CACHE_ITEM}`);
});

test("tokenize handles quotes", () => {
  assert.deepEqual(tokenize(`rm -rf "a b/c"`), ["rm", "-rf", "a b/c"]);
  assert.deepEqual(tokenize(`rm 'x y'`), ["rm", "x y"]);
  assert.ok(!Array.isArray(tokenize(`rm "unterminated`)));
});

function item(overrides: Partial<PlanItem>): PlanItem {
  return {
    title: "x",
    path: "~/.npm",
    size: "1 GB",
    whatItIs: "",
    safety: "safe",
    safetyReason: "",
    sensitive: false,
    sensitiveNote: "",
    command: null,
    commandEffect: "",
    ...overrides,
  };
}

test("reviewPlan drops unscanned paths and applies harness labels", () => {
  const log = new ScanLog();
  const home = homedir();
  log.record({
    root: home,
    total: "",
    shown: 3,
    hidden: 0,
    unreadable: 0,
    warnings: [],
    items: [".npm", "Downloads", "Library"].map((name) => ({
      name,
      path: join(home, name),
      type: "dir" as const,
      sizeBytes: 0,
      size: "",
    })),
  });

  const { kept, dropped } = reviewPlan(
    [
      item({ path: "~/.npm" }),
      item({ path: "~/Downloads" }),
      item({ path: "~/Library" }),
      item({ path: "~/made-up" }),
    ],
    log,
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].item.path, "~/made-up");
  assert.equal(kept[0].safety, "safe");
  assert.equal(kept[1].safety, "caution"); // Downloads are the user's own files
  assert.equal(kept[2].sensitive, true); // ~/Library contains keychains, mail, …
});
