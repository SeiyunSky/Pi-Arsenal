# Pi Arsenal

<p align="center">
  <img src="assets/pi-arsenal-banner.png" alt="Pi Arsenal red signal artwork" width="420">
</p>

> **LOADOUT READY.** A terminal control deck for [Pi](https://github.com/earendil-works/pi): organize the workspace, deploy skills, inspect sessions, and review MCP tools without leaving the TUI.

```text
╔══════════════════════════════════════════════╗
║                 PI  ARSENAL                  ║
║     WORKSPACE · SESSIONS · SKILLS · MCP       ║
╚══════════════════════════════════════════════╝
```

## Modules

| Module | What it does |
|---|---|
| **Workspace Drawer** | Projects, files, computer browser, usage, Mermaid gallery, Session Library, Skill Library, and MCP Server browser. |
| **Session Library** | Inspect sessions, rename them, add private descriptions, reload in the current window, and delete non-current sessions. |
| **Skill Library** | Browse enabled/disabled skills by folder; add private labels; enable/disable skills or folders; organize folders; prepare `/skill:<name>` commands. |
| **MCP Server Browser** | Read cached MCP servers and tools without displaying secrets. |
| **Task Panel** | Persistent task panel extension. |
| **Startup Splash** | Red/black terminal startup header. |
| **Tokyo Night Terra** | Included Pi theme. |

## Deploy

```bash
pi install git:github.com/SeiyunSky/Pi-Arsenal
```

Then reload Pi:

```text
/reload
```

## Commands

| Command | Action |
|---|---|
| `Alt+W` | Open the Workspace Drawer |
| `/workspace` | Open the Workspace Drawer when the terminal does not deliver `Alt+W` |
| `/sessions` | Open Session Library directly |
| `/reload` | Apply changed skill discovery after enable/disable operations |

## Skill Loadout

Open the drawer, then:

```text
Skill Library → Enabled skills / Disabled skills → folder → skill
```

For enabled skills, select **Use this skill now**. Pi Arsenal prepares the canonical command in the editor:

```text
/skill:<canonical-name>
```

Add task details and submit when ready.

> Skill enable/disable moves complete skill folders between `~/.agents/skills` and `~/.agents/disabled-skills`. Nothing is deleted. Run `/reload` afterward.
