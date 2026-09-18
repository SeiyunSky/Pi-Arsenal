# Pi Agent Good For Use

Pi extension package for workspace and resource management.

## Modules

- **Workspace Drawer** — projects, files, computer browser, usage, Mermaid gallery, Session Library, Skill Library, and MCP Server browser.
- **Session Library** — inspect sessions, rename, add personal descriptions, reload a session in the current window, and delete non-current sessions.
- **Skill Library** — browse enabled/disabled skills by folder, set personal display names and notes, enable/disable individual skills or folders, organize folders, and prefill `/skill:<name>` commands.
- **MCP Server Browser** — read cached MCP server tools without showing secrets.
- **Task Panel** — fixed task panel extension.
- **Startup Splash** — red/black terminal startup header.
- **Tokyo Night Terra** — theme.

## Use

Install from GitHub:

```bash
pi install git:github.com/SeiyunSky/Pi-agent-Good-For-Use
```

Reload Pi after installation:

```text
/reload
```

Open the Workspace Drawer:

```text
Alt+W
```

or:

```text
/workspace
```

Open Session Library directly:

```text
/sessions
```

Skill enable/disable changes are applied after:

```text
/reload
```
