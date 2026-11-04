# sysdata-agent

An AI agent that finds out what is using disk space on your Mac and helps you clean it up safely.

You ask a question in plain English ("What's using the most space in my home folder?"). The agent:

1. **Scans** your disk, folder by folder, and explains where the space is going.
2. **Builds a cleanup plan**: what each large item is, whether it's safe to delete, and whether it may hold private data.
3. **Walks you through the plan** one item at a time. For items that are safe, it shows the exact command and what it will do, and runs it **only if you type `y`**.

The agent works with **DeepSeek** (`agent-deepseek.ts`) or **Claude** (`agent.ts`). Both share the same prompts, safety rules and walkthrough.

> macOS only. It uses `du` and macOS folder locations such as `~/Library`.

---

## Quick start

```bash
npm install

# DeepSeek
export DEEPSEEK_API_KEY=your-key
npm run agent:deepseek -- "What's using the most space in my home folder?"

# Claude
export ANTHROPIC_API_KEY=your-key        # or log in once with `ant auth login`
npm run agent -- "What's using the most space in my home folder?"
```

If you don't ask a question, it uses "What's using the most space in my home folder?".

**Try a dry run first.** It goes through the whole walkthrough but never runs anything:

```bash
npm run agent:deepseek -- --dry-run "Why is my Library folder so big?"
```

### Requirements

- macOS
- Node.js 18.15 or newer (tested on Node 25)
- A DeepSeek API key or an Anthropic API key

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run agent:deepseek -- [flags] "question"` | Runs the agent with DeepSeek |
| `npm run agent -- [flags] "question"` | Runs the agent with Claude (`claude-opus-5-5`) |
| `npm run scan -- <folder> [top] [--json]` | Runs only the scan tool, with no AI. Useful for checking what the model will see |
| `npm test` | Runs the safety-rule tests |
| `npm run typecheck` | Type-checks the project |

### Flags (both agents)

| Flag | Effect |
| --- | --- |
| `--dry-run` | Asks about every item but never runs a command |
| `--no-log` | Doesn't write a transcript to `logs/` |

### Scan examples

```bash
npm run scan -- ~               # top 10 items in your home folder
npm run scan -- ~/Library 20    # top 20 items in ~/Library
npm run scan -- ~/Library 10 --json   # exactly the data the model receives
```

---

## What a run looks like

```
  → scanning ~
  → scanning ~/Library
  → scanning ~/Library/Developer
...
Your home folder uses about 180 GB. Most of it is in ~/Library (75 GB),
mainly Xcode data in ~/Library/Developer (32 GB) ...

  → building cleanup plan
  (6 API calls · 41,230 prompt tokens, 78% from cache · 3,102 output tokens)

Let's go through 5 items.

────────────────────────────────────────────────────────────
[1/5] npm cache  (4.2 GB)
  Path:      ~/.npm
  What:      Downloaded package tarballs npm keeps so installs are faster.
  Safety:    ✅ Safe to remove — npm re-downloads anything it needs.
  Sensitive: No

  Command:   npm cache clean --force
  Effect:    Deletes npm's download cache. Next installs will be slower until it refills.

  Run this command? [y/N/q]
```

At each prompt:

- `y`: run the command
- `n` or Enter: skip this item
- `q` (or Ctrl+C): stop the walkthrough

At the end you get a summary of what ran, what was skipped, and roughly how much space was freed. Freed space is measured as the change in free disk space, so it counts space freed anywhere, for example by `brew cleanup`.

### Commands that ask their own questions

Some cleanup commands ask for confirmation themselves. For example, `flutter pub cache clean` asks "Are you sure? (y/n)". When a command runs, the agent hands your terminal over to it completely, so you answer it directly as if you had typed the command yourself:

```
  ┌─ Running: flutter pub cache clean
  │  If it asks you something, type your answer and press Enter: you're talking to the command directly.
  │  Ctrl+C stops just this command.
  └────────────────────────────────────────

Are you sure? (y/n) y
...
  ────────────────────────────────────────
  ✓ Done. Freed about 2.1 GB.
```

Ctrl+C while a command is running stops only that command. The walkthrough continues with the next item.

---

## How it stays safe

The AI **cannot delete anything by itself**. Its only tool is `scan_folder`, which is read-only. Deleting happens only in the walkthrough, only after you say yes, and only if the command passes every check below. These checks are made in code, not by the model, so a wrong or badly behaved model reply can't get around them.

**1. Only "safe", non-sensitive items are offered.** Items marked "caution" or "unsafe", or marked as possibly holding private data, are shown to you but never run.

**2. The harness adds its own labels on top of the model's.**
- **Plan items must point at paths that actually appeared in a scan.** Invented paths are dropped.
- **Known credential and personal-data locations are always marked sensitive, whatever the model says.** These include `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, Keychains, Messages, Mail, Safari, Chrome/Firefox/Brave/Edge/Arc profiles, iPhone backups, iCloud Drive, Notes, Contacts, Calendars, 1Password and Photos libraries. A folder that *contains* one of these (such as `~/Library`) is marked sensitive too.
- **Your own files are never "safe".** Anything in Documents, Desktop, Downloads, Pictures, Movies, Music or Public is downgraded to "caution", so you review it yourself.

**3. Only allowed commands are run.** A command is accepted only if it is one of these:

| Command | Optional extras |
| --- | --- |
| `npm cache clean --force` | |
| `yarn cache clean` | |
| `pnpm store prune` | |
| `brew cleanup` | `-s`, `--prune=all` |
| `pip cache purge` / `pip3 cache purge` | |
| `docker system prune` / `docker image prune` / `docker builder prune` | `-a`, `-f` |
| `xcrun simctl delete unavailable` | |
| `flutter pub cache clean` / `dart pub cache clean` | `-f` |
| `pod cache clean --all` | |
| `go clean -cache` / `go clean -modcache` | |
| `rm -rf "<path>"` | see below |

`rm` is only allowed when all of these are true:
- It removes **exactly one path**.
- That path is **the plan item's own path or something inside it**.
- The path is inside your home folder.
- The path is not a protected folder such as your home folder itself, `~/Library`, `~/Library/Caches`, `~/Library/Application Support` or `~/Documents`, and doesn't contain one.
- The path is not a sensitive location from the list above.

**4. Commands run without a shell.** The command is split into words and started directly. There is no `sh`/`zsh` in between. Anything shell-like is refused up front: line breaks, `;`, `&&`, `|`, `>`, `$VAR`, `$(...)`, backticks, `*` globs, and `sudo`. Paths are compared after resolving `..`, `~` and symlinks, and capitalisation is ignored because Mac disks are case-insensitive by default. So `~/documents` and `~/Library/Caches/../..` are caught.

**5. A time limit.** Each command is stopped after 10 minutes.

The tests in [src/shared/commands.test.ts](src/shared/commands.test.ts) cover each of these bypass attempts.

---

## Configuration

### DeepSeek

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | *(required)* | Your DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model to use; `deepseek-reasoner` also works |
| `DEEPSEEK_MAX_TOKENS` | `8192` | Output limit per call |
| `DEEPSEEK_STRICT_TOOLS` | off | Set to `1` to use DeepSeek's beta endpoint with strict tool schemas |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Override the API address |

What the DeepSeek harness handles for you:

- **Plan retries.** If the plan comes back empty, cut off or not valid JSON, it asks again, up to 3 times. Cut-off plans are retried with a request for a shorter plan.
- **Models without JSON mode.** If the model rejects JSON mode, it falls back to asking for plain JSON.
- **Reasoning models.** For `deepseek-reasoner`, reasoning is kept during the scan and dropped before the plan request.
- **Network.** A 5-minute timeout and 3 automatic retries on network or server errors.
- **Usage.** Usage is printed at the end of each run, including how much of the prompt was served from DeepSeek's cache.

### Claude

Uses `claude-opus-5-5` with medium effort. It reads `ANTHROPIC_API_KEY`, or a profile saved by `ant auth login`. If the model declines a request, the API automatically retries on a fallback model. The cleanup plan uses structured output, so it always matches the plan schema.

---

## Logs

Each run writes a transcript to `logs/<model>-<timestamp>.jsonl`. It records:
- every model reply
- the cleanup plan, and any items the harness dropped
- your answers
- every command run, with its exit code and the space freed

Use it to debug odd behaviour or to compare runs. The `logs/` folder is git-ignored. Turn logging off with `--no-log`.

The logs contain folder names from your disk, so don't share them publicly.

---

## Troubleshooting

**"N paths couldn't be read (permissions)."** macOS blocks some folders, such as Mail, Messages and Safari, unless your terminal has Full Disk Access. The agent tells you when its picture is incomplete. To scan everything, give your terminal app (Terminal, iTerm, VS Code) Full Disk Access in System Settings → Privacy & Security, then restart the terminal.

**"Not running in an interactive terminal, so I won't ask to run anything."** The walkthrough only runs in a real terminal. If you pipe input in or run it from a script, you get the findings and the plan, but no commands run.

**"the suggested command was blocked because …"** The model suggested a command outside the allowed list. The item is skipped. You can still clean it up yourself if you agree with the suggestion.

**"command not found: flutter"** (or similar). The cleanup command's tool isn't installed or isn't on your `PATH`.

**"Set DEEPSEEK_API_KEY first."** Export your key in the same terminal before running.

**Never put API keys in source files.** Use environment variables only. If a key ever ends up in a file or a commit, revoke it and create a new one.

---

## Project layout

```
src/
├── agent-deepseek.ts      DeepSeek harness: scan loop, plan with retries, usage tracking
├── agent.ts               Claude harness: SDK tool runner + structured-output plan
├── cli.ts                 `npm run scan`: run the scan tool by hand
├── tools/
│   └── scan.ts            Read-only disk scan (du), free-space check, compact model view
└── shared/
    ├── prompts.ts         System prompt, tool description, plan request
    ├── scan-tool.ts       scan_folder body + record of every path the model has seen
    ├── plan.ts            Plan schema and the harness's own labelling rules
    ├── paths.ts           Sensitive, protected and user-file locations
    ├── commands.ts        Command allowlist and parser
    ├── commands.test.ts   Tests for the safety rules
    ├── walkthrough.ts     Per-item prompts and running commands with the terminal handed over
    └── transcript.ts      JSONL run logs
```

### Adding a new allowed cleanup command

1. Add it to `TOOL_COMMANDS` in [src/shared/commands.ts](src/shared/commands.ts), with any optional flags it may take.
2. Add the same command to the list in `PLAN_REQUEST` in [src/shared/prompts.ts](src/shared/prompts.ts), so the model knows it can suggest it.
3. Add a test case to [src/shared/commands.test.ts](src/shared/commands.test.ts) and run `npm test`.

### Adding a sensitive or protected location

Edit `SENSITIVE`, `USER_FILES` or `PROTECTED` in [src/shared/paths.ts](src/shared/paths.ts). Paths there are relative to your home folder.
