import { existsSync, rmSync } from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type SessionInfo } from "@earendil-works/pi-coding-agent";

export const SESSION_DESCRIPTION_TYPE = "terra-session-description-v1";
export type SessionDescription = { text: string };
export type SessionStats = { user: number; assistant: number; toolCalls: number; toolResults: number; input: number; cacheRead: number; cacheWrite: number; output: number; hasUsage: boolean };

export function relativeTime(date: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

export function sessionTitle(session: SessionInfo): string {
	return session.name?.trim() || session.firstMessage.trim().replace(/\s+/g, " ").slice(0, 56) || "Untitled session";
}

export function formatTokens(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

export async function listSessions(): Promise<SessionInfo[]> {
	return (await SessionManager.listAll()).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function descriptionOf(path: string): string {
	try {
		const entries = SessionManager.open(path).getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry.customType !== SESSION_DESCRIPTION_TYPE) continue;
			const data = entry.data as SessionDescription | undefined;
			if (typeof data?.text === "string") return data.text;
		}
	} catch { /* A damaged historical session must not block the library. */ }
	return "";
}

export function statisticsOf(path: string): SessionStats {
	const stats: SessionStats = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, hasUsage: false };
	try {
		for (const entry of SessionManager.open(path).getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") stats.user++;
			else if (message.role === "toolResult") stats.toolResults++;
			else if (message.role === "assistant") {
				stats.assistant++;
				stats.toolCalls += message.content.filter((part) => part.type === "toolCall").length;
				const usage = message.usage;
				if (usage) {
					stats.hasUsage = true;
					stats.input += usage.input || 0;
					stats.cacheRead += usage.cacheRead || 0;
					stats.cacheWrite += usage.cacheWrite || 0;
					stats.output += usage.output || 0;
				}
			}
		}
	} catch { /* Zeroes communicate that unreadable historical data has no usable stats. */ }
	return stats;
}

export function setSessionName(pi: ExtensionAPI, ctx: ExtensionCommandContext, path: string, current: boolean, name: string): void {
	if (current) pi.setSessionName(name);
	else SessionManager.open(path).appendSessionInfo(name);
}

export function setSessionDescription(pi: ExtensionAPI, ctx: ExtensionCommandContext, path: string, current: boolean, text: string): void {
	const data = { text } satisfies SessionDescription;
	if (current) pi.appendEntry(SESSION_DESCRIPTION_TYPE, data);
	else SessionManager.open(path).appendCustomEntry(SESSION_DESCRIPTION_TYPE, data);
}

export function deleteSession(path: string, activePath: string | undefined): boolean {
	if (path === activePath || !path.endsWith(".jsonl") || !existsSync(path)) return false;
	rmSync(path);
	return true;
}

function detailTitle(session: SessionInfo, current: boolean, description: string, stats: SessionStats): string {
	const totalMessages = stats.user + stats.assistant + stats.toolResults;
	const totalInput = stats.input + stats.cacheRead;
	const totalTokens = totalInput + stats.output;
	const cacheRate = totalInput ? ` (${((stats.cacheRead / totalInput) * 100).toFixed(1)}%)` : "";
	const tokens = stats.hasUsage
		? [`Input: ${formatTokens(totalInput)}`, `  Cached: ${formatTokens(stats.cacheRead)}${cacheRate}`, `  Uncached: ${formatTokens(stats.input)} (${formatTokens(stats.cacheWrite)} written to cache)`, `Output: ${formatTokens(stats.output)}`, `Total: ${formatTokens(totalTokens)}`]
		: ["Usage data: —"];
	return [current ? "Current session" : "Historical session", `Name: ${sessionTitle(session)}`, `Description: ${description || "—"}`, `Updated: ${relativeTime(session.modified)}`, `Workspace: ${session.cwd || "—"}`, "", "Messages", `Total: ${formatTokens(totalMessages)}`, `User: ${formatTokens(stats.user)}`, `Assistant: ${formatTokens(stats.assistant)}`, `Tools: ${formatTokens(stats.toolCalls)} calls, ${formatTokens(stats.toolResults)} results`, "", "Tokens", ...tokens].join("\n");
}

export async function openSessionLibrary(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	while (true) {
		const currentPath = ctx.sessionManager.getSessionFile();
		const available = await listSessions();
		if (!available.length) { ctx.ui.notify("No persisted Pi sessions found.", "info"); return; }
		const options = available.map((session) => `${sessionTitle(session)} — ${relativeTime(session.modified)} · ${session.messageCount} messages${session.path === currentPath ? "  ● current" : ""}`);
		const choice = await ctx.ui.select("Session Library", [...options, "Cancel"]);
		if (!choice || choice === "Cancel") return;
		const session = available[options.indexOf(choice)];
		if (!session) continue;
		if (await manageSession(pi, ctx, session, currentPath) === "switch") return;
	}
}

async function manageSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, initial: SessionInfo, currentPath: string | undefined): Promise<"back" | "switch"> {
	let session = initial;
	while (true) {
		const current = session.path === currentPath;
		const description = descriptionOf(session.path);
		const stats = statisticsOf(session.path);
		const actions = current ? ["Edit name", "Edit description", "Back"] : ["Reload in this window", "Edit name", "Edit description", "Delete session", "Back"];
		const selected = await ctx.ui.select(detailTitle(session, current, description, stats), actions);
		if (!selected || selected === "Back") return "back";
		if (selected === "Edit name") {
			const next = await ctx.ui.input("Session name", session.name || sessionTitle(session));
			if (next?.trim()) { setSessionName(pi, ctx, session.path, current, next.trim()); ctx.ui.notify("Session name saved.", "info"); session = (await listSessions()).find((item) => item.path === session.path) || session; }
			continue;
		}
		if (selected === "Edit description") {
			const next = await ctx.ui.editor("Session description", description);
			if (next !== undefined) { setSessionDescription(pi, ctx, session.path, current, next.trim()); ctx.ui.notify("Session description saved.", "info"); }
			continue;
		}
		if (selected === "Reload in this window") {
			await ctx.waitForIdle();
			const result = await ctx.switchSession(session.path, { withSession: async (replacement) => replacement.ui.notify(`Reloaded: ${sessionTitle(session)}`, "info") });
			return result.cancelled ? "back" : "switch";
		}
		if (selected === "Delete session") {
			if (session.path === ctx.sessionManager.getSessionFile()) { ctx.ui.notify("The active session cannot be deleted.", "warning"); continue; }
			const approved = await ctx.ui.confirm("Delete session?", `Permanently delete “${sessionTitle(session)}”? This cannot be undone.`);
			if (!approved) continue;
			if (!deleteSession(session.path, ctx.sessionManager.getSessionFile())) { ctx.ui.notify("The active or unavailable session cannot be deleted.", "warning"); continue; }
			ctx.ui.notify("Session deleted.", "info");
			return "back";
		}
	}
}
