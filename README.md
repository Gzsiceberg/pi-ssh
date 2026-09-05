# pi-ssh

Explicit SSH tools for [pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent).

Turn SSH mode on only when you need it, keep local tools untouched, and give the agent a separate remote toolset:

- `ssh_read`
- `ssh_write`
- `ssh_edit`
- `ssh_bash`

## Install

Install directly from [Gzsiceberg/pi-ssh](https://github.com/Gzsiceberg/pi-ssh):

```bash
pi install git:github.com/Gzsiceberg/pi-ssh
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/Gzsiceberg/pi-ssh"]
}
```

## What it does

This package adds a `/ssh` command.

- Default is off
- No persistence across sessions
- Local `read`, `write`, `edit`, and `bash` stay local
- When SSH mode is active, the agent also gets `ssh_read`, `ssh_write`, `ssh_edit`, and `ssh_bash`
- The active remote host and cwd are injected into the system prompt while SSH mode is on

That makes remote work explicit instead of silently swapping out local tools.

## Usage

```text
/ssh
/ssh mac
/ssh clawd
/ssh mac:/Users/can/project
/ssh status
/ssh off
```

When `/ssh` is called with no arguments, the extension offers hosts from `~/.ssh/config`.

You can always bypass the picker and type a host manually:

```text
/ssh user@host
/ssh user@host:/remote/path
```

That means the package still works even if you do not use `~/.ssh/config`.

## How host selection works

The picker reads `Host ...` aliases from your local `~/.ssh/config`.

- wildcard entries like `Host *` are ignored
- aliases are used as the SSH target directly
- the remote home and initial cwd are queried over SSH
- an explicit cwd is expanded on the remote host and validated with `cd`; relative cwd values start at the SSH login directory

This is mainly a convenience layer. SSH config is not required for the actual remote tools.

## Requirements

- [pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)
- local `ssh` client available in `$PATH`
- key-based auth or another non-interactive SSH setup
- `bash` available on the remote host

## Notes

- `ssh_write` writes file content over stdin, which behaves better on macOS than GNU-specific `base64 -d` shell snippets
- All file tools resolve relative paths against the active remote cwd, and `~` / `~/...` against the remote home. Absolute paths, `../`, and pi's leading `@` syntax are supported; the cwd is not a sandbox.
- File tools reuse the installed pi's schemas, argument preparation, truncation, edit matching, BOM/line-ending handling, diff generation, and sampling metadata (tested with pi 0.85.0).
- Read filename fallbacks (macOS screenshot spacing, NFD, curly quotes) test files on the remote host, never the local project.
- Images are detected by content using pi's detector, including JPEG, PNG, GIF, WebP, and BMP, regardless of extension. A private temporary file holds only the 4100-byte sniffing prefix and is removed after detection; the downloaded buffer is reused for the read.
- Edit results retain pi's diff renderer and self-rendered layout. The header is SSH-specific; local-file pre-execution previews are deliberately disabled.
- Write/edit calls share pi's mutation queue using host + normalized remote path keys, isolated from local tools. Different SSH aliases or remote symlink paths are not canonicalized to a shared key; avoid concurrent mutations through those aliases. This is not a cross-process remote lock.

## Tests

With pi installed globally and a POSIX shell available:

```bash
npm test
```

Tests use a fake SSH executable and temporary directories—no remote connection is made. Set `PI_TEST_PACKAGE=/path/to/pi-coding-agent` to test against a different installation.

See [live validation results](test/VALIDATION.md) for the pi-in-tmux tests against a real SSH host.

## License

MIT
