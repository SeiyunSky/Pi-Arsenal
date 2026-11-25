import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Platform dispatch ────────────────────────────────────────────────────────

function sendNotification(title: string, body: string, urgency: "info" | "warning" | "error"): Promise<void> {
	switch (process.platform) {
		case "win32":  return sendWindows(title, body, urgency);
		case "darwin": return sendMac(title, body);
		default:       return sendLinux(title, body, urgency);
	}
}

// ─── Windows — NotifyIcon balloon (System.Windows.Forms) ─────────────────────
// WinRT ToastNotificationManager requires a registered AppUserModelID;
// NotifyIcon works without registration and is available on all Windows versions.

function sendWindows(title: string, body: string, _urgency: "info" | "warning" | "error"): Promise<void> {
	const ps = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(6000, '${esc(title)}', '${esc(body)}', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 4
$n.Dispose()
`;
	return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
}

// ─── macOS — osascript (zero dependencies) ───────────────────────────────────

function sendMac(title: string, body: string): Promise<void> {
	const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
	return run("osascript", ["-e", script]);
}

// ─── Linux — notify-send ─────────────────────────────────────────────────────

function sendLinux(title: string, body: string, urgency: "info" | "warning" | "error"): Promise<void> {
	const level = urgency === "error" ? "critical" : urgency === "warning" ? "normal" : "low";
	return run("notify-send", ["-u", level, "-t", "6000", title, body]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape single quotes for embedding in PS / AppleScript strings. */
function esc(s: string): string {
	return s.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { stdio: "ignore" });
		proc.on("close", () => resolve());
		proc.on("error", () => resolve()); // best-effort — never throw
	});
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function piNotify(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi_notify",
		description:
			"Send a desktop notification to the user via the Windows notification system. " +
			"Use this after completing a long-running task (build, install, test run, file generation) " +
			"so the user is informed even if they stepped away. " +
			"Keep title short (≤ 48 chars) and body concise (≤ 120 chars). " +
			"Do NOT use for every message — only for genuinely async completions or important alerts.",
		parameters: Type.Object({
			title: Type.String({ description: "Short notification title, e.g. 'Build complete' or 'Tests failed'." }),
			body: Type.String({ description: "One or two sentence summary of what happened and what to do next." }),
			urgency: Type.Union(
				[Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")],
				{ description: "info = task done normally; warning = completed with issues; error = failed." }
			),
		}),
		async execute(_id, input, _signal, _onUpdate, _ctx) {
			const { title, body, urgency } = input as { title: string; body: string; urgency: "info" | "warning" | "error" };
			await sendNotification(title.slice(0, 128), body.slice(0, 256), urgency);
			return { content: [{ type: "text" as const, text: `Notification sent: "${title}"` }] };
		},
	});
}
