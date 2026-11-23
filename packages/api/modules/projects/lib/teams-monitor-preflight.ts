import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { isMicrosoftAccessDeniedError } from "@repo/integrations/microsoft/connection-errors";
import { classifyProviderError, type ProbeOutcome } from "./monitor-reconnect";

export async function probeTeamsMonitorAccess(
	method: "list_channel_threads" | "list_chat_messages_for_monitor",
	args: Record<string, unknown>,
	userId: string,
	organizationId: string | undefined,
): Promise<ProbeOutcome> {
	try {
		const result = (await executeMicrosoftTeamsTool(
			method,
			{ ...args, top: 1 },
			userId,
			organizationId,
		)) as { error?: string; threads?: unknown; messages?: unknown } | null;

		if (result?.error) {
			return classifyProviderError(result.error);
		}
		const items =
			method === "list_channel_threads"
				? result?.threads
				: result?.messages;
		return Array.isArray(items) ? "reachable" : "indeterminate";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The monitor reads throw on non-OK Graph responses. Only a resource
		// denial is conclusive. Token and service failures leave access unknown.
		if (
			message.startsWith("Microsoft Graph API error: 403 ") &&
			isMicrosoftAccessDeniedError(message)
		) {
			return "unreachable";
		}
		throw error;
	}
}
