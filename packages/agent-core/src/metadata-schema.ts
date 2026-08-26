/**
 * Agent Metadata Validation Schemas
 *
 * Zod schemas for validating agent metadata responses
 */

import { z } from "zod";

/**
 * AG-UI Protocol Version Schema
 */
export const AGUIProtocolVersionSchema = z.enum(["1.0", "1.1", "2.0"]);

/**
 * Agent Capability Schema
 */
export const AgentCapabilitySchema = z.enum([
	"predictive-state-updates",
	"human-in-the-loop",
	"tool-calling",
	"generative-ui",
	"streaming",
	"multi-turn-conversation",
	"context-awareness",
	"error-recovery",
]);

/**
 * Tool Definition Schema (simplified)
 */
export const ToolDefinitionSchema = z.object({
	type: z.literal("function"),
	function: z.object({
		name: z.string(),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
	}),
});

/**
 * Agent Endpoints Schema
 */
export const AgentEndpointsSchema = z.object({
	invoke: z.string(),
	stream: z.string(),
	health: z.string(),
	metadata: z.string().optional(),
	threads: z.string().optional(),
	checkpoints: z.string().optional(),
});

/**
 * Agent Metadata Response Schema
 */
export const AgentMetadataResponseSchema = z.object({
	name: z.string().min(1).max(100),
	displayName: z.string().min(1).max(200),
	description: z.string(),
	framework: z.string().min(1),
	language: z.string().min(1),
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	supportsAGUIProtocol: z.boolean(),
	agUIProtocolVersion: AGUIProtocolVersionSchema,
	tools: z.array(ToolDefinitionSchema),
	capabilities: z.array(AgentCapabilitySchema),
	endpoints: AgentEndpointsSchema,
	metadata: z.record(z.string(), z.unknown()).optional(),
	tags: z.array(z.string()).optional(),
	author: z
		.object({
			name: z.string(),
			email: z.string().email().optional(),
			url: z.string().url().optional(),
		})
		.optional(),
	license: z.string().optional(),
	repository: z.string().url().optional(),
	documentation: z.string().url().optional(),
});

/**
 * Agent Discovery Result Schema
 */
export const AgentDiscoveryResultSchema = z.object({
	metadata: AgentMetadataResponseSchema,
	deploymentUrl: z.string().url(),
	healthy: z.boolean(),
	responseTime: z.number().positive(),
	discoveredAt: z.date(),
});

/**
 * Validate agent metadata response
 *
 * @param data - Raw metadata response
 * @returns Validated metadata or throws ZodError
 */
export function validateAgentMetadata(data: unknown) {
	return AgentMetadataResponseSchema.parse(data);
}

/**
 * Safely validate agent metadata response
 *
 * @param data - Raw metadata response
 * @returns Success result with data or error result
 */
export function safeValidateAgentMetadata(data: unknown) {
	return AgentMetadataResponseSchema.safeParse(data);
}

/**
 * Check if agent supports AG-UI protocol
 *
 * @param metadata - Agent metadata
 * @returns True if agent supports AG-UI protocol
 */
export function supportsAGUIProtocol(
	metadata: unknown,
): metadata is { supportsAGUIProtocol: true } {
	const result = AgentMetadataResponseSchema.safeParse(metadata);
	return result.success && result.data.supportsAGUIProtocol === true;
}

/**
 * Check if agent has required endpoints
 *
 * @param metadata - Agent metadata
 * @returns True if agent has all required endpoints
 */
export function hasRequiredEndpoints(metadata: unknown): boolean {
	const result = AgentMetadataResponseSchema.safeParse(metadata);
	if (!result.success) {
		return false;
	}

	const { endpoints } = result.data;
	return !!(endpoints.invoke && endpoints.stream && endpoints.health);
}

/**
 * Check if agent supports specific capability
 *
 * @param metadata - Agent metadata
 * @param capability - Capability to check
 * @returns True if agent supports the capability
 */
export function supportsCapability(
	metadata: unknown,
	capability: z.infer<typeof AgentCapabilitySchema>,
): boolean {
	const result = AgentMetadataResponseSchema.safeParse(metadata);
	if (!result.success) {
		return false;
	}

	return result.data.capabilities.includes(capability);
}
