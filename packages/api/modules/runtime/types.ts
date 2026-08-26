/**
 * Runtime API Types
 *
 * Types for the runtime API used by agents to authenticate and get configurations.
 * This replaces direct database access in agents.
 */

import { z } from "zod";

// ============================================================================
// Tenant Context
// ============================================================================

export const TenantContextSchema = z.object({
	userId: z.string(),
	organizationId: z.string().nullable(),
	apiKeyId: z.string(),
	scopes: z.array(z.string()),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;

// ============================================================================
// Model Resolution
// ============================================================================

export const TaskTypeSchema = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
]);

export type TaskType = z.infer<typeof TaskTypeSchema>;

export const ResolvedModelConfigSchema = z.object({
	provider: z.string(),
	providerModelId: z.string(),
	modelString: z.string(),
	apiKey: z.string(),
	source: z.enum(["user_override", "org_override", "system_default"]),
});

export type ResolvedModelConfig = z.infer<typeof ResolvedModelConfigSchema>;

// ============================================================================
// Agent Configuration
// ============================================================================

export const AgentConfigSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	name: z.string(),
	displayName: z.string(),
	description: z.string().nullable(),
	framework: z.string(),
	deploymentUrl: z.string().nullable(),
	status: z.string(),
	scope: z.string(),
	config: z.record(z.string(), z.unknown()).nullable(),
	metadata: z.record(z.string(), z.unknown()).nullable(),
});
