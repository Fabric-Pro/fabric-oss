/**
 * A2A Protocol Validator
 * Validates that an endpoint speaks the A2A protocol
 */

import { A2AClient } from "./client";
import type { A2AMessage, A2AValidationResult, AgentCard } from "./types";

/**
 * Validate that an endpoint speaks A2A protocol
 */
export async function validateA2AEndpoint(
	baseUrl: string,
	options?: { testSendMessage?: boolean; timeout?: number },
): Promise<A2AValidationResult> {
	const client = new A2AClient({ timeout: options?.timeout || 10000 });
	const errors: string[] = [];
	const capabilities = {
		agentCard: false,
		sendMessage: false,
		streaming: false,
		taskManagement: false,
	};

	let agentCard: AgentCard | undefined;
	let protocolVersion: string | undefined;

	// 1. Try to fetch Agent Card
	try {
		agentCard = await client.getAgentCard(baseUrl);
		capabilities.agentCard = true;
		protocolVersion = agentCard.protocolVersion;

		// Validate protocol version (accept both "0.x" and "0.x.y" semver formats)
		if (!/^0\.\d+(\.\d+)?$/.test(agentCard.protocolVersion)) {
			errors.push(
				`Unsupported protocol version: ${agentCard.protocolVersion}. Expected 0.x or 0.x.y`,
			);
		}

		// Check streaming capability from card
		if (agentCard.capabilities?.streaming) {
			capabilities.streaming = true;
		}
	} catch (error) {
		errors.push(
			`Failed to fetch agent card: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}

	// 2. Optionally test /a2a/send endpoint
	if (options?.testSendMessage && capabilities.agentCard) {
		try {
			const testMessage: A2AMessage = {
				role: "user",
				parts: [{ type: "text", text: "ping" }],
			};

			const task = await client.sendMessage(baseUrl, testMessage, {
				metadata: { _test: true },
			});

			if (task?.id) {
				capabilities.sendMessage = true;

				// Test task retrieval
				try {
					await client.getTask(baseUrl, task.id);
					capabilities.taskManagement = true;
				} catch {
					// Task management not supported
				}
			}
		} catch (error) {
			errors.push(
				`Failed to send test message: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	// Determine overall validity
	const valid = capabilities.agentCard && errors.length === 0;

	return {
		valid,
		protocolVersion,
		agentCard,
		capabilities,
		errors,
	};
}

/**
 * Quick health check for an A2A agent
 */
export async function isA2AHealthy(baseUrl: string): Promise<boolean> {
	const client = new A2AClient({ timeout: 5000 });
	return client.healthCheck(baseUrl);
}

/**
 * Extract agent metadata from Agent Card for registration
 */
export function extractAgentMetadata(card: AgentCard): {
	name: string;
	displayName: string;
	description: string;
	capabilities: string[];
	skills: Array<{ id: string; name: string; description: string }>;
	supportsStreaming: boolean;
} {
	return {
		name: card.name,
		displayName: card.name, // Can be overridden by user
		description: card.description,
		capabilities: [
			...(card.capabilities?.streaming ? ["streaming"] : []),
			...(card.capabilities?.pushNotifications
				? ["push-notifications"]
				: []),
			...(card.capabilities?.stateTransitionHistory
				? ["state-history"]
				: []),
		],
		skills: card.skills.map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description,
		})),
		supportsStreaming: card.capabilities?.streaming || false,
	};
}
