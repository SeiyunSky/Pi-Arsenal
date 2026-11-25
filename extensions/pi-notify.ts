import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Toast via WinRT ──────────────────────────────────────────────────────────
// Uses Windows.UI.Notifications WinRT API (available on Windows 10/11).
// Falls back to a simple `msg %USERNAME%` if WinRT fails.

const APP_ID = "Pi Arsenal";

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sendToast(title: string, body: string, urgency: "info" | "warning" | "error"): Promise<void> {
	const scenario = urgency === "error" ? "urgent" : urgency === "warning" ? "reminder" : "default";
	// WinRT XML template
	const xml = `<toast scenario="${scenario}"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`;
	const ps = `
$xml = '${xml.replace(/'/g, "''")}';
$dom = New-Object Windows.Data.Xml.Dom.XmlDocument;
$dom.LoadXml($xml);
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null;
$toast = [Windows.UI.Notifications.ToastNotification]::new($dom);
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID.replace(/'/g, "''")}');
$notifier.Show($toast);
`;
	return new Promise((resolve) => {
		const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
		proc.on("close", (code) => {
			if (code !== 0) sendFallback(title, body).then(resolve);
			else resolve();
		});
		proc.on("error", () => sendFallback(title, body).then(resolve));
	});
}

function sendFallback(title: string, body: string): Promise<void> {
	// msg.exe: works on all Windows versions, shows a dialog to the current user session.
	return new Promise((resolve) => {
		const text = `${title}\n\n${body}`;
		const proc = spawn("msg.exe", ["%USERNAME%", text], { stdio: "ignore" });
		proc.on("close", () => resolve());
		proc.on("error", () => resolve());  // silent fail — notification is best-effort
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
			await sendToast(title.slice(0, 128), body.slice(0, 256), urgency);
			return { content: [{ type: "text" as const, text: `Notification sent: "${title}"` }] };
		},
	});
}
