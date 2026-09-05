# Live validation — 2026-09-05

Tested the working-tree `index.ts` with **pi 0.85.0 in tmux**, using a real SSH connection to a Linux host. All mutations were confined to dedicated temporary test directories. Remote fixtures and the two test pi/tmux sessions were removed afterward.

## Results

- **48 model-issued tool calls** through the actual pi tool registry and TUI.
- **11 deterministic checks** through a temporary command in a second pi session. The command captured the extension's registered definitions without replacing their implementations.
- **12 automated regression tests**, including assertions that valid PNG, BMP, and GIF fixtures produce actual image attachments.
- Strict TypeScript check against the installed pi declarations passed.

Verified:

- Local/remote read, write, and edit isolation; local tools remain available.
- Relative, absolute, parent, leading `@`, and remote-home paths; remote cwd `/`.
- A local `ctx.cwd` different from `process.cwd()` and the remote cwd.
- Nested directory creation and filenames containing literal quotes and `$()`.
- Multi-edit results and diffs; byte-level BOM/CRLF preservation.
- Concurrent edits through normalized aliases of the same path; shared write/edit queueing. These were tested deterministically because the model correctly followed pi's system guidance to combine same-file edits.
- Non-unique, overlapping, and missing-file edits fail without changing fixtures.
- Remote screenshot spacing, NFD, and curly-quote filename fallbacks.
- Line offsets/limits, 2000-line truncation and continuation, oversized-line warnings with a quoted `ssh_bash` fallback, and beyond-EOF errors.
- Valid extensionless PNG and BMP produce real attachments; text named `.png` remains text. Local/remote valid PNG attachment bytes matched.
- Bash cwd, nonzero exit status, timeout, and live Escape cancellation.
- Pre-aborted file operations reject; pre-aborted writes create no file.
- Host picker, status, off mode, reload resetting SSH mode, corrected footer, diff/error/image presentation, and terminal resizing.

## Issues found and resolved

1. The original PNG fixture had an invalid IDAT checksum. Both native pi and SSH read omitted it, so equality alone was insufficient. Replaced it with a valid PNG and added explicit attachment assertions.
2. Explicit `host:/path` activation repeated the path in the footer. The display name now contains only the host; verified after `/reload`.

Command automation must account for pi's completion UI: Enter can accept a completion without submitting the command. Confirm the editor is empty before sending the next command.

## Scope

This validates the exercised scenarios on Linux, not every platform or failure mode. It does not establish cross-process locking, canonical queue identity across different SSH/symlink aliases, or guaranteed remote process-tree termination after transport cancellation. See the README for intentional SSH-specific differences.
