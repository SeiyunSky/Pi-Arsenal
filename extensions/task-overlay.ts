import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

// ─── Bridge ───────────────────────────────────────────────────────────────────

const TASK_BRIDGE_KEY = Symbol.for("pi-arsenal.task-panel.bridge.v1");

type PlanStatus = "pending" | "in_progress" | "completed";
type PlanStep = { id: string; goal: string; status: PlanStatus };
type TaskBridge = { getSteps(): PlanStep[]; cancelPlan(): void };

function getTaskBridge(): TaskBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[TASK_BRIDGE_KEY] as TaskBridge | undefined;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

const WIDTH = 56;
const INNER = WIDTH - 2;

// ─── Overlay component ────────────────────────────────────────────────────────

class TaskOverlay implements Focusable {
	readonly width = WIDTH;
	focused = false;

	private scrollTop = 0;      // first visible step index
	private readonly pageSize = 14;

	constructor(
		private readonly steps: PlanStep[],
		private readonly theme: Theme,
		private readonly done: (cancelled: boolean) => void,
	) {}

	private get completed(): number { return this.steps.filter((s) => s.status === "completed").length; }
	private get active(): PlanStep | undefined { return this.steps.find((s) => s.status === "in_progress"); }
	private get hasActive(): boolean { return this.steps.some((s) => s.status !== "completed"); }

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) { this.done(false); return; }

		// Scroll
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollTop = Math.max(0, this.scrollTop - 1); return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollTop = Math.min(Math.max(0, this.steps.length - this.pageSize), this.scrollTop + 1); return;
		}
		// Cancel plan
		if ((matchesKey(data, Key.enter) || matchesKey(data, "c")) && this.hasActive) {
			this.done(true); return;
		}
	}

	render(_width: number): string[] {
		const th = this.theme;
		const row = (text: string): string =>
			th.fg("border", "│") + text + " ".repeat(Math.max(0, INNER - visibleWidth(text))) + th.fg("border", "│");

		const completed = this.completed;
		const total = this.steps.length;
		const pct = total ? Math.round((completed / total) * 100) : 0;

		// Progress bar
		const barWidth = INNER - 14;
		const filled = Math.round((completed / Math.max(1, total)) * barWidth);
		const bar = th.fg("success", "█".repeat(filled)) + th.fg("dim", "░".repeat(barWidth - filled));

		// Header
		const headerText = `Tasks  ${completed}/${total}  ${pct}%`;
		const lines: string[] = [
			th.fg("borderAccent", `╭─ ${th.bold(headerText)} ${"─".repeat(Math.max(0, INNER - visibleWidth(headerText) - 3))}╮`),
			row(""),
			row(` ${bar}`),
			row(""),
		];

		// Active step callout
		const act = this.active;
		if (act) {
			lines.push(row(` ${th.fg("warning", "▶")} ${th.fg("warning", th.bold(truncateToWidth(act.goal, INNER - 4)))}`));
			lines.push(row(` ${th.fg("dim", "  currently in progress")}`));
			lines.push(row(""));
		}

		// Step list (paginated)
		const visible = this.steps.slice(this.scrollTop, this.scrollTop + this.pageSize);
		for (let i = 0; i < visible.length; i++) {
			const step = visible[i]!;
			const absIdx = this.scrollTop + i;
			const isActive = step.status === "in_progress";
			const icon =
				step.status === "completed" ? th.fg("success", "✓") :
				isActive                    ? th.fg("warning", "●") :
				                              th.fg("dim",     "○");
			const num = th.fg("dim", `${String(absIdx + 1).padStart(2)}.`);
			const goal = isActive
				? th.fg("warning", th.bold(truncateToWidth(step.goal, INNER - 7)))
				: step.status === "completed"
					? th.fg("muted", truncateToWidth(step.goal, INNER - 7))
					: th.fg("text",  truncateToWidth(step.goal, INNER - 7));
			lines.push(row(` ${num} ${icon} ${goal}`));
		}

		// Scroll indicator
		if (this.steps.length > this.pageSize) {
			const page = Math.floor(this.scrollTop / this.pageSize) + 1;
			const totalPages = Math.ceil(this.steps.length / this.pageSize);
			lines.push(row(""));
			lines.push(row(th.fg("dim", ` Page ${page} / ${totalPages}  ↑ ↓ scroll`)));
		}

		// Footer
		lines.push(row(""));
		if (this.hasActive) {
			lines.push(row(th.fg("dim", " C / Enter  cancel plan · Q / Esc  close")));
		} else {
			lines.push(row(th.fg("success", " Plan complete — all steps done")));
			lines.push(row(th.fg("dim", " Q / Esc  close")));
		}

		lines.push(th.fg("borderAccent", `╰${"─".repeat(INNER)}╯`));
		return lines;
	}

	invalidate(): void {}
}

// ─── Extension ────────────────────────────────────────────────────────────────

async function openOverlay(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const bridge = getTaskBridge();
	const steps = bridge?.getSteps() ?? [];

	if (!steps.length) { ctx.ui.notify("No active plan.", "info"); return; }

	const cancelled = await ctx.ui.custom<boolean>(
		(_tui, theme, _kb, done) => new TaskOverlay(steps, theme, done),
		{ overlay: true, overlayOptions: { anchor: "right-center", width: WIDTH + 2, maxHeight: "100%", margin: { top: 1, right: 1, bottom: 1 } } },
	);

	if (cancelled && bridge) {
		const confirmed = await ctx.ui.confirm(
			"Cancel plan?",
			"Mark all remaining steps completed so the model is free to start a new plan.",
		);
		if (confirmed) {
			bridge.cancelPlan();
			ctx.ui.notify("Plan cancelled. The model may now start a new plan.", "info");
		}
	}
}

export default function taskOverlay(pi: ExtensionAPI) {
	pi.registerCommand("task-overlay", {
		description: "Show full task plan in an overlay panel",
		handler: async (_args, ctx) => openOverlay(ctx),
	});
	pi.registerShortcut(Key.alt("t"), {
		description: "Show task plan overlay (Alt+T)",
		handler: async (ctx) => openOverlay(ctx as ExtensionCommandContext),
	});
}
