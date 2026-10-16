# Pi Arsenal

<p align="center">
  <img src="assets/pi-arsenal-banner.png" alt="Pi Arsenal red signal artwork" width="420">
</p>

> **LOADOUT READY.** A terminal control deck for [Pi](https://github.com/earendil-works/pi): organize the workspace, inspect sessions, manage skills, review MCP tools, and keep an active task plan on track without leaving the TUI.

```text
╔══════════════════════════════════════════════╗
║                 PI  ARSENAL                  ║
║     WORKSPACE · SESSIONS · SKILLS · MCP       ║
╚══════════════════════════════════════════════╝
```

## Modules

| Module | What it does |
|---|---|
| **Workspace Drawer** | Projects, files, computer browser, usage, Mermaid gallery, Session Library, optional Translation Studio, Skill Library, and MCP Server browser. |
| **Session Library** | Inspect sessions, rename them, add private descriptions, reload in the current window, and delete non-current sessions. |
| **Skill Library** | Browse enabled/disabled skills by folder; add private labels; enable/disable skills or folders; organize folders; prepare `/skill:<name>` commands. |
| **MCP Server Browser** | Read cached MCP servers and tools without displaying secrets. |
| **Task Panel** | Shows the active plan, enforces one-step-at-a-time status progression, and prevents an unfinished plan from being replaced without explicit user approval. |
| **Startup Splash** | Red/black terminal startup header. |
| **Tokyo Night Terra** | Included Pi theme. |
| **Translation Studio integration** | Shows `🌐 Translation Studio` when [`pi-translation-studio`](https://www.npmjs.com/package/pi-translation-studio) is installed; Pi Arsenal does not bundle translation logic. |

## Install

```bash
pi install npm:pi-arsenal
```

Pi Arsenal automatically installs [`pi-choices`](https://www.npmjs.com/package/pi-choices) as a runtime dependency. It supplies the explicit confirmation form used when an agent requests cancellation or replacement of an unfinished Task Panel plan; **do not install `pi-choices` separately** when using the npm or Git version of Pi Arsenal.

Then reload Pi:

```text
/reload
```

For the Git source:

```bash
pi install git:github.com/SeiyunSky/Pi-Arsenal
```

## Active-plan protection

While a Task Panel plan has unfinished steps:

- normal user supplements remain visible to the agent but do not authorize it to replace, reorder, skip, or batch-complete the plan;
- the agent must complete and verify the current step before marking it complete and starting the next one;
- to cancel or replace the plan, the agent must first show an explicit `pi-choices` confirmation. Only the user's **Cancel** or **Replace** selection unlocks one plan change.

## Commands

| Command | Action |
|---|---|
| `Alt+W` | Open the Workspace Drawer |
| `/workspace` | Open the Workspace Drawer when the terminal does not deliver `Alt+W` |
| `/sessions` | Open Session Library directly |
| `/translate` | Provided by the optional `pi-translation-studio` package |
| `/reload` | Apply changed extensions or skill discovery after enable/disable operations |

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

## Update or remove

```bash
pi update npm:pi-arsenal
pi remove npm:pi-arsenal
```
