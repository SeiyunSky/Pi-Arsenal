import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function splash(theme: Theme, width: number): string[] {
	const red = (text: string) => theme.fg("error", text);
	const hot = (text: string) => theme.bold(theme.fg("error", text));
	const shade = (text: string) => theme.fg("dim", text);
	const ink = (text: string) => theme.fg("border", text);
	const light = (text: string) => theme.fg("text", text);
	const art = [
		`${shade("╲")}       ${red("╱")}  ${shade("·")}       ${red("╲")}`,
		`${shade("  ╲")}   ${red("╱╲╲")}     ${hot("╱╲")}    ${shade("╱")}`,
		`     ${red("╱████╲")} ${hot("╱█████╲")}  ${red("╲")}`,
		`    ${red("╱██╲████████████╲")} ${shade("╲")}`,
		`   ${red("╱███╲██████████╲███╲")}`,
		`  ${red("╱██████████████╲████╲")}`,
		` ${red("╱██╲████")} ${ink("╲")} ${red("███████╲")} ${shade("╲████╲")}`,
		` ${red("╲███╲")} ${light("◢")} ${ink("▔▔")} ${light("◣")} ${red("╲█████╲")} ${shade("╲███╲")}`,
		`  ${red("╲███╲")} ${light("◥")} ${ink("▁▁")} ${red("╲██████╲")} ${shade("╲███│")}`,
		`   ${red("╲████╲")} ${ink("╲____")} ${red("╲██████╲")} ${shade("│██│")}`,
		`    ${red("╲█████╲____╲██████╲")} ${shade("│██│")}`,
		`     ${shade("╲")} ${red("╲██████╲")} ${hot("╲█████╲")} ${shade("╲██│")}`,
		`      ${shade("╲")} ${red("╲██████╲")} ${hot("╲████╲")} ${shade("╲█│")}`,
		`       ${red("╲██████╲")} ${shade("╲████╲")}`,
		`        ${red("╲████╱")} ${shade("╲████╱")}`,
		`         ${shade("╲╱")}  ${red("╲╱")}  ${shade("╲╱")}`,
	];
	const title = `${hot("◆")}${light("  ID: 沫路")} ${shade("// RED SIGNAL")}`;
	const maxArt = Math.max(...art.map(visibleWidth), visibleWidth(title));
	if (width < 44) return [truncateToWidth(`${hot("◆")} ${light("ID: 沫路")} ${shade("// RED SIGNAL")}`, width)];
	const pad = Math.max(0, Math.floor((width - Math.min(maxArt, width)) / 2));
	const center = (line: string) => " ".repeat(Math.max(0, pad + Math.floor((maxArt - visibleWidth(line)) / 2))) + line;
	return ["", ...art.map(center), center(title), ""];
}

export default function startupSplash(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] { return splash(theme, width); },
		}));
	});
}
