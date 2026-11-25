import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { openSessionLibrary, listSessions, sessionTitle, relativeTime, manageSession } from "../lib/session-library.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_TYPE = "terra-workspace-v1";
const ROOT = process.env.USERPROFILE || process.env.HOME || ".";
const WORKSPACES_FILE = join(ROOT, ".pi", "agent", "workspaces.json");
const DIAGRAMS_DIR = join(".pi", "diagrams");
const DIAGRAMS_MANIFEST = "gallery.json";
const SKILLS_DIR = join(ROOT, ".agents", "skills");
const DISABLED_SKILLS_DIR = join(ROOT, ".agents", "disabled-skills");
const MCP_CACHE_FILE = join(ROOT, ".pi", "agent", "mcp-cache.json");
const RESOURCE_METADATA_FILE = join(ROOT, ".pi", "agent", "resource-library.json");
const EXTENSIONS_DIR = join(ROOT, ".pi", "agent", "extensions");
const NOTES_FILENAME = ".pi/workspace-notes.md";
const NOTES_CTX_FILE = join(ROOT, ".pi", "agent", "workspace-notes-context.json");
const APPROVAL_LOG_FILE = join(ROOT, ".pi", "agent", "destructive-operation-guard.jsonl");
const DIAGRAM_STARTER = "Draw a system architecture diagram for this project.";
const HIDDEN_NAMES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const LIST_PAGE_SIZE = 16;
const DIAGRAM_PAGE_SIZE = 8;
const DRAWER_WIDTH = 54;
const INNER = DRAWER_WIDTH - 2;

// ─── Types ────────────────────────────────────────────────────────────────────

type Workspace = { name: string; path: string };
type View =
	| "home" | "projects" | "browser"
	| "usage" | "diagrams" | "notes" | "env-check" | "approval-log"
	| "skills" | "skill-list" | "skill-detail" | "skill-readme"
	| "mcp" | "mcp-detail";
type FileItem = { name: string; directory: boolean };
type UsageTotals = { input: number; output: number; cacheRead: number };
type Diagram = { id: string; title: string; file: string; type?: string; createdAt?: string; summary?: string };
type Skill = { name: string; description: string; path: string; enabled: boolean };
type SkillEntry = { type: "folder"; name: string; relative: string } | { type: "skill"; skill: Skill };
type McpTool = { name: string; description?: string };
type McpServer = { name: string; tools: McpTool[]; cachedAt?: number };
type ResourceLabels = { displayName?: string; note?: string };
type ResourceMetadata = { skills?: Record<string, ResourceLabels>; mcp?: Record<string, ResourceLabels> };
type TranslationStudioBridge = { version: 1; open(ctx: ExtensionCommandContext): Promise<void> };
type EnvItem = { label: string; status: "ok" | "warn" | "info"; detail: string };
type ApprovalEntry = { timestamp: string; operation: string; tool: string; approval: string; approved: boolean };

// Home items can be selectable entries or section dividers.
type HomeEntry =
	| { kind: "section"; label: string }
	| { kind: "item"; label: string; badge?: string; view?: View; result?: Result["type"] };

type Result =
	| { type: "close" }
	| { type: "workspace"; workspace: Workspace }
	| { type: "view-diagram"; diagram: Diagram }
	| { type: "diagram-starter" }
	| { type: "sessions" | "translation" | "search-sessions" }
	| { type: "notes-action"; action: "edit" | "toggle-context" }
	| { type: "edit-label"; kind: "skills" | "mcp"; key: string; fallback: string; field: "displayName" | "note" }
	| { type: "use-skill"; canonicalName: string }
	| { type: "organize-skills" }
	| { type: "toggle-skill-folder"; enabled: boolean; relative: string }
	| { type: "confirm-skill-toggle"; skill: Skill };

// ─── Bridges ──────────────────────────────────────────────────────────────────

const TRANSLATION_BRIDGE_KEY = Symbol.for("pi-translation-studio.bridge.v1");
const CHOICES_BRIDGE_KEY = Symbol.for("pi-choices.bridge.v1");
const translationBridge = (): TranslationStudioBridge | undefined => {
	const b = (globalThis as Record<symbol, unknown>)[TRANSLATION_BRIDGE_KEY] as TranslationStudioBridge | undefined;
	return b?.version === 1 ? b : undefined;
};
const hasChoicesBridge = (): boolean => !!(globalThis as Record<symbol, unknown>)[CHOICES_BRIDGE_KEY];

// ─── Mermaid viewer ───────────────────────────────────────────────────────────

type MermaidViewer = { server: Server; source: string; title: string; url: string };
let mermaidViewer: MermaidViewer | undefined;

function viewerHtml(title: string, source: string): string {
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<&]/g, "")}</title><style>body{margin:0;background:#1a1b26;color:#c0caf5;font:16px system-ui,sans-serif}header{padding:14px 20px;border-bottom:1px solid #414868;font-weight:600}main{padding:24px;overflow:auto;min-height:calc(100vh - 68px)}.mermaid{background:#24283b;border:1px solid #414868;border-radius:10px;padding:24px;display:inline-block;min-width:calc(100% - 50px);white-space:pre-wrap}.error{color:#f7768e;white-space:pre-wrap;margin-bottom:16px}</style><header>${title.replace(/[<&]/g, "")}</header><main><div class="error" hidden></div><pre class="mermaid"></pre></main><script type="module">const source=${JSON.stringify(source)};const target=document.querySelector('.mermaid');const errorBox=document.querySelector('.error');target.textContent=source;async function loadMermaid(){let lastError;for(const url of ['https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs','https://unpkg.com/mermaid@11/dist/mermaid.esm.min.mjs']){try{return (await import(url)).default}catch(error){lastError=error}}throw lastError}try{const mermaid=await loadMermaid();mermaid.initialize({startOnLoad:false,theme:'dark'});await mermaid.run({nodes:[target]})}catch(error){errorBox.hidden=false;errorBox.textContent='Mermaid renderer could not be loaded. Showing source instead.\\n'+error}</script></html>`;
}

async function openMermaidViewer(root: string, diagram: Diagram): Promise<string | undefined> {
	const source = registeredMermaidSource(root, diagram);
	if (!source) return undefined;
	if (!mermaidViewer) {
		const server = createServer((req, res) => {
			if (!mermaidViewer || req.url !== "/") { res.writeHead(404).end(); return; }
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(viewerHtml(mermaidViewer.title, mermaidViewer.source));
		});
		await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); ok(); }); });
		const addr = server.address();
		if (!addr || typeof addr === "string") { server.close(); return undefined; }
		mermaidViewer = { server, source, title: diagram.title, url: `http://127.0.0.1:${addr.port}/` };
	} else { mermaidViewer.source = source; mermaidViewer.title = diagram.title; }
	spawn("cmd.exe", ["/c", "start", "", mermaidViewer.url], { detached: true, stdio: "ignore" }).unref();
	return mermaidViewer.url;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function configuredWorkspaces(fallback: string): Workspace[] {
	try {
		const data = JSON.parse(readFileSync(WORKSPACES_FILE, "utf8")) as { workspaces?: Workspace[] };
		const found = (data.workspaces || []).filter((w) => typeof w.name === "string" && typeof w.path === "string" && existsSync(w.path));
		if (found.length) return found;
	} catch { /* fallback below */ }
	return [{ name: basename(fallback) || fallback, path: fallback }];
}

function restoredWorkspace(entries: readonly SessionEntry[], fallback: string): Workspace {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "custom" || e.customType !== STATE_TYPE) continue;
		const w = e.data as Workspace | undefined;
		if (w && typeof w.name === "string" && typeof w.path === "string" && existsSync(w.path)) return w;
	}
	return configuredWorkspaces(fallback)[0]!;
}

function browserEntries(path: string): FileItem[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((e) => !HIDDEN_NAMES.has(e.name) && e.isDirectory())
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 120)
			.map((e) => ({ name: e.name, directory: true }));
	} catch { return []; }
}

function sessionUsage(ctx: ExtensionContext): UsageTotals {
	const t: UsageTotals = { input: 0, output: 0, cacheRead: 0 };
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const u = (e.message as AssistantMessage).usage;
		if (!u) continue;
		t.input += u.input || 0; t.output += u.output || 0; t.cacheRead += u.cacheRead || 0;
	}
	return t;
}

const fmtTokens = (n: number) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;

function diagrams(root: string): Diagram[] {
	try {
		const d = JSON.parse(readFileSync(join(root, DIAGRAMS_DIR, DIAGRAMS_MANIFEST), "utf8")) as { diagrams?: Diagram[] };
		return (d.diagrams || []).filter((x) => typeof x.id === "string" && typeof x.title === "string" && typeof x.file === "string");
	} catch { return []; }
}

function resourceMetadata(): ResourceMetadata {
	try { return JSON.parse(readFileSync(RESOURCE_METADATA_FILE, "utf8")) as ResourceMetadata; } catch { return {}; }
}

function saveResourceMetadata(data: ResourceMetadata): void {
	mkdirSync(dirname(RESOURCE_METADATA_FILE), { recursive: true });
	writeFileSync(RESOURCE_METADATA_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function workspaceNotes(workspacePath: string): string {
	try { return readFileSync(join(workspacePath, NOTES_FILENAME), "utf8"); } catch { return ""; }
}

function saveWorkspaceNotes(workspacePath: string, text: string): void {
	const f = join(workspacePath, NOTES_FILENAME);
	mkdirSync(dirname(f), { recursive: true });
	writeFileSync(f, text, "utf8");
}

function notesContextEnabled(workspacePath: string): boolean {
	try { return (JSON.parse(readFileSync(NOTES_CTX_FILE, "utf8")) as Record<string, boolean>)[workspacePath] === true; }
	catch { return false; }
}

function saveNotesContext(workspacePath: string, enabled: boolean): void {
	let data: Record<string, boolean> = {};
	try { data = JSON.parse(readFileSync(NOTES_CTX_FILE, "utf8")) as Record<string, boolean>; } catch { /* first write */ }
	if (enabled) data[workspacePath] = true; else delete data[workspacePath];
	mkdirSync(dirname(NOTES_CTX_FILE), { recursive: true });
	writeFileSync(NOTES_CTX_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readApprovalLog(): ApprovalEntry[] {
	try {
		return readFileSync(APPROVAL_LOG_FILE, "utf8").trim().split("\n").filter(Boolean)
			.map((l) => JSON.parse(l) as ApprovalEntry).reverse();
	} catch { return []; }
}

function buildEnvItems(ctx: ExtensionCommandContext, hasTranslation: boolean, hasChoices: boolean): EnvItem[] {
	const items: EnvItem[] = [];
	const extFiles: string[] = [];
	try { for (const e of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) { if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js")) && !e.name.endsWith(".disabled")) extFiles.push(e.name.replace(/\.[^.]+$/, "")); } } catch { /* ok */ }
	items.push({ label: "Local extensions", status: extFiles.length > 0 ? "ok" : "info", detail: extFiles.length > 0 ? extFiles.join(", ") : "None found" });
	items.push({ label: "pi-choices", status: hasChoices ? "ok" : "warn", detail: hasChoices ? "Available — Task Plan protection active" : "Not loaded — install pi-arsenal" });
	items.push({ label: "Translation Studio", status: hasTranslation ? "ok" : "info", detail: hasTranslation ? "Bridge active" : "Not installed (optional)" });
	items.push({ label: "Workspace path", status: existsSync(ctx.cwd) ? "ok" : "warn", detail: existsSync(ctx.cwd) ? ctx.cwd : `Missing: ${ctx.cwd}` });
	try {
		const raw = JSON.parse(readFileSync(MCP_CACHE_FILE, "utf8")) as { servers?: Record<string, { cachedAt?: number }> };
		const servers = Object.keys(raw.servers || {});
		const ts = Object.values(raw.servers || {}).map((s) => s.cachedAt || 0).filter(Boolean);
		const latest = ts.length ? new Date(Math.max(...ts)) : null;
		items.push({ label: "MCP cache", status: servers.length ? "ok" : "info", detail: servers.length ? `${servers.length} server${servers.length === 1 ? "" : "s"} · ${latest ? latest.toLocaleDateString() : "unknown"}` : "No cached servers" });
	} catch { items.push({ label: "MCP cache", status: "info", detail: "No cache file" }); }
	try {
		let count = 0;
		const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const p = join(dir, e.name); if (existsSync(join(p, "SKILL.md"))) count++; else walk(p); } };
		walk(SKILLS_DIR);
		items.push({ label: "Active skills", status: count > 0 ? "ok" : "info", detail: `${count} skill${count === 1 ? "" : "s"}` });
	} catch { items.push({ label: "Active skills", status: "info", detail: "Skills dir not found" }); }
	const model = ctx.model?.id;
	items.push({ label: "Model", status: model ? "ok" : "warn", detail: model || "Unknown" });
	return items;
}

// ─── Skill helpers ────────────────────────────────────────────────────────────

function isInside(parent: string, child: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function registeredMermaidSource(root: string, diagram: Diagram): string | undefined {
	const base = resolve(root, DIAGRAMS_DIR);
	const file = resolve(base, diagram.file);
	if (diagram.type && diagram.type !== "mermaid") return undefined;
	if (extname(file).toLowerCase() !== ".mmd" || !isInside(base, file) || !existsSync(file)) return undefined;
	try { return readFileSync(file, "utf8"); } catch { return undefined; }
}

function skillRoot(skill: Skill): string { return skill.enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR; }
function skillKey(skill: Skill): string { return relative(skillRoot(skill), skill.path).replaceAll("\\", "/"); }
function categoryOf(skill: Skill): string { const d = dirname(skillKey(skill)); return d === "." ? "Uncategorized" : d; }

const CATEGORY_COLORS = ["accent", "success", "warning", "error", "mdLink", "mdCode", "syntaxFunction", "syntaxType", "syntaxString"] as const;
function categoryColor(cat: string): typeof CATEGORY_COLORS[number] {
	let h = 0; for (const c of cat) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return CATEGORY_COLORS[h % CATEGORY_COLORS.length]!;
}

function validCategory(v: string): string | undefined {
	const c = v.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	return c && !c.split("/").some((p) => !p || p === "." || p === "..") ? c : undefined;
}

function skillCategories(): string[] {
	const collect = (root: string): string[] => {
		const found: string[] = [];
		const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const p = join(dir, e.name); if (!existsSync(join(p, "SKILL.md"))) { found.push(relative(root, p).replaceAll("\\", "/")); walk(p); } } };
		try { walk(root); } catch { /* ok */ }
		return found;
	};
	return [...new Set([...collect(SKILLS_DIR), ...collect(DISABLED_SKILLS_DIR)])].sort();
}

function labelsFor(kind: "skills" | "mcp", key: string): ResourceLabels { return resourceMetadata()[kind]?.[key] || {}; }
function displayName(kind: "skills" | "mcp", key: string, fallback: string): string { return labelsFor(kind, key).displayName?.trim() || fallback; }

function skillCount(folder: string): number {
	try {
		let n = 0;
		const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (!e.isDirectory()) continue; const p = join(d, e.name); if (existsSync(join(p, "SKILL.md"))) n++; else walk(p); } };
		walk(folder); return n;
	} catch { return 0; }
}

function skillEntries(enabled: boolean, directory = ""): SkillEntry[] {
	const root = enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, folder = resolve(root, directory);
	if (!isInside(root, folder)) return [];
	try {
		return readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e): SkillEntry[] => {
			const p = join(folder, e.name), file = join(p, "SKILL.md"), rel = relative(root, p).replaceAll("\\", "/");
			if (!existsSync(file)) return skillCount(p) ? [{ type: "folder", name: e.name, relative: rel }] : [];
			const src = readFileSync(file, "utf8");
			return [{ type: "skill", skill: { name: /^name:\s*(.+)$/m.exec(src)?.[1]?.trim() || e.name, description: /^description:\s*(.+)$/m.exec(src)?.[1]?.trim() || "No description declared.", path: p, enabled } }];
		}).sort((a, b) => Number(b.type === "folder") - Number(a.type === "folder") || (a.type === "folder" ? a.name : a.skill.name).localeCompare(b.type === "folder" ? b.name : b.skill.name));
	} catch { return []; }
}

function moveSkill(skill: Skill, targetRoot: string, targetRelative: string): Skill {
	const target = join(targetRoot, targetRelative);
	if (existsSync(target)) throw new Error("A skill already exists at the destination.");
	mkdirSync(dirname(target), { recursive: true });
	renameSync(skill.path, target);
	const data = resourceMetadata(), oldKey = skillKey(skill), next: Skill = { ...skill, path: target, enabled: targetRoot === SKILLS_DIR }, newKey = skillKey(next);
	if (oldKey !== newKey && data.skills?.[oldKey]) { data.skills[newKey] = data.skills[oldKey]; delete data.skills[oldKey]; saveResourceMetadata(data); }
	return next;
}

function moveSkillFolder(enabled: boolean, folderRelative: string): number {
	const src = enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, dst = enabled ? DISABLED_SKILLS_DIR : SKILLS_DIR;
	const source = resolve(src, folderRelative), target = resolve(dst, folderRelative);
	if (!isInside(src, source) || !isInside(dst, target) || !existsSync(source)) throw new Error("Invalid skill folder.");
	const list = skills().filter((s) => s.enabled === enabled && (skillKey(s) === folderRelative || skillKey(s).startsWith(`${folderRelative}/`)));
	if (!list.length) throw new Error("This folder has no skills to move.");
	for (const s of list) moveSkill(s, dst, skillKey(s));
	return list.length;
}

function skills(): Skill[] {
	const read = (root: string, enabled: boolean): Skill[] => {
		const found: Skill[] = [];
		const walk = (dir: string) => {
			try {
				for (const e of readdirSync(dir, { withFileTypes: true })) {
					if (!e.isDirectory()) continue;
					const p = join(dir, e.name), f = join(p, "SKILL.md");
					if (existsSync(f)) { const src = readFileSync(f, "utf8"); found.push({ name: /^name:\s*(.+)$/m.exec(src)?.[1]?.trim() || e.name, description: /^description:\s*(.+)$/m.exec(src)?.[1]?.trim() || "No description declared.", path: p, enabled }); }
					else walk(p);
				}
			} catch { /* ok */ }
		};
		walk(root); return found;
	};
	return [...read(SKILLS_DIR, true), ...read(DISABLED_SKILLS_DIR, false)].sort((a, b) => Number(b.enabled) - Number(a.enabled) || categoryOf(a).localeCompare(categoryOf(b)) || a.name.localeCompare(b.name));
}

function cachedMcpServers(): McpServer[] {
	try {
		const d = JSON.parse(readFileSync(MCP_CACHE_FILE, "utf8")) as { servers?: Record<string, { tools?: McpTool[]; cachedAt?: number }> };
		return Object.entries(d.servers || {}).map(([name, s]) => ({ name, tools: (s.tools || []).filter((t) => typeof t.name === "string").map(({ name: n, description }) => ({ name: n, description: typeof description === "string" ? description : undefined })), cachedAt: s.cachedAt }));
	} catch { return []; }
}

function driveRoots(): string[] {
	const roots: string[] = [];
	for (let c = 67; c <= 90; c++) { const r = `${String.fromCharCode(c)}:\\`; if (existsSync(r)) roots.push(r); }
	return roots;
}

async function organizeSkillFolders(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const action = await ctx.ui.select("Organize Skill Folders", ["Create shared category folder", "Move a skill", "Back"]);
		if (!action || action === "Back") return;
		if (action === "Create shared category folder") {
			const v = await ctx.ui.input("New shared category", "");
			const cat = v ? validCategory(v) : undefined;
			if (!cat) { ctx.ui.notify("Enter a relative folder name without . or ..", "warning"); continue; }
			mkdirSync(join(SKILLS_DIR, cat), { recursive: true }); mkdirSync(join(DISABLED_SKILLS_DIR, cat), { recursive: true });
			ctx.ui.notify(`Created: ${cat}`, "info"); continue;
		}
		const lib = await ctx.ui.select("Choose library", ["✨ Enabled skills", "💤 Disabled skills", "Cancel"]);
		if (!lib || lib === "Cancel") continue;
		const enabled = lib.startsWith("✨"), list = skills().filter((s) => s.enabled === enabled);
		if (!list.length) { ctx.ui.notify("No skills in this library.", "info"); continue; }
		const choices = list.map((s) => `${displayName("skills", skillKey(s), s.name)} · ${categoryOf(s)}`);
		const sel = await ctx.ui.select("Move a skill", [...choices, "Cancel"]);
		if (!sel || sel === "Cancel") continue;
		const skill = list[choices.indexOf(sel)]; if (!skill) continue;
		const categories = skillCategories();
		const dest = await ctx.ui.select("Move to category", ["Library root (Uncategorized)", ...categories, "Create new category…", "Cancel"]);
		if (!dest || dest === "Cancel") continue;
		let cat = dest === "Library root (Uncategorized)" ? "" : dest;
		if (dest === "Create new category…") {
			const v = await ctx.ui.input("New shared category", ""); cat = v ? validCategory(v) || "" : "";
			if (!cat) { ctx.ui.notify("Enter a relative folder name without . or ..", "warning"); continue; }
			mkdirSync(join(SKILLS_DIR, cat), { recursive: true }); mkdirSync(join(DISABLED_SKILLS_DIR, cat), { recursive: true });
		}
		try { moveSkill(skill, skillRoot(skill), cat ? join(cat, basename(skill.path)) : basename(skill.path)); ctx.ui.notify("Skill moved. Run /reload to apply.", "info"); }
		catch (e) { ctx.ui.notify(e instanceof Error ? e.message : "Could not move skill.", "error"); }
	}
}

async function searchAndOpenSession(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const query = await ctx.ui.input("Search sessions", "");
	if (!query?.trim()) return;
	const term = query.trim().toLowerCase();
	const all = await listSessions();
	const matched = all.filter((s) => sessionTitle(s).toLowerCase().includes(term) || s.firstMessage.toLowerCase().includes(term));
	if (!matched.length) { ctx.ui.notify(`No sessions matching "${query}".`, "info"); return; }
	const currentPath = ctx.sessionManager.getSessionFile();
	const opts = matched.map((s) => `${sessionTitle(s)} — ${relativeTime(s.modified)} · ${s.messageCount} messages${s.path === currentPath ? "  ● current" : ""}`);
	const choice = await ctx.ui.select(`${matched.length} result${matched.length === 1 ? "" : "s"} for "${query}"`, [...opts, "Cancel"]);
	if (!choice || choice === "Cancel") return;
	const session = matched[opts.indexOf(choice)];
	if (!session) return;
	// Hand off to manageSession for full detail view (rename / delete / reload).
	await manageSession(pi, ctx, session, currentPath);
}

// ─── Render helpers ───────────────────────────────────────────────────────────

/** Single row padded to INNER width, with optional accent highlight for selected rows. */
function makeRow(theme: Theme) {
	return (text: string, selected = false): string => {
		const pad = " ".repeat(Math.max(0, INNER - visibleWidth(text)));
		const inner = selected
			? theme.bg("accent", theme.fg("background", text + pad))
			: text + pad;
		return theme.fg("border", "│") + inner + theme.fg("border", "│");
	};
}

/** Section divider line, e.g.  ── Workspace ──────────────── */
function makeDivider(theme: Theme) {
	return (label: string): string => {
		const prefix = "── ";
		const suffix = " " + "─".repeat(Math.max(0, INNER - 4 - visibleWidth(label)));
		return theme.fg("border", "│") + theme.fg("dim", prefix + label + suffix) + theme.fg("border", "│");
	};
}

/** Horizontal bar graph using block characters.  e.g.  ████████░░  8.0k / 32k */
function tokenBar(used: number, total: number, width: number): string {
	if (!total) return "—";
	const ratio = Math.min(1, used / total);
	const filled = Math.round(ratio * width);
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	return `${bar}  ${fmtTokens(used)} / ${fmtTokens(total)}`;
}

/** Breadcrumb: show last two path components, prefixed with …  */
function breadcrumb(path: string): string {
	const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
	if (parts.length <= 2) return path;
	return `… › ${parts.at(-2)} › ${parts.at(-1)}`;
}

// ─── WorkspaceDrawer class ────────────────────────────────────────────────────

class WorkspaceDrawer implements Focusable {
	readonly width = DRAWER_WIDTH;
	focused = false;

	// View state
	private view: View = "home";
	private selected = 0;

	// Per-view data (loaded once on enter, never re-read during render)
	private homeEntries: HomeEntry[] = [];
	private homeSelectables: number[] = [];   // indices of selectable HomeEntry rows
	private browserPath: string | undefined;
	private browserItems: FileItem[] = [];
	private diagramItems: Diagram[] = [];
	private skillItems: Skill[] = [];
	private skillEntryItems: SkillEntry[] = [];
	private skillDirectory = "";
	private skillEnabled = true;
	private selectedSkill: Skill | undefined;
	private skillReadmeLines: string[] = [];   // SKILL.md lines for preview
	private mcpItems: McpServer[] = [];
	private selectedMcp: McpServer | undefined;
	private envItems: EnvItem[] = [];
	private approvalEntries: ApprovalEntry[] = [];
	private approvalPage = 0;

	// Cached data loaded at Drawer open (not per-frame)
	private readonly notesContent: string;
	private notesInCtx: boolean;
	private readonly resourceMeta: ResourceMetadata;

	constructor(
		private readonly ctx: ExtensionCommandContext,
		private readonly workspace: Workspace,
		private readonly workspaces: Workspace[],
		private readonly theme: Theme,
		private readonly done: (result: Result) => void,
		private readonly tui: { requestRender(): void },
		private readonly hasTranslationStudio: boolean,
		private readonly hasPiChoices: boolean,
	) {
		// Load all disk state once at construction; render() never touches disk.
		this.notesContent = workspaceNotes(workspace.path);
		this.notesInCtx = notesContextEnabled(workspace.path);
		this.resourceMeta = resourceMetadata();
		this.buildHomeEntries();
		this.open("home");
	}

	// ── Home entry builder ───────────────────────────────────────────────────

	private buildHomeEntries(): void {
		const hasNotes = this.notesContent.trim().length > 0;
		const inCtx = this.notesInCtx;
		const entries: HomeEntry[] = [
			{ kind: "section", label: "Workspace" },
			{ kind: "item", label: "📁 Projects", view: "projects" },
			{ kind: "item", label: "🗺  Diagram Gallery", view: "diagrams" },
			{ kind: "item", label: `📌 Notes${hasNotes ? " ·" : ""}`, badge: inCtx ? "→ctx" : undefined, view: "notes" },
			{ kind: "item", label: "📊 Session Tokens", view: "usage" },
			{ kind: "item", label: "🖥️  Browse computer…", view: "browser" },
			{ kind: "section", label: "Sessions" },
			{ kind: "item", label: "🕘 Session Library", result: "sessions" },
			{ kind: "item", label: "🔎 Search sessions…", result: "search-sessions" },
			{ kind: "item", label: "🛡  Approval Log", view: "approval-log" },
			{ kind: "section", label: "Resources" },
			{ kind: "item", label: "✨ Skill Library", view: "skills" },
			{ kind: "item", label: "🔌 MCP Servers", view: "mcp" },
			...(this.hasTranslationStudio ? [{ kind: "item" as const, label: "🌐 Translation Studio", result: "translation" as Result["type"] }] : []),
			{ kind: "item", label: "🔍 Environment Check", view: "env-check" },
		];
		this.homeEntries = entries;
		this.homeSelectables = entries.flatMap((e, i) => e.kind === "item" ? [i] : []);
	}

	// ── View open ────────────────────────────────────────────────────────────

	private open(view: View): void {
		this.view = view;
		this.selected = 0;
		if (view === "browser") this.openBrowser(this.browserPath);
		if (view === "diagrams") this.diagramItems = diagrams(this.workspace.path);
		if (view === "skills") this.skillItems = skills();
		if (view === "skill-list") this.skillEntryItems = skillEntries(this.skillEnabled, this.skillDirectory);
		if (view === "mcp") this.mcpItems = cachedMcpServers();
		if (view === "env-check") this.envItems = buildEnvItems(this.ctx, this.hasTranslationStudio, this.hasPiChoices);
		if (view === "approval-log") {
			this.approvalEntries = readApprovalLog();
			this.approvalPage = 0;
		}
		if (view === "skill-readme" && this.selectedSkill) {
			try {
				const raw = readFileSync(join(this.selectedSkill.path, "SKILL.md"), "utf8");
				this.skillReadmeLines = raw.split("\n");
			} catch { this.skillReadmeLines = ["(SKILL.md could not be read)"]; }
		}
	}

	private openBrowser(path: string | undefined): void {
		this.browserPath = path;
		this.selected = 0;
		this.browserItems = path ? browserEntries(path) : driveRoots().map((r) => ({ name: r, directory: true }));
	}

	private backBrowser(): void {
		if (!this.browserPath) { this.open("projects"); return; }
		const parent = dirname(this.browserPath);
		this.openBrowser(parent === this.browserPath ? undefined : parent);
	}

	// ── Input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.view === "home") { this.done({ type: "close" }); return; }
			if (this.view === "browser") { this.backBrowser(); return; }
			if (this.view === "skill-readme") { this.open("skill-detail"); return; }
			if (this.view === "skill-list") {
				if (this.skillDirectory) {
					this.skillDirectory = dirname(this.skillDirectory);
					if (this.skillDirectory === ".") this.skillDirectory = "";
					this.open("skill-list");
				} else this.open("skills");
				return;
			}
			if (this.view === "skill-detail") { this.open("skill-list"); return; }
			if (this.view === "mcp-detail") { this.open("mcp"); return; }
			this.open("home"); return;
		}

		// Context-specific shortcuts (shown in footer)
		if (matchesKey(data, "n") && this.view === "mcp-detail" && this.selectedMcp) {
			this.done({ type: "edit-label", kind: "mcp", key: this.selectedMcp.name, fallback: this.selectedMcp.name, field: "displayName" }); return;
		}
		if (matchesKey(data, "o") && this.view === "mcp-detail" && this.selectedMcp) {
			this.done({ type: "edit-label", kind: "mcp", key: this.selectedMcp.name, fallback: this.selectedMcp.name, field: "note" }); return;
		}
		if (matchesKey(data, "s") && this.view === "browser" && this.browserPath) {
			this.done({ type: "workspace", workspace: { name: basename(this.browserPath) || this.browserPath, path: this.browserPath } }); return;
		}
		// approval-log: [ / ] to page
		if (this.view === "approval-log") {
			const pageSize = 12;
			const maxPage = Math.max(0, Math.ceil(this.approvalEntries.length / pageSize) - 1);
			if ((matchesKey(data, Key.right) || matchesKey(data, "]")) && this.approvalPage < maxPage) { this.approvalPage++; return; }
			if ((matchesKey(data, Key.left) || matchesKey(data, "[")) && this.approvalPage > 0) { this.approvalPage--; return; }
		}
		// skill-readme: Esc / ← back to detail
		if (this.view === "skill-readme") { this.open("skill-detail"); return; }

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) { this.moveSelection(-1); return; }
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) { this.moveSelection(1); return; }
		if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.right)) return;
		this.activate();
	}

	private moveSelection(delta: number): void {
		if (this.view === "home") {
			// Skip over section dividers.
			const idx = this.homeSelectables.indexOf(this.selected);
			const next = this.homeSelectables[Math.max(0, Math.min(this.homeSelectables.length - 1, idx + delta))];
			if (next !== undefined) this.selected = next;
			return;
		}
		const max = this.selectionMax();
		this.selected = Math.max(0, Math.min(max, this.selected + delta));
	}

	private selectionMax(): number {
		switch (this.view) {
			case "projects": return this.workspaces.length;
			case "browser": return Math.max(0, this.browserItems.length - 1);
			case "diagrams": return Math.max(0, (this.diagramItems.length > 0 ? this.diagramItems.length - 1 : 0));
			case "skills": return 1;
			case "skill-list": return this.skillEntryItems.length + (this.skillDirectory ? 1 : 0);
			case "skill-detail": return this.selectedSkill?.enabled ? 4 : 3;
			case "mcp": return Math.max(0, this.mcpItems.length - 1);
			case "mcp-detail": return 0;  // tools are non-interactive; N/O via letter keys
			case "notes": return 1;  // 0 = edit, 1 = toggle context
			case "approval-log": return 1;  // prev/next page arrows
			default: return 0;
		}
	}

	private activate(): void {
		if (this.view === "mcp-detail" || this.view === "usage" || this.view === "env-check" || this.view === "approval-log" || this.view === "skill-readme") return;

		// Notes: two explicit actions instead of direct-to-editor
		if (this.view === "notes") {
			if (this.selected === 0) this.done({ type: "notes-action", action: "edit" });
			else this.done({ type: "notes-action", action: "toggle-context" });
			return;
		}

		if (this.view === "diagrams") {
			if (!this.diagramItems.length && this.selected === 0) { this.done({ type: "diagram-starter" }); return; }
			const d = this.diagramItems[this.selected]; if (d) this.done({ type: "view-diagram", diagram: d }); return;
		}
		if (this.view === "home") {
			const entry = this.homeEntries[this.selected];
			if (!entry || entry.kind !== "item") return;
			if (entry.result) { this.done({ type: entry.result } as Result); return; }
			if (entry.view) { this.open(entry.view); return; }
		}
		if (this.view === "skills") { this.skillEnabled = this.selected === 0; this.skillDirectory = ""; this.open("skill-list"); return; }
		if (this.view === "skill-list") {
			const entry = this.skillEntryItems[this.selected];
			if (entry?.type === "skill") { this.selectedSkill = entry.skill; this.open("skill-detail"); }
			else if (entry?.type === "folder") { this.skillDirectory = entry.relative; this.open("skill-list"); }
			else if (this.skillDirectory && this.selected === this.skillEntryItems.length) this.done({ type: "toggle-skill-folder", enabled: this.skillEnabled, relative: this.skillDirectory });
			else this.done({ type: "organize-skills" });
			return;
		}
		if (this.view === "skill-detail") {
			if (!this.selectedSkill) return;
			const off = this.selectedSkill.enabled ? 1 : 0;
			if (this.selected === 0) this.open("skill-readme");  // first action is always "Read SKILL.md"
			else if (this.selectedSkill.enabled && this.selected === 1) this.done({ type: "use-skill", canonicalName: this.selectedSkill.name });
			else if (this.selected === off + 1) this.done({ type: "edit-label", kind: "skills", key: skillKey(this.selectedSkill), fallback: this.selectedSkill.name, field: "displayName" });
			else if (this.selected === off + 2) this.done({ type: "edit-label", kind: "skills", key: skillKey(this.selectedSkill), fallback: this.selectedSkill.name, field: "note" });
			else this.done({ type: "confirm-skill-toggle", skill: this.selectedSkill });
			return;
		}
		if (this.view === "mcp") { const s = this.mcpItems[this.selected]; if (s) { this.selectedMcp = s; this.open("mcp-detail"); } return; }
		if (this.view === "projects") {
			if (this.selected === this.workspaces.length) { this.open("browser"); return; }
			const w = this.workspaces[this.selected]; if (w) this.done({ type: "workspace", workspace: w }); return;
		}
		if (this.view === "browser") {
			const item = this.browserItems[this.selected];
			if (item) this.openBrowser(this.browserPath ? join(this.browserPath, item.name) : item.name);
		}
	}

	// ── Render ───────────────────────────────────────────────────────────────

	render(_width: number): string[] {
		const th = this.theme;
		const row = makeRow(th);
		const divider = makeDivider(th);
		const sel = (i: number) => i === this.selected;

		const viewTitle: Record<View, string> = {
			home: "Pi Arsenal",
			projects: "Projects",
			browser: "Browse",
			usage: "Session Tokens",
			diagrams: "Diagram Gallery",
			skills: "Skill Library",
			"skill-list": this.skillEnabled ? "Enabled Skills" : "Disabled Skills",
			"skill-detail": "Skill Details",
			"skill-readme": "SKILL.md",
			mcp: "MCP Servers",
			"mcp-detail": "MCP Details",
			notes: "Workspace Notes",
			"env-check": "Environment",
			"approval-log": "Approval Log",
		};

		const title = viewTitle[this.view];
		const lines: string[] = [
			th.fg("borderAccent", `╭─ ${th.bold(title)} ${"─".repeat(Math.max(0, INNER - visibleWidth(title) - 3))}╮`),
		];

		// ── Home ──────────────────────────────────────────────────────────────
		if (this.view === "home") {
			const inCtx = this.notesInCtx;
			lines.push(row(""));
			lines.push(row(` ${th.fg("accent", "◈")} ${th.bold(this.workspace.name)}${inCtx ? `  ${th.fg("success", "→ctx")}` : ""}`));
			lines.push(row(` ${th.fg("dim", this.workspace.path)}`));
			lines.push(row(""));
			for (let i = 0; i < this.homeEntries.length; i++) {
				const entry = this.homeEntries[i]!;
				if (entry.kind === "section") {
					lines.push(divider(entry.label));
				} else {
					const isSelected = i === this.selected;
					const badge = entry.badge ? `  ${th.fg("success", entry.badge)}` : "";
					const label = entry.label + (isSelected ? "" : badge);
					lines.push(row(` ${label}${badge && !isSelected ? "" : (entry.badge && isSelected ? `  ${entry.badge}` : "")}`, isSelected));
				}
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "↑ ↓  Enter / →  Esc close")));

		// ── Projects ─────────────────────────────────────────────────────────
		} else if (this.view === "projects") {
			lines.push(row(th.fg("muted", " Saved project roots")));
			lines.push(row(""));
			for (let i = 0; i < this.workspaces.length; i++) {
				const w = this.workspaces[i]!;
				lines.push(row(` ${th.fg(sel(i) ? "accent" : "text", w.name)}`, sel(i)));
				lines.push(row(`  ${th.fg("dim", w.path)}`));
			}
			lines.push(row(` ${th.fg("accent", "Browse computer…")}`, sel(this.workspaces.length)));
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Enter / →  apply · Esc / ←  back")));

		// ── Browser ───────────────────────────────────────────────────────────
		} else if (this.view === "browser") {
			const crumb = this.browserPath ? breadcrumb(this.browserPath) : "Choose a drive";
			lines.push(row(` ${th.fg("muted", crumb)}`));
			if (this.browserPath) lines.push(row(` ${th.fg("accent", "S")} ${th.fg("dim", "set as workspace")}`));
			lines.push(row(""));
			if (!this.browserItems.length) {
				lines.push(row(th.fg("dim", " No sub-folders here.")));
			} else {
				const start = Math.floor(this.selected / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
				for (let i = start; i < Math.min(start + LIST_PAGE_SIZE, this.browserItems.length); i++) {
					lines.push(row(` ${this.browserItems[i]!.name}/`, sel(i)));
				}
				if (this.browserItems.length > LIST_PAGE_SIZE) lines.push(row(th.fg("dim", ` Page ${Math.floor(start / LIST_PAGE_SIZE) + 1} / ${Math.ceil(this.browserItems.length / LIST_PAGE_SIZE)}`)));
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", this.browserPath ? "Enter / →  open · S select · Esc / ←  up" : "Enter / →  drive · Esc / ←  back")));

		// ── Session Tokens ────────────────────────────────────────────────────
		} else if (this.view === "usage") {
			const t = sessionUsage(this.ctx), ctx = this.ctx.getContextUsage();
			const total = t.input + t.output + t.cacheRead;
			const ctxUsed = ctx?.tokens ?? 0, ctxMax = ctx?.contextWindow ?? 0;
			lines.push(row(""));
			lines.push(row(` ${th.fg("muted", this.ctx.model?.id || "—")}`));
			lines.push(row(""));
			lines.push(row(` Input       ${th.fg("accent", fmtTokens(t.input))}`));
			lines.push(row(` Output      ${th.fg("accent", fmtTokens(t.output))}`));
			lines.push(row(` Cache read  ${th.fg("accent", fmtTokens(t.cacheRead))}`));
			lines.push(row(` Total       ${th.fg("accent", fmtTokens(total))}`));
			lines.push(row(""));
			if (ctxMax) {
				const barWidth = Math.max(10, INNER - 22);
				const bar = tokenBar(ctxUsed, ctxMax, barWidth);
				const pct = `${((ctxUsed / ctxMax) * 100).toFixed(0)}%`;
				const color = ctxUsed / ctxMax > 0.85 ? "error" : ctxUsed / ctxMax > 0.6 ? "warning" : "success";
				lines.push(row(` Context  ${th.fg(color, pct)}`));
				lines.push(row(` ${th.fg(color, bar)}`));
			} else {
				lines.push(row(` Context  ${th.fg("dim", "—")}`));
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Session only · Esc / ←  back")));

		// ── Diagram Gallery ───────────────────────────────────────────────────
		} else if (this.view === "diagrams") {
			lines.push(row(th.fg("muted", " Registered Mermaid diagrams")));
			lines.push(row(""));
			if (this.diagramItems.length) {
				const start = Math.floor(this.selected / DIAGRAM_PAGE_SIZE) * DIAGRAM_PAGE_SIZE;
				for (let i = start; i < Math.min(start + DIAGRAM_PAGE_SIZE, this.diagramItems.length); i++) {
					const d = this.diagramItems[i]!;
					lines.push(row(` ${th.fg(sel(i) ? "accent" : "text", d.title)}`, sel(i)));
					lines.push(row(`  ${th.fg("dim", `${d.type || "mermaid"}${d.createdAt ? ` · ${d.createdAt}` : ""}`)}`));
				}
				if (this.diagramItems.length > DIAGRAM_PAGE_SIZE) lines.push(row(th.fg("dim", ` Page ${Math.floor(start / DIAGRAM_PAGE_SIZE) + 1} / ${Math.ceil(this.diagramItems.length / DIAGRAM_PAGE_SIZE)}`)));
				lines.push(row(""));
				lines.push(row(th.fg("dim", "Enter / →  open in browser · Esc / ←  back")));
			} else {
				lines.push(row(th.fg("dim", " No diagrams yet.")));
				lines.push(row(""));
				lines.push(row(th.fg("muted", " Try asking Pi:")));
				lines.push(row(` ${th.fg("accent", `"${DIAGRAM_STARTER}"`)}`));
				lines.push(row(""));
				lines.push(row(th.fg("dim", "Enter sends prompt · Esc / ←  back")));
			}

		// ── Workspace Notes ───────────────────────────────────────────────────
		} else if (this.view === "notes") {
			const inCtx = this.notesInCtx;
			lines.push(row(` ${th.fg("muted", this.workspace.name)}  ${inCtx ? th.fg("success", "→ included in context") : th.fg("dim", "not in context")}`));
			lines.push(row(""));
			if (this.notesContent.trim()) {
				for (const line of this.notesContent.split("\n").slice(0, 14)) lines.push(row(` ${th.fg("text", line)}`));
				const extra = this.notesContent.split("\n").length - 14;
				if (extra > 0) lines.push(row(th.fg("dim", ` … ${extra} more lines`)));
			} else {
				lines.push(row(th.fg("dim", " No notes yet.")));
				lines.push(row(th.fg("dim", " Personal reminders — not sent to model by default.")));
			}
			lines.push(row(""));
			lines.push(row(` ${th.fg("text", "✏️  Edit notes")}`, sel(0)));
			lines.push(row(` ${th.fg(inCtx ? "success" : "muted", inCtx ? "■  Remove from context" : "□  Include in context")}`, sel(1)));
			lines.push(row(""));
			lines.push(row(th.fg("dim", "↑ ↓  Enter confirm · Esc / ←  back")));

		// ── Environment Check ─────────────────────────────────────────────────
		} else if (this.view === "env-check") {
			lines.push(row(th.fg("muted", " Extension and environment status")));
			lines.push(row(""));
			for (const item of this.envItems) {
				const icon = item.status === "ok" ? th.fg("success", "✓") : item.status === "warn" ? th.fg("error", "!") : th.fg("dim", "·");
				lines.push(row(` ${icon} ${th.fg(item.status === "warn" ? "error" : "text", item.label)}`));
				lines.push(row(`   ${th.fg("dim", item.detail)}`));
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Esc / ←  back")));

		// ── Skill Library ─────────────────────────────────────────────────────
		} else if (this.view === "skills") {
			const active = this.skillItems.filter((s) => s.enabled).length;
			const disabled = this.skillItems.length - active;
			lines.push(row(th.fg("muted", " Choose a library")));
			lines.push(row(""));
			lines.push(row(` ✨ Enabled skills · ${th.fg("accent", String(active))}`, sel(0)));
			lines.push(row(` 💤 Disabled skills · ${th.fg("muted", String(disabled))}`, sel(1)));
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Enter / →  open · Esc / ←  back")));

		// ── Skill List ────────────────────────────────────────────────────────
		} else if (this.view === "skill-list") {
			const loc = this.skillDirectory || "Library root";
			lines.push(row(` ${th.fg("muted", `${this.skillEnabled ? "✨" : "💤"} ${loc}`)}`));
			lines.push(row(""));
			if (!this.skillEntryItems.length) lines.push(row(th.fg("dim", " This folder is empty.")));
			else {
				for (let i = 0; i < this.skillEntryItems.length; i++) {
					const entry = this.skillEntryItems[i]!;
					if (entry.type === "folder") {
						const color = categoryColor(entry.relative);
						const count = skillCount(join(this.skillEnabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, entry.relative));
						lines.push(row(` ${th.fg(color, `📂 ${entry.name}`)} ${th.fg("dim", `· ${count}`)}`, sel(i)));
					} else {
						const s = entry.skill, cat = categoryOf(s), name = displayName("skills", skillKey(s), s.name);
						const note = this.resourceMeta.skills?.[skillKey(s)]?.note || s.description;
						lines.push(row(` ${th.fg(categoryColor(cat), `${this.skillEnabled ? "✨" : "💤"} ${name}`)}`, sel(i)));
						lines.push(row(`  ${th.fg("dim", note)}`));
					}
				}
			}
			const actionBase = this.skillEntryItems.length;
			if (this.skillDirectory) lines.push(row(` ${th.fg("warning", `${this.skillEnabled ? "💤 Disable" : "✨ Enable"} this folder`)}`, sel(actionBase)));
			lines.push(row(` ${th.fg("accent", "📂 Organize folders…")}`, sel(actionBase + (this.skillDirectory ? 1 : 0))));
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Enter / →  open · Esc / ←  up")));

		// ── Skill Detail ──────────────────────────────────────────────────────
		} else if (this.view === "skill-detail") {
			const s = this.selectedSkill;
			if (s) {
				const labels = this.resourceMeta.skills?.[skillKey(s)] || {}, cat = categoryOf(s), color = categoryColor(cat);
				lines.push(row(`  ${th.fg(color, s.enabled ? "✨ Enabled" : "💤 Disabled")} · ${th.fg(color, displayName("skills", skillKey(s), s.name))}`));
				lines.push(row(`  ${th.fg(color, `📂 ${cat}`)}`));
				lines.push(row(""));
				if (labels.note) { lines.push(row(`  ${th.fg("muted", labels.note)}`)); lines.push(row("")); }
				lines.push(row(`  ${th.fg("dim", s.description)}`));
				lines.push(row(""));
				const actions = s.enabled
					? ["Read SKILL.md", "Use this skill now", "Edit display name", "Edit personal note", "Disable this skill"]
					: ["Read SKILL.md", "Edit display name", "Edit personal note", "Enable this skill"];
				for (const [i, action] of actions.entries()) lines.push(row(` ${th.fg(sel(i) ? "accent" : "text", action)}`, sel(i)));
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "↑ ↓  Enter / →  confirm · Esc / ←  back")));

		// ── MCP List ──────────────────────────────────────────────────────────
		} else if (this.view === "mcp") {
			lines.push(row(th.fg("muted", " Cached MCP servers · no secrets shown")));
			lines.push(row(""));
			if (!this.mcpItems.length) {
				lines.push(row(th.fg("dim", " No cached MCP servers.")));
			} else {
				for (let i = 0; i < this.mcpItems.length; i++) {
					const server = this.mcpItems[i]!;
					const labels = this.resourceMeta.mcp?.[server.name] || {};
					const name = labels.displayName?.trim() || server.name;
					lines.push(row(` 🔌 ${th.fg(sel(i) ? "accent" : "text", name)}`, sel(i)));
					lines.push(row(`  ${th.fg("dim", labels.note || `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`)}`));
				}
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "Enter / →  details · Esc / ←  back")));

		// ── MCP Detail ────────────────────────────────────────────────────────
		} else if (this.view === "mcp-detail") {
			const server = this.selectedMcp;
			if (server) {
				const labels = this.resourceMeta.mcp?.[server.name] || {};
				const name = labels.displayName?.trim() || server.name;
				lines.push(row(`  ${th.fg("accent", `🔌 ${name}`)}`));
				if (labels.note) lines.push(row(`  ${th.fg("muted", labels.note)}`));
				lines.push(row(`  ${th.fg("dim", `Original: ${server.name}`)}`));
				lines.push(row(`  ${th.fg("muted", `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} · no secrets shown`)}`));
				lines.push(row(""));
				if (server.tools.length) {
					const start = Math.floor(this.selected / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
					for (let i = start; i < Math.min(start + LIST_PAGE_SIZE, server.tools.length); i++) {
						const tool = server.tools[i]!;
						lines.push(row(` ${th.fg(sel(i) ? "accent" : "text", tool.name)}`, sel(i)));
						if (tool.description) lines.push(row(`  ${th.fg("dim", tool.description)}`));
					}
					if (server.tools.length > LIST_PAGE_SIZE) lines.push(row(th.fg("dim", ` Page ${Math.floor(start / LIST_PAGE_SIZE) + 1} / ${Math.ceil(server.tools.length / LIST_PAGE_SIZE)}`)));
				} else lines.push(row(th.fg("dim", " No cached tools.")));
				lines.push(row(""));
				lines.push(row(th.fg("dim", "N display name · O note · Esc / ←  back")));
			}

		// ── Skill README ─────────────────────────────────────────────────────
		} else if (this.view === "skill-readme") {
			const name = this.selectedSkill ? displayName("skills", skillKey(this.selectedSkill), this.selectedSkill.name) : "";
			lines.push(row(` ${th.fg("muted", name)}`));
			lines.push(row(""));
			const maxLines = 24;
			const readmeLines = this.skillReadmeLines;
			const start = Math.floor(this.selected / maxLines) * maxLines;
			for (let i = start; i < Math.min(start + maxLines, readmeLines.length); i++) {
				// Strip markdown formatting for clean display
				const raw = readmeLines[i]!.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
				const isHeader = /^#{1,6}\s/.test(readmeLines[i]!);
				lines.push(row(` ${isHeader ? th.fg("accent", raw) : th.fg("text", raw)}`));
			}
			if (readmeLines.length > maxLines) {
				const page = Math.floor(start / maxLines) + 1;
				const total = Math.ceil(readmeLines.length / maxLines);
				lines.push(row(th.fg("dim", ` Page ${page} / ${total}`)));
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "↑ ↓  scroll · Esc / ←  back to detail")));

		// ── Approval Log ─────────────────────────────────────────────────────
		} else if (this.view === "approval-log") {
			const entries = this.approvalEntries;
			const pageSize = 12;
			const today = new Date().toDateString();
			const todayCount = entries.filter((e) => new Date(e.timestamp).toDateString() === today).length;
			lines.push(row(` ${th.fg("muted", `${entries.length} total entries${todayCount ? ` · ${todayCount} today` : ""}`)}`));
			lines.push(row(""));
			if (!entries.length) {
				lines.push(row(th.fg("dim", " No approval events yet.")));
				lines.push(row(th.fg("dim", " Events are recorded when pi-op-approval intercepts a tool call.")));
			} else {
				const start = this.approvalPage * pageSize;
				for (let i = start; i < Math.min(start + pageSize, entries.length); i++) {
					const e = entries[i]!;
					const time = new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
					const isToday = new Date(e.timestamp).toDateString() === today;
					const verdict = e.approved && e.approval !== "deny";
					const verdictStr = verdict ? "allow" : "deny ";
					const verdictColor = verdict ? "success" : "error";
					const timeStr = isToday ? th.fg("text", time) : th.fg("dim", time);
					lines.push(row(` ${timeStr}  ${th.fg(verdictColor, verdictStr)}  ${th.fg("text", e.operation)}  ${th.fg("dim", `(${e.tool})`)}`));
				}
				const totalPages = Math.ceil(entries.length / pageSize);
				if (totalPages > 1) {
					lines.push(row(""));
					const prev = this.approvalPage > 0 ? th.fg("accent", "[ prev") : th.fg("dim", "[ prev");
					const next = this.approvalPage < totalPages - 1 ? th.fg("accent", "next ]") : th.fg("dim", "next ]");
					lines.push(row(` ${prev}  Page ${this.approvalPage + 1} / ${totalPages}  ${next}`));
				}
			}
			lines.push(row(""));
			lines.push(row(th.fg("dim", "[ / ]  page · Esc / ←  back")));
		}

		lines.push(th.fg("borderAccent", `╰${"─".repeat(INNER)}╯`));
		return lines;
	}

	invalidate(): void {}
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function workspaceDrawer(pi: ExtensionAPI) {
	let workspace: Workspace | undefined;
	const active = (ctx: ExtensionContext): Workspace => workspace || restoredWorkspace(ctx.sessionManager.getBranch(), ctx.cwd);
	const restore = (ctx: ExtensionContext) => { workspace = restoredWorkspace(ctx.sessionManager.getBranch(), ctx.cwd); };

	pi.on("session_start", async (_e, ctx) => restore(ctx));
	pi.on("session_tree", async (_e, ctx) => restore(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		const root = active(ctx);
		const notes = notesContextEnabled(root.path) ? workspaceNotes(root.path).trim() : "";
		const notesSection = notes ? `\n\nWorkspace Notes (personal reminders from the user — read-only context, do not modify):\n${notes}` : "";
		return {
			systemPrompt: `${event.systemPrompt}\n\nActive Workspace: ${root.path}\nInterpret relative file paths, project files, and project commands as referring to this workspace by default. Use paths under it for native file tools and run project shell commands from it. An explicit user-provided absolute path overrides this default.\n\nDiagram Gallery contract: Do not create or register diagrams unless the user explicitly asks you to generate a diagram, chart, architecture view, flowchart, or node graph. For such a request, create Mermaid flowchart/graph source under <Active Workspace>/.pi/diagrams/<stable-id>.mmd and create or update <Active Workspace>/.pi/diagrams/gallery.json in this exact shape: {"diagrams":[{"id":"stable-id","title":"Human title","file":"stable-id.mmd","type":"mermaid","createdAt":"ISO-8601 timestamp","summary":"short description"}]}. The TUI Gallery only displays manifest entries and previews .mmd Mermaid sources; never infer or auto-register existing files.${notesSection}\n`,
		};
	});

	const open = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") return;
		const current = active(ctx);

		const result = await ctx.ui.custom<Result>(
			(tui, theme, _kb, done) => new WorkspaceDrawer(ctx, current, configuredWorkspaces(ctx.cwd), theme, done, tui, Boolean(translationBridge()), hasChoicesBridge()),
			{ overlay: true, overlayOptions: { anchor: "right-center", width: DRAWER_WIDTH + 2, maxHeight: "100%", margin: { top: 1, right: 1, bottom: 1 } } },
		);
		if (!result) return;

		switch (result.type) {
			case "workspace":
				workspace = result.workspace;
				pi.appendEntry(STATE_TYPE, workspace);
				ctx.ui.notify(`Workspace: ${workspace.name}`, "info");
				break;

			case "sessions":
				await openSessionLibrary(pi, ctx);
				break;

			case "search-sessions":
				await searchAndOpenSession(pi, ctx);
				break;

			case "translation": {
				const bridge = translationBridge();
				if (bridge) await bridge.open(ctx);
				else ctx.ui.notify("Install pi-translation-studio to enable Translation Studio.", "info");
				break;
			}

			case "diagram-starter":
				ctx.ui.setEditorText(DIAGRAM_STARTER);
				ctx.ui.notify("Prompt placed in editor — add details and submit when ready.", "info");
				break;

			case "notes-action": {
				if (result.action === "edit") {
					const existing = workspaceNotes(current.path);
					const next = await ctx.ui.editor("Workspace Notes", existing);
					if (next !== undefined) {
						saveWorkspaceNotes(current.path, next.trim() ? `${next.trim()}\n` : "");
						ctx.ui.notify(next.trim() ? "Notes saved." : "Notes cleared.", "info");
					}
				} else {
					const enabled = notesContextEnabled(current.path);
					saveNotesContext(current.path, !enabled);
					ctx.ui.notify(!enabled ? "📌 Notes will be included in context from the next message." : "Notes removed from context.", "info");
				}
				break;
			}

			case "organize-skills":
				await organizeSkillFolders(ctx);
				await open(ctx);
				break;

			case "use-skill":
				ctx.ui.setEditorText(`/skill:${result.canonicalName} `);
				ctx.ui.notify("Skill command ready — add details and submit.", "info");
				break;

			case "toggle-skill-folder": {
				const action = result.enabled ? "Disable" : "Enable";
				const approved = await ctx.ui.confirm(`${action} skill folder?`, `${action} every skill in "${result.relative}"? Nothing is deleted; folders move to the other library.`);
				if (approved) {
					try { const count = moveSkillFolder(result.enabled, result.relative); ctx.ui.notify(`${action}d ${count} skill${count === 1 ? "" : "s"}. Run /reload to apply.`, "info"); }
					catch (e) { ctx.ui.notify(e instanceof Error ? e.message : "Could not move folder.", "error"); }
				}
				await open(ctx);
				break;
			}

			case "confirm-skill-toggle": {
				const { skill } = result;
				const action = skill.enabled ? "Disable" : "Enable";
				const approved = await ctx.ui.confirm(`${action} skill?`, `${action} "${skill.name}"? The folder moves to the ${skill.enabled ? "disabled" : "active"} library. Nothing is deleted. Run /reload to apply.`);
				if (approved) {
					try {
						moveSkill(skill, skill.enabled ? DISABLED_SKILLS_DIR : SKILLS_DIR, skillKey(skill));
						ctx.ui.notify(`${action}d "${skill.name}". Run /reload to apply.`, "info");
					} catch (e) { ctx.ui.notify(e instanceof Error ? e.message : "Could not move skill.", "error"); }
				}
				break;
			}

			case "edit-label": {
				const meta = resourceMetadata();
				const existing = (meta[result.kind] ?? {})[result.key]?.[result.field] ?? "";
				const next = result.field === "displayName"
					? await ctx.ui.input(`${result.kind === "mcp" ? "MCP" : "Skill"} display name`, (existing as string) || result.fallback)
					: await ctx.ui.editor(`Note for ${result.fallback}`, existing as string);
				if (next !== undefined) {
					const data = resourceMetadata(), col = data[result.kind] || {};
					const labels = { ...col[result.key], [result.field]: next.trim() };
					if (!labels.displayName && !labels.note) delete col[result.key]; else col[result.key] = labels;
					data[result.kind] = col;
					saveResourceMetadata(data);
					ctx.ui.notify("Personal label saved — not sent to model.", "info");
				}
				break;
			}

			case "view-diagram": {
				const url = await openMermaidViewer(current.path, result.diagram);
				ctx.ui.notify(url ? `Opened: ${result.diagram.title}` : "No readable .mmd source for this entry.", url ? "info" : "error");
				break;
			}
		}
	};

	pi.registerCommand("workspace", { description: "Open Terra Workspace Drawer", handler: async (_a, ctx) => open(ctx) });
	pi.registerShortcut(Key.alt("w"), { description: "Open Terra Workspace Drawer", handler: async (ctx) => open(ctx as ExtensionCommandContext) });
}
