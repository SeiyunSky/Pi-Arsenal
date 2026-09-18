import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "sol-pi-task-panel";
const ONLINE_STATE_ENTRY = "sol-pi-online-context-state-v1";
const MAX_VISIBLE_STEPS = 10;

type PlanStatus = "pending" | "in_progress" | "completed";

type PlanStep = {
	id: string;
	goal: string;
	status: PlanStatus;
};

function parseSteps(value: unknown): PlanStep[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return;
	const steps: PlanStep[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return;
		const step = item as Record<string, unknown>;
		if (
			typeof step.id !== "string" ||
			typeof step.goal !== "string" ||
			!(["pending", "in_progress", "completed"] as const).includes(step.status as PlanStatus)
		) {
			return;
		}
		steps.push({ id: step.id, goal: step.goal, status: step.status as PlanStatus });
	}
	return steps;
}

function restoreSteps(entries: readonly SessionEntry[]): PlanStep[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== ONLINE_STATE_ENTRY) continue;
		const data = entry.data as { plan?: unknown } | undefined;
		return parseSteps(data?.plan) ?? [];
	}
	return [];
}

export default function taskPanel(pi: ExtensionAPI) {
	let steps: PlanStep[] = [];

	function render(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (steps.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const completed = steps.filter((step) => step.status === "completed").length;
				const lines = [
					truncateToWidth(
						theme.fg("accent", theme.bold("Tasks")) + theme.fg("dim", `  ${completed}/${steps.length} completed`),
						width,
					),
				];

				for (const step of steps.slice(0, MAX_VISIBLE_STEPS)) {
					const marker =
						step.status === "completed"
							? theme.fg("success", "✓")
							: step.status === "in_progress"
								? theme.fg("warning", "●")
								: theme.fg("dim", "○");
					const goal = step.status === "completed" ? theme.fg("muted", step.goal) : theme.fg("text", step.goal);
					lines.push(truncateToWidth(` ${marker} ${goal}`, width));
				}

				if (steps.length > MAX_VISIBLE_STEPS) {
					lines.push(theme.fg("dim", ` … ${steps.length - MAX_VISIBLE_STEPS} more`));
				}
				return lines;
			},
		}));
	}

	function restore(ctx: ExtensionContext): void {
		steps = restoreSteps(ctx.sessionManager.getBranch());
		render(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "update_plan") return;
		const next = parseSteps((event.args as { steps?: unknown } | undefined)?.steps);
		if (!next) return;
		steps = next;
		render(ctx);
	});
}
