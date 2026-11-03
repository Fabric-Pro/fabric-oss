import { z } from "zod";
import { getFabricInternalBaseUrl } from "./shared/fabric-internal-url";

export async function tickParlumeChannelChat(input: {
	sessionId: string;
	organizationId: string;
}): Promise<{ continue: boolean; routingReady: boolean }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume service credential unavailable.");
	}
	const response = await fetch(
		new URL(
			"/api/internal/parlume/channel-chat",
			getFabricInternalBaseUrl(),
		),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(20_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Channel chat lifecycle unavailable (HTTP ${response.status}).`,
		);
	}
	return z
		.object({
			continue: z.boolean(),
			routingReady: z.boolean().default(false),
		})
		.parse(await response.json());
}

export async function deliverParlumeChannelNotificationActivity(input: {
	sessionId: string;
	organizationId: string;
	subscriptionId: string;
	replyId: string;
	hardStopAt: string;
}): Promise<void> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume service credential unavailable.");
	}
	const response = await fetch(
		new URL(
			"/api/internal/parlume/channel-chat/notification",
			getFabricInternalBaseUrl(),
		),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(20_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Channel notification delivery unavailable (HTTP ${response.status}).`,
		);
	}
}
