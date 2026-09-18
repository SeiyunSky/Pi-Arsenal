import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PORTRAIT = [
	"                         .::---::::...",
	"                    .:--=++==-------::::::.         .",
	"               .:-=++*+++++==--:-----:::::::...",
	"          ..:-=+++++++====--::::-::---:::::::...",
	"        .-=++++++==--::::::::::-----:::::::...",
	"      .-+++++==-::::::--::---:::::---::::...",
	"     :=+++=-:::::--=================--:::...",
	"    :+++=-::::-===+++++++====++++++==--::...",
	"   .+++=::::-==+++++++==---==+++++++=-::...",
	"   -++=::::=++++++==--::::--==++++++=-:...",
	"  :++=::::=++++==-::::::--::::-+++++=-:...",
	"  =++-:::=+++=-:::::::=+++=::::=+++=-:...",
	" .+++-::=+++-:::::::-=+++++-:::=++=-:....",
	" .++=::-+++-:::::::--=+++++=-::-++=:....",
	"  ++=::=++=:::::::--=++++++=::=++-:....",
	"  =++-:=++=::::::--=++++++=-:-++=:....",
	"  :++=-+++-:::::--=++++++=-:-++=:....",
	"   =++=+++-::::--=++++++=-:=++-:....",
	"   :++++++-:::--=++++++=-:=++=:....",
	"    -+++++-::--=++++++=-:=++-:....",
	"     =++++=--=++++++=-:=++=:....",
	"      -+++++++=++++=-:=++-:....",
	"       :++++++=++=-:=++=:....",
	"        .-++++++=-:=++-:....",
	"          .-+++=-:=++=:....",
	"             .:::=++-:....",
	"                .-+=:....",
	"                 .:....",
];

function paint(line: string, theme: Theme): string {
	let result = "", buffer = "", mode = "";
	const colorOf = (char: string) => char === " " ? "" : char === "." || char === ":" ? "dim" : char === "*" || char === "+" ? "text" : "error";
	const flush = () => { if (buffer) result += mode ? theme.fg(mode as "dim" | "text" | "error", buffer) : buffer; buffer = ""; };
	for (const char of line) { const next = colorOf(char); if (next !== mode) { flush(); mode = next; } buffer += char; }
	flush(); return result;
}

function splash(theme: Theme, width: number): string[] {
	const label = `${theme.bold(theme.fg("error", "◆"))}${theme.fg("text", "  ID: 沫路")} ${theme.fg("dim", "// PI ARSENAL")}`;
	if (width < 48) return [truncateToWidth(label, width)];
	const artWidth = Math.max(...PORTRAIT.map(visibleWidth), visibleWidth(label));
	const center = (line: string) => " ".repeat(Math.max(0, Math.floor((width - artWidth) / 2) + Math.floor((artWidth - visibleWidth(line)) / 2))) + line;
	return ["", ...PORTRAIT.map((line) => center(paint(line, theme))), center(label), ""];
}

export default function startupSplash(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({ invalidate() {}, render(width: number): string[] { return splash(theme, width); } }));
	});
}
