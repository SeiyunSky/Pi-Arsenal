import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openSessionLibrary } from "../lib/session-library.ts";

export default function sessionManagerExtension(pi: ExtensionAPI) {
	pi.registerCommand("sessions", {
		description: "Manage Pi sessions: inspect, rename, describe, reload, or delete",
		handler: async (_args, ctx) => await openSessionLibrary(pi, ctx),
	});
}
