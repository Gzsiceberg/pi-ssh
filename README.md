# pi-ssh-tools

Explicit SSH tools for [pi](https://github.com/earendil-works/pi).

Turn SSH mode on only when you need it, keep local tools untouched, and give the agent a separate remote toolset:

- `ssh_read`
- `ssh_write`
- `ssh_edit`
- `ssh_bash`

## Install

```bash
pi install npm:@ogulcancelik/pi-ssh-tools
```

Or add manually to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ogulcancelik/pi-ssh-tools"]
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
- if no remote path is provided, the extension resolves it with `ssh <host> pwd`

This is mainly a convenience layer. SSH config is not required for the actual remote tools.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- local `ssh` client available in `$PATH`
- key-based auth or another non-interactive SSH setup
- `bash` available on the remote host

## Notes

- `ssh_write` writes file content over stdin, which behaves better on macOS than GNU-specific `base64 -d` shell snippets
- relative remote paths resolve against the active remote cwd
- image reads are supported for common extensions: jpg, jpeg, png, gif, webp

## License

MIT
