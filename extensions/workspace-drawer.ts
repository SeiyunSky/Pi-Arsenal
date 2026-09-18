import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { openSessionLibrary } from "../lib/session-library.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

const STATE_TYPE = "terra-workspace-v1";
const ROOT = process.env.USERPROFILE || process.env.HOME || ".";
const WORKSPACES_FILE = join(ROOT, ".pi", "agent", "workspaces.json");
const MODELS_FILE = join(ROOT, ".pi", "agent", "models.json");
const DIAGRAMS_DIR = join(".pi", "diagrams");
const DIAGRAMS_MANIFEST = "gallery.json";
const SKILLS_DIR = join(ROOT, ".agents", "skills");
const DISABLED_SKILLS_DIR = join(ROOT, ".agents", "disabled-skills");
const MCP_CACHE_FILE = join(ROOT, ".pi", "agent", "mcp-cache.json");
const RESOURCE_METADATA_FILE = join(ROOT, ".pi", "agent", "resource-library.json");
const HIDDEN_NAMES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const LIST_PAGE_SIZE = 16;
const DIAGRAM_PAGE_SIZE = 8;

type Workspace = { name: string; path: string };
type View = "home" | "projects" | "files" | "browser" | "usage" | "diagrams" | "skills" | "skill-list" | "skill-detail" | "skill-confirm" | "mcp" | "mcp-detail";
type FileItem = { name: string; directory: boolean };
type Pricing = { input: number; output: number; cacheRead?: number };
type UsageTotals = { input: number; output: number; cacheRead: number };
type Diagram = { id: string; title: string; file: string; type?: string; createdAt?: string; summary?: string };
type Skill = { name: string; description: string; path: string; enabled: boolean };
type SkillEntry = { type: "folder"; name: string; relative: string } | { type: "skill"; skill: Skill };
type McpTool = { name: string; description?: string };
type McpServer = { name: string; tools: McpTool[]; cachedAt?: number };
type ResourceLabels = { displayName?: string; note?: string };
type ResourceMetadata = { skills?: Record<string, ResourceLabels>; mcp?: Record<string, ResourceLabels> };
type Result = { type: "close" } | { type: "workspace"; workspace: Workspace } | { type: "view-diagram"; diagram: Diagram } | { type: "sessions" } | { type: "edit-label"; kind: "skills" | "mcp"; key: string; fallback: string; field: "displayName" | "note" } | { type: "use-skill"; canonicalName: string } | { type: "organize-skills" } | { type: "toggle-skill-folder"; enabled: boolean; relative: string };

type MermaidViewer = { server: Server; source: string; title: string; url: string };
let mermaidViewer: MermaidViewer | undefined;

function configuredWorkspaces(fallback: string): Workspace[] {
	try {
		const data = JSON.parse(readFileSync(WORKSPACES_FILE, "utf8")) as { workspaces?: Workspace[] };
		const found = (data.workspaces || []).filter((item) => typeof item.name === "string" && typeof item.path === "string" && existsSync(item.path));
		if (found.length) return found;
	} catch { /* Current Pi cwd is a safe fallback. */ }
	return [{ name: basename(fallback) || fallback, path: fallback }];
}

function restoredWorkspace(entries: readonly SessionEntry[], fallback: string): Workspace {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const item = entry.data as Workspace | undefined;
		if (item && typeof item.name === "string" && typeof item.path === "string" && existsSync(item.path)) return item;
	}
	return configuredWorkspaces(fallback)[0]!;
}

function entries(path: string, directoriesOnly = false): FileItem[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => !HIDDEN_NAMES.has(entry.name) && (!directoriesOnly || entry.isDirectory()))
			.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
			.slice(0, 120)
			.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
	} catch { return []; }
}

function sessionUsage(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		if (!usage) continue;
		totals.input += usage.input || 0;
		totals.output += usage.output || 0;
		totals.cacheRead += usage.cacheRead || 0;
	}
	return totals;
}

const formatTokens = (value: number) => value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;

function diagrams(root: string): Diagram[] {
	try {
		const data = JSON.parse(readFileSync(join(root, DIAGRAMS_DIR, DIAGRAMS_MANIFEST), "utf8")) as { diagrams?: Diagram[] };
		return (data.diagrams || []).filter((item) => typeof item.id === "string" && typeof item.title === "string" && typeof item.file === "string");
	} catch { return []; }
}

function resourceMetadata(): ResourceMetadata {
	try { return JSON.parse(readFileSync(RESOURCE_METADATA_FILE, "utf8")) as ResourceMetadata; } catch { return {}; }
}

function saveResourceMetadata(data: ResourceMetadata): void {
	mkdirSync(dirname(RESOURCE_METADATA_FILE), { recursive: true });
	writeFileSync(RESOURCE_METADATA_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function skillRoot(skill: Skill): string { return skill.enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR; }
function skillKey(skill: Skill): string { return relative(skillRoot(skill), skill.path).replaceAll("\\", "/"); }
function moveSkill(skill: Skill, targetRoot: string, targetRelative: string): Skill {
	const target = join(targetRoot, targetRelative);
	if (existsSync(target)) throw new Error("A skill already exists at the destination.");
	mkdirSync(dirname(target), { recursive: true });
	renameSync(skill.path, target);
	const data = resourceMetadata(), oldKey = skillKey(skill), next: Skill = { ...skill, path: target, enabled: targetRoot === SKILLS_DIR }, newKey = skillKey(next);
	if (oldKey !== newKey && data.skills?.[oldKey]) { data.skills[newKey] = data.skills[oldKey]; delete data.skills[oldKey]; saveResourceMetadata(data); }
	return next;
}
function categoryOf(skill: Skill): string { const dir = dirname(skillKey(skill)); return dir === "." ? "Uncategorized" : dir; }
const CATEGORY_COLORS = ["accent", "success", "warning", "error", "mdLink", "mdCode", "syntaxFunction", "syntaxType", "syntaxString"] as const;
function categoryColor(category: string): typeof CATEGORY_COLORS[number] {
	let hash = 0; for (const char of category) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return CATEGORY_COLORS[hash % CATEGORY_COLORS.length]!;
}
function validCategory(value: string): string | undefined {
	const category = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	return category && !category.split("/").some((part) => !part || part === "." || part === "..") ? category : undefined;
}
function skillCategories(): string[] {
	const collect = (root: string): string[] => { const found: string[] = []; const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) { if (!item.isDirectory()) continue; const path = join(dir, item.name); if (existsSync(join(path, "SKILL.md"))) continue; found.push(relative(root, path).replaceAll("\\", "/")); walk(path); } }; try { walk(root); } catch { /* Empty or unavailable library. */ } return found; };
	return [...new Set([...collect(SKILLS_DIR), ...collect(DISABLED_SKILLS_DIR)])].sort();
}
function labelsFor(kind: "skills" | "mcp", key: string): ResourceLabels { return resourceMetadata()[kind]?.[key] || {}; }
function displayName(kind: "skills" | "mcp", key: string, fallback: string): string { return labelsFor(kind, key).displayName?.trim() || fallback; }

function skills(): Skill[] {
	const read = (root: string, enabled: boolean): Skill[] => {
		const found: Skill[] = [], walk = (dir: string) => { try { for (const item of readdirSync(dir, { withFileTypes: true })) { if (!item.isDirectory()) continue; const path = join(dir, item.name), file = join(path, "SKILL.md"); if (existsSync(file)) { const source = readFileSync(file, "utf8"); found.push({ name: /^name:\s*(.+)$/m.exec(source)?.[1]?.trim() || item.name, description: /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() || "No description declared.", path, enabled }); } else walk(path); } } catch { /* An unreadable folder does not block the library. */ } };
		walk(root); return found;
	};
	return [...read(SKILLS_DIR, true), ...read(DISABLED_SKILLS_DIR, false)].sort((a, b) => Number(b.enabled) - Number(a.enabled) || categoryOf(a).localeCompare(categoryOf(b)) || a.name.localeCompare(b.name));
}

function skillCount(folder: string): number {
	try { let count = 0; const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) { if (!item.isDirectory()) continue; const path = join(dir, item.name); if (existsSync(join(path, "SKILL.md"))) count++; else walk(path); } }; walk(folder); return count; } catch { return 0; }
}

function skillEntries(enabled: boolean, directory = ""): SkillEntry[] {
	const root = enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, folder = resolve(root, directory);
	if (!isInside(root, folder)) return [];
	try { return readdirSync(folder, { withFileTypes: true }).filter((item) => item.isDirectory()).flatMap((item): SkillEntry[] => {
		const path = join(folder, item.name), file = join(path, "SKILL.md"), relativePath = relative(root, path).replaceAll("\\", "/");
		if (!existsSync(file)) return skillCount(path) ? [{ type: "folder", name: item.name, relative: relativePath }] : [];
		const source = readFileSync(file, "utf8"); return [{ type: "skill", skill: { name: /^name:\s*(.+)$/m.exec(source)?.[1]?.trim() || item.name, description: /^description:\s*(.+)$/m.exec(source)?.[1]?.trim() || "No description declared.", path, enabled } }];
	}).sort((a, b) => Number(b.type === "folder") - Number(a.type === "folder") || (a.type === "folder" ? a.name : a.skill.name).localeCompare(b.type === "folder" ? b.name : b.skill.name)); } catch { return []; }
}

function moveSkillFolder(enabled: boolean, folderRelative: string): number {
	const sourceRoot = enabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, targetRoot = enabled ? DISABLED_SKILLS_DIR : SKILLS_DIR;
	const source = resolve(sourceRoot, folderRelative), target = resolve(targetRoot, folderRelative);
	if (!isInside(sourceRoot, source) || !isInside(targetRoot, target) || !existsSync(source)) throw new Error("Invalid skill folder.");
	const contained = skills().filter((skill) => skill.enabled === enabled && (skillKey(skill) === folderRelative || skillKey(skill).startsWith(`${folderRelative}/`)));
	if (!contained.length) throw new Error("This folder has no skills to move.");
	for (const skill of contained) moveSkill(skill, targetRoot, skillKey(skill));
	return contained.length;
}

function cachedMcpServers(): McpServer[] {
	try {
		const data = JSON.parse(readFileSync(MCP_CACHE_FILE, "utf8")) as { servers?: Record<string, { tools?: McpTool[]; cachedAt?: number }> };
		return Object.entries(data.servers || {}).map(([name, server]) => ({ name, tools: (server.tools || []).filter((tool) => typeof tool.name === "string").map(({ name, description }) => ({ name, description: typeof description === "string" ? description : undefined })), cachedAt: server.cachedAt }));
	} catch { return []; }
}

async function organizeSkillFolders(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const action = await ctx.ui.select("Organize Skill Folders", ["Create shared category folder", "Move a skill", "Back"]);
		if (!action || action === "Back") return;
		if (action === "Create shared category folder") {
			const value = await ctx.ui.input("New shared category", "");
			const category = value ? validCategory(value) : undefined;
			if (!category) { ctx.ui.notify("Enter a relative folder name without . or ...", "warning"); continue; }
			mkdirSync(join(SKILLS_DIR, category), { recursive: true }); mkdirSync(join(DISABLED_SKILLS_DIR, category), { recursive: true });
			ctx.ui.notify(`Created category in both libraries: ${category}`, "info"); continue;
		}
		const library = await ctx.ui.select("Choose skill library", ["✨ Enabled skills", "💤 Disabled skills", "Cancel"]);
		if (!library || library === "Cancel") continue;
		const enabled = library.startsWith("✨"), list = skills().filter((skill) => skill.enabled === enabled);
		if (!list.length) { ctx.ui.notify("No skills in this library.", "info"); continue; }
		const choices = list.map((skill) => `${displayName("skills", skillKey(skill), skill.name)} · ${categoryOf(skill)}`);
		const selected = await ctx.ui.select("Move a skill", [...choices, "Cancel"]);
		if (!selected || selected === "Cancel") continue;
		const skill = list[choices.indexOf(selected)]; if (!skill) continue;
		const categories = skillCategories();
		const destination = await ctx.ui.select("Move to category", ["Library root (Uncategorized)", ...categories, "Create new category…", "Cancel"]);
		if (!destination || destination === "Cancel") continue;
		let category = destination === "Library root (Uncategorized)" ? "" : destination;
		if (destination === "Create new category…") { const value = await ctx.ui.input("New shared category", ""); category = value ? validCategory(value) || "" : ""; if (!category) { ctx.ui.notify("Enter a relative folder name without . or ...", "warning"); continue; } mkdirSync(join(SKILLS_DIR, category), { recursive: true }); mkdirSync(join(DISABLED_SKILLS_DIR, category), { recursive: true }); }
		try { moveSkill(skill, skillRoot(skill), category ? join(category, basename(skill.path)) : basename(skill.path)); ctx.ui.notify("Skill moved. Run /reload before relying on a changed active skill path.", "info"); }
		catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Could not move skill.", "error"); }
	}
}

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

function viewerHtml(title: string, source: string): string {
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<&]/g, "")}</title><style>body{margin:0;background:#1a1b26;color:#c0caf5;font:16px system-ui,sans-serif}header{padding:14px 20px;border-bottom:1px solid #414868;font-weight:600}main{padding:24px;overflow:auto;min-height:calc(100vh - 68px)}.mermaid{background:#24283b;border:1px solid #414868;border-radius:10px;padding:24px;display:inline-block;min-width:calc(100% - 50px);white-space:pre-wrap}.error{color:#f7768e;white-space:pre-wrap;margin-bottom:16px}</style><header>${title.replace(/[<&]/g, "")}</header><main><div class="error" hidden></div><pre class="mermaid"></pre></main><script type="module">const source=${JSON.stringify(source)};const target=document.querySelector('.mermaid');const errorBox=document.querySelector('.error');target.textContent=source;async function loadMermaid(){let lastError;for(const url of ['https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs','https://unpkg.com/mermaid@11/dist/mermaid.esm.min.mjs']){try{return (await import(url)).default}catch(error){lastError=error}}throw lastError}try{const mermaid=await loadMermaid();mermaid.initialize({startOnLoad:false,theme:'dark'});await mermaid.run({nodes:[target]})}catch(error){errorBox.hidden=false;errorBox.textContent='Mermaid renderer could not be loaded. Showing source instead.\\n'+error}</script></html>`;
}

async function openMermaidViewer(root: string, diagram: Diagram): Promise<string | undefined> {
	const source = registeredMermaidSource(root, diagram);
	if (!source) return undefined;
	if (!mermaidViewer) {
		const server = createServer((request, response) => {
			if (!mermaidViewer || request.url !== "/") { response.writeHead(404).end(); return; }
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			response.end(viewerHtml(mermaidViewer.title, mermaidViewer.source));
		});
		await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); }); });
		const address = server.address();
		if (!address || typeof address === "string") { server.close(); return undefined; }
		mermaidViewer = { server, source, title: diagram.title, url: `http://127.0.0.1:${address.port}/` };
	} else { mermaidViewer.source = source; mermaidViewer.title = diagram.title; }
	spawn("cmd.exe", ["/c", "start", "", mermaidViewer.url], { detached: true, stdio: "ignore" }).unref();
	return mermaidViewer.url;
}

function driveRoots(): string[] {
	const roots: string[] = [];
	for (let code = 67; code <= 90; code++) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (existsSync(root)) roots.push(root);
	}
	return roots;
}

class WorkspaceDrawer implements Focusable {
	readonly width = 52;
	focused = false;
	private view: View = "home";
	private selected = 0;
	private files: FileItem[] | undefined;
	private browserPath: string | undefined;
	private browserEntries: FileItem[] = [];
	private pricing: Pricing | undefined;
	private pricingLoading = false;
	private diagramItems: Diagram[] | undefined;
	private skillItems: Skill[] | undefined;
	private skillEntryItems: SkillEntry[] = [];
	private skillDirectory = "";
	private skillEnabled = true;
	private selectedSkill: Skill | undefined;
	private mcpItems: McpServer[] | undefined;
	private selectedMcp: McpServer | undefined;

	constructor(private readonly ctx: ExtensionCommandContext, private readonly workspace: Workspace, private readonly workspaces: Workspace[], private readonly theme: Theme, private readonly done: (result: Result) => void, private readonly tui: { requestRender(): void }) {}

	private open(view: View): void {
		this.view = view;
		this.selected = 0;
		if (view === "files" && !this.files) this.files = entries(this.workspace.path);
		if (view === "browser") this.openBrowser(this.browserPath);
		if (view === "usage") void this.loadPricing();
		if (view === "diagrams") this.diagramItems = diagrams(this.workspace.path);
		if (view === "skills") this.skillItems = skills();
		if (view === "skill-list") this.skillEntryItems = skillEntries(this.skillEnabled, this.skillDirectory);
		if (view === "mcp") this.mcpItems = cachedMcpServers();
	}

	private async loadPricing(): Promise<void> {
		if (this.pricing || this.pricingLoading) return;
		this.pricingLoading = true;
		try {
			const config = JSON.parse(readFileSync(MODELS_FILE, "utf8")).providers?.["litellm-openai"] as { baseUrl?: string; apiKey?: string } | undefined;
			if (!config?.baseUrl || !config.apiKey || !this.ctx.model?.id) return;
			const response = await fetch(`${config.baseUrl.replace(/\/v1\/?$/, "")}/model/info`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(5_000) });
			if (!response.ok) return;
			const data = await response.json() as { data?: Array<{ model_name?: string; model_info?: { input_cost_per_token?: number; output_cost_per_token?: number; cache_read_input_token_cost?: number } }> };
			const info = data.data?.find((item) => item.model_name === this.ctx.model?.id)?.model_info;
			if (info?.input_cost_per_token !== undefined && info.output_cost_per_token !== undefined) this.pricing = { input: info.input_cost_per_token, output: info.output_cost_per_token, cacheRead: info.cache_read_input_token_cost };
		} catch { /* Usage remains available without price data. */ }
		finally { this.pricingLoading = false; this.tui.requestRender(); }
	}

	private openBrowser(path: string | undefined): void {
		this.browserPath = path;
		this.selected = 0;
		this.browserEntries = path ? entries(path, true) : driveRoots().map((root) => ({ name: root, directory: true }));
	}

	private backBrowser(): void {
		if (!this.browserPath) { this.open("projects"); return; }
		const parent = dirname(this.browserPath);
		this.openBrowser(parent === this.browserPath ? undefined : parent);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.view === "home") this.done({ type: "close" });
			else if (this.view === "browser") this.backBrowser();
			else if (this.view === "skill-list") { if (this.skillDirectory) { this.skillDirectory = dirname(this.skillDirectory); if (this.skillDirectory === ".") this.skillDirectory = ""; this.open("skill-list"); } else this.open("skills"); }
			else if (this.view === "skill-detail") this.open("skill-list");
			else if (this.view === "skill-confirm") this.open("skill-detail");
			else if (this.view === "mcp-detail") this.open("mcp");
			else { this.view = "home"; this.selected = 0; }
			return;
		}
		if (matchesKey(data, "p")) { this.open("projects"); return; }
		if (matchesKey(data, "f")) { this.open("files"); return; }
		if (matchesKey(data, "b")) { this.open("browser"); return; }
		if (matchesKey(data, "c")) { this.open("usage"); return; }
		if (matchesKey(data, "d")) { this.open("diagrams"); return; }
		if (matchesKey(data, "l")) { this.open("skills"); return; }
		if (matchesKey(data, "m")) { this.open("mcp"); return; }
		if (matchesKey(data, "n") && this.view === "mcp-detail" && this.selectedMcp) { this.done({ type: "edit-label", kind: "mcp", key: this.selectedMcp.name, fallback: this.selectedMcp.name, field: "displayName" }); return; }
		if (matchesKey(data, "o") && this.view === "mcp-detail" && this.selectedMcp) { this.done({ type: "edit-label", kind: "mcp", key: this.selectedMcp.name, fallback: this.selectedMcp.name, field: "note" }); return; }
		if (matchesKey(data, "s") && this.view === "browser" && this.browserPath) { this.setCurrentDirectory(); return; }
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) { this.selected = Math.max(0, this.selected - 1); return; }
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			const last = this.view === "projects" ? this.workspaces.length : this.view === "files" ? Math.max(0, (this.files?.length || 1) - 1) : this.view === "browser" ? Math.max(0, this.browserEntries.length - 1) : this.view === "diagrams" ? Math.max(0, (this.diagramItems?.length || 1) - 1) : this.view === "skills" ? 1 : this.view === "skill-list" ? this.skillEntryItems.length + (this.skillDirectory ? 1 : 0) : this.view === "skill-detail" ? (this.selectedSkill?.enabled ? 3 : 2) : this.view === "mcp" ? Math.max(0, (this.mcpItems?.length || 1) - 1) : this.view === "mcp-detail" ? Math.max(0, (this.selectedMcp?.tools.length || 1) - 1) : this.view === "usage" ? 0 : 7;
			this.selected = Math.min(last, this.selected + 1);
			return;
		}
		if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.right)) return;
		if (this.view === "home") {
			if (this.selected === 5) { this.done({ type: "sessions" }); return; }
			this.open(["projects", "files", "browser", "usage", "diagrams", "sessions", "skills", "mcp"][this.selected] as View);
			return;
		}
		if (this.view === "skills") { this.skillEnabled = this.selected === 0; this.skillDirectory = ""; this.open("skill-list"); return; }
		if (this.view === "skill-list") { const entry = this.skillEntryItems[this.selected]; if (entry?.type === "skill") { this.selectedSkill = entry.skill; this.open("skill-detail"); } else if (entry?.type === "folder") { this.skillDirectory = entry.relative; this.open("skill-list"); } else if (this.skillDirectory && this.selected === this.skillEntryItems.length) this.done({ type: "toggle-skill-folder", enabled: this.skillEnabled, relative: this.skillDirectory }); else this.done({ type: "organize-skills" }); return; }
		if (this.view === "skill-detail") {
			if (!this.selectedSkill) return;
			const offset = this.selectedSkill.enabled ? 1 : 0;
			if (this.selectedSkill.enabled && this.selected === 0) this.done({ type: "use-skill", canonicalName: this.selectedSkill.name });
			else if (this.selected === offset) this.done({ type: "edit-label", kind: "skills", key: skillKey(this.selectedSkill), fallback: this.selectedSkill.name, field: "displayName" });
			else if (this.selected === offset + 1) this.done({ type: "edit-label", kind: "skills", key: skillKey(this.selectedSkill), fallback: this.selectedSkill.name, field: "note" });
			else this.open("skill-confirm");
			return;
		}
		if (this.view === "skill-confirm") { if (!this.selectedSkill) return; try { this.selectedSkill = moveSkill(this.selectedSkill, this.selectedSkill.enabled ? DISABLED_SKILLS_DIR : SKILLS_DIR, skillKey(this.selectedSkill)); this.skillEnabled = this.selectedSkill.enabled; this.skillDirectory = dirname(skillKey(this.selectedSkill)); if (this.skillDirectory === ".") this.skillDirectory = ""; this.open("skill-list"); } catch { /* Keep UI responsive; inability to move is visible on the unchanged list. */ } return; }
		if (this.view === "mcp") { const server = this.mcpItems?.[this.selected]; if (server) { this.selectedMcp = server; this.open("mcp-detail"); } return; }
		if (this.view === "mcp-detail") return;
		if (this.view === "files" || this.view === "usage") return;
		if (this.view === "diagrams") { const diagram = this.diagramItems?.[this.selected]; if (diagram) this.done({ type: "view-diagram", diagram }); return; }
		if (this.view === "projects") {
			if (this.selected === this.workspaces.length) { this.open("browser"); return; }
			const next = this.workspaces[this.selected];
			if (next) this.done({ type: "workspace", workspace: next });
			return;
		}
		if (this.view === "browser") {
			const next = this.browserEntries[this.selected];
			if (next) this.openBrowser(this.browserPath ? join(this.browserPath, next.name) : next.name);
		}
	}

	private setCurrentDirectory(): void {
		if (this.browserPath) this.done({ type: "workspace", workspace: { name: basename(parse(this.browserPath).root === this.browserPath ? this.browserPath : this.browserPath) || this.browserPath, path: this.browserPath } });
	}

	render(_width: number): string[] {
		const th = this.theme;
		const inner = this.width - 2;
		const row = (text: string) => th.fg("border", "│") + truncateToWidth(text, inner) + " ".repeat(Math.max(0, inner - visibleWidth(text))) + th.fg("border", "│");
		const marker = (index: number) => index === this.selected ? th.fg("accent", "›") : " ";
		const title = this.view === "home" ? "Terra Workspace" : this.view === "projects" ? "Projects" : this.view === "files" ? "Files" : this.view === "usage" ? "Usage & Cost" : this.view === "diagrams" ? "Diagram Gallery" : this.view === "skills" ? "Skill Library" : this.view === "skill-list" ? (this.skillEnabled ? "Enabled Skills" : "Disabled Skills") : this.view === "skill-detail" ? "Skill Details" : this.view === "skill-confirm" ? "Confirm Skill Change" : this.view === "mcp" ? "MCP Servers" : this.view === "mcp-detail" ? "MCP Server Details" : "Browse computer";
		const lines = [th.fg("borderAccent", `╭─ ${title} ${"─".repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`)];
		if (this.view === "home") {
			lines.push(row(` ${th.fg("accent", "◈")} ${th.bold(this.workspace.name)}`));
			lines.push(row(` ${th.fg("dim", this.workspace.path)}`));
			lines.push(row(""));
			for (const [i, label] of ["📁 Projects", "📄 Files", "🖥️  Browse computer…", "💰 Usage & Cost", "🗺️  Diagram Gallery", "🕘 Session Library", "✨ Skill Library", "🔌 MCP Servers"].entries()) lines.push(row(` ${marker(i)} ${th.fg("text", label)}`));
			lines.push(row(""));
			lines.push(row(th.fg("dim", "↑ ↓ select · Enter / → open · Esc / ← close")));
		} else if (this.view === "projects") {
			lines.push(row(th.fg("muted", "Saved project roots for this Session")));
			lines.push(row(""));
			for (let i = 0; i < this.workspaces.length; i++) { const item = this.workspaces[i]!; lines.push(row(` ${marker(i)} ${th.fg(i === this.selected ? "text" : "muted", item.name)}`)); lines.push(row(`   ${th.fg("dim", item.path)}`)); }
			lines.push(row(` ${marker(this.workspaces.length)} ${th.fg("accent", "Browse computer…")}`));
			lines.push(row("")); lines.push(row(th.fg("dim", "Enter / → apply · Esc / ← back")));
		} else if (this.view === "files") {
			lines.push(row(th.fg("muted", "Current Workspace root · read-only"))); lines.push(row("")); this.renderItems(lines, row, marker, this.files || []); lines.push(row("")); lines.push(row(th.fg("dim", "Esc / ← back")));
		} else if (this.view === "usage") {
			const totals = sessionUsage(this.ctx), context = this.ctx.getContextUsage();
			const estimated = this.pricing ? totals.input * this.pricing.input + totals.output * this.pricing.output + totals.cacheRead * (this.pricing.cacheRead ?? this.pricing.input) : undefined;
			lines.push(row(th.fg("muted", "Current Session · local LiteLLM price estimate"))); lines.push(row(""));
			for (const value of [`Model       ${this.ctx.model?.id || "unknown"}`, `Input       ${formatTokens(totals.input)} tokens`, `Output      ${formatTokens(totals.output)} tokens`, `Cache read  ${formatTokens(totals.cacheRead)} tokens`, `Context     ${context?.tokens ?? "—"} / ${context?.contextWindow ?? "—"}`]) lines.push(row(value));
			lines.push(row("")); lines.push(row(`${th.fg("accent", "Estimated")}   ${estimated === undefined ? this.pricingLoading ? "loading local prices…" : "price unavailable" : `$${estimated.toFixed(4)}`}`)); lines.push(row(th.fg("dim", "Estimate only; not a provider invoice. Esc / ← back")));
		} else if (this.view === "diagrams") {
			const gallery = this.diagramItems || [];
			lines.push(row(th.fg("muted", "Mermaid diagrams explicitly generated and registered by Pi"))); lines.push(row(""));
			if (gallery.length) {
				const start = Math.floor(this.selected / DIAGRAM_PAGE_SIZE) * DIAGRAM_PAGE_SIZE;
				for (let i = start; i < Math.min(start + DIAGRAM_PAGE_SIZE, gallery.length); i++) { const diagram = gallery[i]!; lines.push(row(` ${marker(i)} ${th.fg(i === this.selected ? "accent" : "text", diagram.title)}`)); lines.push(row(`   ${th.fg("dim", `${diagram.type || "mermaid"}${diagram.createdAt ? ` · ${diagram.createdAt}` : ""}`)}`)); }
				if (gallery.length > DIAGRAM_PAGE_SIZE) lines.push(row(th.fg("dim", `Page ${Math.floor(start / DIAGRAM_PAGE_SIZE) + 1} / ${Math.ceil(gallery.length / DIAGRAM_PAGE_SIZE)} · ↑ ↓ to browse`)));
				lines.push(row("")); lines.push(row(th.fg("dim", "Enter / → open in browser · Esc / ← back")));
			} else { lines.push(row(th.fg("dim", "No Mermaid diagrams yet."))); lines.push(row(th.fg("dim", "Ask Pi to generate a Mermaid diagram; it will appear here."))); lines.push(row("")); lines.push(row(th.fg("dim", "Esc / ← back"))); }
		} else if (this.view === "skills") {
			const activeCount = (this.skillItems || []).filter((skill) => skill.enabled).length, disabledCount = (this.skillItems || []).length - activeCount;
			lines.push(row(th.fg("muted", "Choose a library · disabled skills stay outside Pi discovery"))); lines.push(row(""));
			lines.push(row(` ${marker(0)} ${th.fg("accent", `✨ Enabled skills · ${activeCount}`)}`));
			lines.push(row(` ${marker(1)} ${th.fg("muted", `💤 Disabled skills · ${disabledCount}`)}`));
			lines.push(row("")); lines.push(row(th.fg("dim", "Enter / → open · Esc / ← back")));
		} else if (this.view === "skill-list") {
			const list = this.skillEntryItems, location = this.skillDirectory || "Library root";
			lines.push(row(th.fg("muted", `${this.skillEnabled ? "Enabled" : "Disabled"} · 📂 ${location}`))); lines.push(row(""));
			if (!list.length) lines.push(row(th.fg("dim", "This folder is empty.")));
			else for (let i = 0; i < list.length; i++) { const entry = list[i]!; if (entry.type === "folder") { const color = categoryColor(entry.relative), count = skillCount(join(this.skillEnabled ? SKILLS_DIR : DISABLED_SKILLS_DIR, entry.relative)); lines.push(row(` ${marker(i)} ${th.fg(color, `📂 ${entry.name}`)} ${th.fg("dim", `· ${count} skill${count === 1 ? "" : "s"}`)}`)); } else { const skill = entry.skill, category = categoryOf(skill), custom = displayName("skills", skillKey(skill), skill.name); lines.push(row(` ${marker(i)} ${th.fg(categoryColor(category), `${this.skillEnabled ? "✨" : "💤"} ${custom}`)}`)); lines.push(row(`   ${th.fg("dim", labelsFor("skills", skillKey(skill)).note || skill.description)}`)); } }
			const actionIndex = list.length;
			if (this.skillDirectory) lines.push(row(` ${marker(actionIndex)} ${th.fg("warning", `${this.skillEnabled ? "💤 Disable" : "✨ Enable"} this folder`)}`));
			lines.push(row(` ${marker(actionIndex + (this.skillDirectory ? 1 : 0))} ${th.fg("accent", "📂 Organize folders…")}`)); lines.push(row("")); lines.push(row(th.fg("dim", "Enter / → open/action · Esc / ← up")));
		} else if (this.view === "skill-detail") {
			const skill = this.selectedSkill;
			if (skill) { const labels = labelsFor("skills", skillKey(skill)), category = categoryOf(skill), color = categoryColor(category); lines.push(row(`${th.fg(color, skill.enabled ? "✨ Enabled" : "💤 Disabled")} · ${th.fg(color, displayName("skills", skillKey(skill), skill.name))}`)); lines.push(row(th.fg(color, `📂 ${category}`))); lines.push(row("")); if (labels.note) { lines.push(row(th.fg("muted", labels.note))); lines.push(row("")); } lines.push(row(th.fg("dim", `Original: ${skill.name}`))); lines.push(row(th.fg("dim", skill.description))); lines.push(row("")); const actions = skill.enabled ? ["Use this skill now", "Edit display name", "Edit personal note", "Disable this skill"] : ["Edit display name", "Edit personal note", "Enable this skill"]; for (const [i, action] of actions.entries()) lines.push(row(` ${marker(i)} ${th.fg(i === this.selected ? "accent" : "text", action)}`)); }
			lines.push(row("")); lines.push(row(th.fg("dim", "↑ ↓ select · Enter / → confirm · Esc / ← back")));
		} else if (this.view === "skill-confirm") {
			const skill = this.selectedSkill;
			if (skill) { const action = skill.enabled ? "Disable" : "Enable"; lines.push(row(th.fg("accent", `⚠️  ${action} ${skill.name}?`))); lines.push(row("")); lines.push(row(th.fg("muted", skill.enabled ? "It will move to disabled-skills; nothing is deleted." : "It will move back to the active skills directory."))); lines.push(row(th.fg("muted", "Pi will apply the change after /reload."))); lines.push(row("")); lines.push(row(th.fg("accent", "Enter / → confirm · Esc / ← cancel"))); }
		} else if (this.view === "mcp") {
			const list = this.mcpItems || [];
			lines.push(row(th.fg("muted", "🔌 Managed by the MCP plugin · cached discovered tools"))); lines.push(row(""));
			if (!list.length) lines.push(row(th.fg("dim", "No cached MCP servers. Use the MCP plugin to discover them.")));
			else for (let i = 0; i < list.length; i++) { const server = list[i]!; const labels = labelsFor("mcp", server.name); lines.push(row(` ${marker(i)} ${th.fg(i === this.selected ? "accent" : "text", `🔌 ${displayName("mcp", server.name, server.name)}`)}`)); lines.push(row(`   ${th.fg("dim", labels.note || `${server.tools.length} cached tool${server.tools.length === 1 ? "" : "s"}`)}`)); }
			lines.push(row("")); lines.push(row(th.fg("dim", "Enter / → tools · Esc / ← back")));
		} else if (this.view === "mcp-detail") {
			const server = this.selectedMcp;
			if (server) { const labels = labelsFor("mcp", server.name); lines.push(row(th.fg("accent", `🔌 ${displayName("mcp", server.name, server.name)}`))); if (labels.note) lines.push(row(th.fg("muted", labels.note))); lines.push(row(th.fg("dim", `Original: ${server.name}`))); lines.push(row(th.fg("muted", `${server.tools.length} cached tool${server.tools.length === 1 ? "" : "s"} · secrets are never shown`))); lines.push(row("")); if (server.tools.length) { const start = Math.floor(this.selected / LIST_PAGE_SIZE) * LIST_PAGE_SIZE; for (let i = start; i < Math.min(start + LIST_PAGE_SIZE, server.tools.length); i++) { const tool = server.tools[i]!; lines.push(row(` ${marker(i)} ${th.fg("text", tool.name)}`)); if (tool.description) lines.push(row(`   ${th.fg("dim", tool.description)}`)); } } else lines.push(row(th.fg("dim", "No cached tools."))); lines.push(row("")); lines.push(row(th.fg("dim", "N edit display name · O edit personal note"))); }
			lines.push(row(th.fg("dim", "Read-only plugin cache · Esc / ← back")));
		} else {
			lines.push(row(th.fg("muted", this.browserPath || "Choose a drive"))); if (this.browserPath) lines.push(row(` ${th.fg("accent", "S")} set this folder as Workspace`)); lines.push(row("")); this.renderItems(lines, row, marker, this.browserEntries); lines.push(row("")); lines.push(row(th.fg("dim", this.browserPath ? "Enter / → folder · S select · Esc / ← up" : "Enter / → drive · Esc / ← back")));
		}
		lines.push(th.fg("borderAccent", `╰${"─".repeat(inner)}╯`)); return lines;
	}

	private renderItems(lines: string[], row: (text: string) => string, marker: (index: number) => string, values: FileItem[]): void {
		if (!values.length) { lines.push(row(this.theme.fg("dim", " No readable folders here."))); return; }
		const start = Math.floor(this.selected / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
		const end = Math.min(start + LIST_PAGE_SIZE, values.length);
		for (let i = start; i < end; i++) { const item = values[i]!; lines.push(row(` ${marker(i)} ${this.theme.fg(i === this.selected ? "text" : "muted", `${item.name}${item.directory && !item.name.endsWith("\\") ? "/" : ""}`)}`)); }
		if (values.length > LIST_PAGE_SIZE) lines.push(row(this.theme.fg("dim", `Page ${Math.floor(start / LIST_PAGE_SIZE) + 1} / ${Math.ceil(values.length / LIST_PAGE_SIZE)} · ↑ ↓ to browse`)));
	}

	invalidate(): void {}
}

export default function workspaceDrawer(pi: ExtensionAPI) {
	let workspace: Workspace | undefined;
	const active = (ctx: ExtensionContext): Workspace => workspace || restoredWorkspace(ctx.sessionManager.getBranch(), ctx.cwd);
	const restore = (ctx: ExtensionContext) => { workspace = restoredWorkspace(ctx.sessionManager.getBranch(), ctx.cwd); };
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", async (event, ctx) => {
		const root = active(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\nActive Workspace: ${root.path}\nInterpret relative file paths, project files, and project commands as referring to this workspace by default. Use paths under it for native file tools and run project shell commands from it. An explicit user-provided absolute path overrides this default.\n\nDiagram Gallery contract: Do not create or register diagrams unless the user explicitly asks you to generate a diagram, chart, architecture view, flowchart, or node graph. For such a request, create Mermaid flowchart/graph source under <Active Workspace>/.pi/diagrams/<stable-id>.mmd and create or update <Active Workspace>/.pi/diagrams/gallery.json in this exact shape: {"diagrams":[{"id":"stable-id","title":"Human title","file":"stable-id.mmd","type":"mermaid","createdAt":"ISO-8601 timestamp","summary":"short description"}]}. The TUI Gallery only displays manifest entries and previews .mmd Mermaid sources; never infer or auto-register existing files.\n` };
	});
	const open = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") return;
		const current = active(ctx);
		const result = await ctx.ui.custom<Result>((tui, theme, _keybindings, done) => new WorkspaceDrawer(ctx, current, configuredWorkspaces(ctx.cwd), theme, done, tui), {
			overlay: true,
			overlayOptions: { anchor: "right-center", width: 54, maxHeight: "100%", margin: { top: 1, right: 1, bottom: 1 } },
		});
		if (result?.type === "workspace") { workspace = result.workspace; pi.appendEntry(STATE_TYPE, workspace); ctx.ui.notify(`Workspace: ${workspace.name}`, "info"); }
		else if (result?.type === "sessions") await openSessionLibrary(pi, ctx);
		else if (result?.type === "organize-skills") { await organizeSkillFolders(ctx); await open(ctx); }
		else if (result?.type === "use-skill") { ctx.ui.setEditorText(`/skill:${result.canonicalName} `); ctx.ui.notify("Skill command is ready in the editor. Add details, then submit.", "info"); }
		else if (result?.type === "toggle-skill-folder") {
			const action = result.enabled ? "Disable" : "Enable";
			const approved = await ctx.ui.confirm(`${action} skill folder?`, `${action} every skill in “${result.relative}”? Nothing is deleted; the complete skill folders move to the other library.`);
			if (approved) { try { const count = moveSkillFolder(result.enabled, result.relative); ctx.ui.notify(`${action}d ${count} skill${count === 1 ? "" : "s"}. Run /reload to apply discovery changes.`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Could not move skill folder.", "error"); } }
			await open(ctx);
		}
		else if (result?.type === "edit-label") {
			const current = labelsFor(result.kind, result.key)[result.field] || "";
			const next = result.field === "displayName" ? await ctx.ui.input(`Personal ${result.kind === "mcp" ? "MCP" : "skill"} display name`, current || result.fallback) : await ctx.ui.editor(`Personal note for ${result.fallback}`, current);
			if (next !== undefined) { const data = resourceMetadata(); const collection = data[result.kind] || {}; const labels = { ...collection[result.key], [result.field]: next.trim() }; if (!labels.displayName && !labels.note) delete collection[result.key]; else collection[result.key] = labels; data[result.kind] = collection; saveResourceMetadata(data); ctx.ui.notify("Personal label saved. It is not sent to the model.", "info"); }
		}
		else if (result?.type === "view-diagram") {
			const url = await openMermaidViewer(current.path, result.diagram);
			ctx.ui.notify(url ? `Opened Mermaid Viewer: ${result.diagram.title}` : "This entry does not have a readable registered .mmd Mermaid source.", url ? "info" : "error");
		}

	};
	pi.registerCommand("workspace", { description: "Open Terra Workspace Drawer", handler: async (_args, ctx) => await open(ctx) });
	pi.registerShortcut(Key.alt("w"), { description: "Open Terra Workspace Drawer", handler: async (ctx) => await open(ctx as ExtensionCommandContext) });
}
