import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "sol-pi-task-panel";
const ONLINE_STATE_ENTRY = "sol-pi-online-context-state-v1";
const MAX_VISIBLE_STEPS = 10;
const PLAN_CHANGE_QUESTION_ID = "task_plan_change";
const PLAN_CHANGE_CHOICES = new Set(["Cancel the current plan and switch", "Replace the current plan"]);
const TASK_DISCIPLINE = `
Active-plan discipline:
- An unfinished plan is binding. User supplements are context, not permission to create, replace, cancel, reorder, or skip the plan.
- Work in listed order with exactly one in_progress step. After each individual step and its verification, immediately update_plan: complete only that current step and start only the next step.
- Do not batch-complete future steps, defer plan status updates, or start supplementary work before the active plan is complete.
- To change an unfinished plan, first call pi_choices with exactly this radio question: id "task_plan_change", question explaining the current plan is unfinished, options ["Continue the current plan", "Cancel the current plan and switch", "Replace the current plan"]. Only the user's explicit cancellation or replacement choice authorizes one subsequent changed update_plan call.
`.trim();

type PlanStatus = "pending" | "in_progress" | "completed";
type PlanStep = { id: string; goal: string; status: PlanStatus };

function parseSteps(value: unknown): PlanStep[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return;
	const steps: PlanStep[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const step = item as Record<string, unknown>;
		if (typeof step.id !== "string" || typeof step.goal !== "string" || !["pending", "in_progress", "completed"].includes(step.status as string)) return;
		steps.push({ id: step.id, goal: step.goal, status: step.status as PlanStatus });
	}
	return steps;
}

function restoreSteps(entries: readonly SessionEntry[]): PlanStep[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== ONLINE_STATE_ENTRY) continue;
		return parseSteps((entry.data as { plan?: unknown } | undefined)?.plan) ?? [];
	}
	return [];
}

function isActivePlan(steps: PlanStep[]): boolean {
	return steps.some((step) => step.status !== "completed");
}

function validShape(steps: PlanStep[]): boolean {
	const inProgress = steps.filter((step) => step.status === "in_progress").length;
	return isActivePlan(steps) ? inProgress === 1 : inProgress === 0;
}

function transitionError(current: PlanStep[], next: PlanStep[]): string | undefined {
	if (!validShape(next)) return "An active plan must have exactly one in_progress step.";
	if (current.length !== next.length || current.some((step, index) => step.id !== next[index]?.id || step.goal !== next[index]?.goal)) {
		return "The unfinished plan cannot be replaced, reordered, added to, or removed without explicit user approval through pi_choices.";
	}
	const activeIndex = current.findIndex((step) => step.status === "in_progress");
	if (activeIndex < 0) return;
	for (let index = 0; index < current.length; index++) {
		if (index < activeIndex && next[index].status !== "completed") return "Completed steps cannot be reopened.";
		if (index > activeIndex && next[index].status === "completed") return "Complete only the current in_progress step; future steps cannot be batch-completed.";
	}
	const completedCurrent = next[activeIndex].status === "completed";
	if (!completedCurrent && next[activeIndex].status !== "in_progress") return "The current step must remain in_progress until it is completed.";
	if (completedCurrent && activeIndex + 1 < next.length && next[activeIndex + 1].status !== "in_progress") return "After completing the current step, start exactly the next pending step.";
	return;
}

function isPlanChangeQuestion(event: ToolCallEvent): boolean {
	if (event.toolName !== "pi_choices") return false;
	const questions = (event.input as { questions?: unknown }).questions;
	if (!Array.isArray(questions) || questions.length !== 1) return false;
	const question = questions[0] as Record<string, unknown> | undefined;
	return question?.type === "radio"
		&& question.id === PLAN_CHANGE_QUESTION_ID
		&& Array.isArray(question.options)
		&& question.options.length === 3
		&& question.options.every((option, index) => option === ["Continue the current plan", "Cancel the current plan and switch", "Replace the current plan"][index]);
}

function approvalFromChoices(event: { toolName: string; content: Array<{ type: string; text?: string }>; isError: boolean }): boolean {
	if (event.toolName !== "pi_choices" || event.isError) return false;
	const text = event.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
	try {
		const answer = JSON.parse(text) as Record<string, unknown>;
		return typeof answer[PLAN_CHANGE_QUESTION_ID] === "string" && PLAN_CHANGE_CHOICES.has(answer[PLAN_CHANGE_QUESTION_ID]);
	} catch {
		return false;
	}
}

export default function taskPanel(pi: ExtensionAPI) {
	let steps: PlanStep[] = [];
	let planChangeAuthorized = false;
	let planChangeChoiceCallId: string | undefined;

	function render(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (steps.length === 0) { ctx.ui.setWidget(WIDGET_ID, undefined); return; }
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const completed = steps.filter((step) => step.status === "completed").length;
				const lines = [truncateToWidth(theme.fg("accent", theme.bold("Tasks")) + theme.fg("dim", `  ${completed}/${steps.length} completed`), width)];
				for (const step of steps.slice(0, MAX_VISIBLE_STEPS)) {
					const marker = step.status === "completed" ? theme.fg("success", "✓") : step.status === "in_progress" ? theme.fg("warning", "●") : theme.fg("dim", "○");
					const goal = step.status === "completed" ? theme.fg("muted", step.goal) : theme.fg("text", step.goal);
					lines.push(truncateToWidth(` ${marker} ${goal}`, width));
				}
				if (steps.length > MAX_VISIBLE_STEPS) lines.push(theme.fg("dim", ` … ${steps.length - MAX_VISIBLE_STEPS} more`));
				return lines;
			},
		}));
	}

	function restore(ctx: ExtensionContext): void {
		steps = restoreSteps(ctx.sessionManager.getBranch());
		planChangeAuthorized = false;
		planChangeChoiceCallId = undefined;
		render(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", async (event) => {
		if (!isActivePlan(steps)) return;
		event.systemPromptOptions.customInstructions = [event.systemPromptOptions.customInstructions, TASK_DISCIPLINE].filter(Boolean).join("\n\n");
	});
	pi.on("tool_result", async (event) => {
		if (event.toolCallId === planChangeChoiceCallId && isActivePlan(steps) && approvalFromChoices(event)) planChangeAuthorized = true;
		if (event.toolCallId === planChangeChoiceCallId) planChangeChoiceCallId = undefined;
	});
	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (isActivePlan(steps) && isPlanChangeQuestion(event)) planChangeChoiceCallId = event.toolCallId;
		if (event.toolName !== "update_plan") return;
		const next = parseSteps((event.input as { steps?: unknown }).steps);
		if (!next) return { block: true, reason: "Task Panel requires a non-empty valid plan." };
		if (!isActivePlan(steps)) {
			if (!validShape(next)) return { block: true, reason: "A new active plan must have exactly one in_progress step." };
			return;
		}
		if (planChangeAuthorized) { planChangeAuthorized = false; return; }
		const reason = transitionError(steps, next);
		if (reason) return { block: true, reason: `Task Panel blocked this plan update: ${reason}` };
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "update_plan") return;
		const next = parseSteps((event.args as { steps?: unknown } | undefined)?.steps);
		if (!next) return;
		steps = next;
		render(ctx);
	});
}
