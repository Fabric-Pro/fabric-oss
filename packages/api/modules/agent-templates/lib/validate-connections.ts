/**
 * Validation utilities for agent template instance connections
 *
 * Validates that knowledge and tool connections reference integrations
 * the user actually has access to, enforcing tenant isolation at
 * create/update time rather than just at runtime.
 *
 * Supports two types of connections:
 * 1. OAuth-based (NOTION, GITHUB, GOOGLE_DRIVE, SLACK, MICROSOFT_GRAPH) - validated via OAuth status
 * 2. API key-based - validated via WorkflowIntegration table
 */

import { db, getWorkflowIntegrationByIdInTenant } from "@repo/database";
import { MAX_QUERY_INDEXES } from "@repo/integrations/databricks-vector-search";
import { z } from "zod";

/**
 * OAuth providers don't use WorkflowIntegration records - they use OAuthIntegration.
 * When a user selects these in the UI, we store them as { "NOTION": "oauth" }
 * to indicate the connection is OAuth-based.
 */
const OAUTH_PROVIDERS = [
	"GITHUB",
	"GOOGLE_DRIVE",
	"MICROSOFT_GRAPH",
	"SLACK",
	"NOTION",
] as const;

type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function isOAuthProvider(type: string): type is OAuthProvider {
	return OAUTH_PROVIDERS.includes(type as OAuthProvider);
}

/**
 * Check if OAuth connection exists for a provider
 * Maps our provider types to workflow integration provider types
 */
async function hasOAuthConnection(
	provider: OAuthProvider,
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	// Check if OAuth integration exists - using tenant isolation
	// Cast provider to the enum type expected by Prisma
	const integration = await db.workflowIntegration.findFirst({
		where: organizationId
			? {
					provider: provider as
						| "GITHUB"
						| "GOOGLE_DRIVE"
						| "MICROSOFT_GRAPH"
						| "SLACK"
						| "NOTION",
					organizationId,
					isActive: true,
				}
			: {
					provider: provider as
						| "GITHUB"
						| "GOOGLE_DRIVE"
						| "MICROSOFT_GRAPH"
						| "SLACK"
						| "NOTION",
					userId,
					organizationId: null,
					isActive: true,
				},
		select: { id: true },
	});

	return !!integration;
}

/**
 * Schema for knowledge connections
 * Maps knowledge source types to integration IDs
 * Example: { "NOTION": "integration-id-123", "GOOGLE_DRIVE": "integration-id-456" }
 */
export const knowledgeConnectionsSchema = z
	.record(
		z.string(), // Knowledge source type (NOTION, GOOGLE_DRIVE, etc.)
		z.string(), // Integration ID
	)
	.optional()
	.nullable();

/**
 * Schema for per-provider resource scoping on knowledge connections.
 * Maps a provider type to the specific resources selected for that
 * connection, e.g. a Unity Catalog schema + the vector indexes within it.
 * Example: { "DATABRICKS_VECTOR_SEARCH": { "schema": "catalog.schema", "indexes": ["idx1"] } }
 */
export const knowledgeResourcesSchema = z
	.record(
		z.string(), // Provider type (DATABRICKS_VECTOR_SEARCH, ...)
		z.object({
			schema: z.string().min(1),
			indexes: z
				.array(z.string().min(1))
				.min(1)
				.max(
					MAX_QUERY_INDEXES,
					`A maximum of ${MAX_QUERY_INDEXES} indexes can be selected`,
				),
		}),
	)
	.optional()
	.nullable();

/**
 * Schema for tool connections
 * Maps tool names to their configurations
 * Example: { "execute-sql": { "connectionId": "db-conn-123" }, "web-search": { "enabled": true } }
 */
export const toolConnectionsSchema = z
	.record(
		z.string(), // Tool name
		z
			.object({
				connectionId: z.string().optional(), // Optional integration reference
				enabled: z.boolean().optional(),
				config: z.record(z.string(), z.any()).optional(), // Additional tool-specific config
			})
			.passthrough(), // Allow additional fields
	)
	.optional()
	.nullable();

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	invalidIntegrations: string[];
}

/**
 * Validate knowledge connections - ensures all referenced integration IDs
 * are accessible by the user in the current tenant context.
 */
export async function validateKnowledgeConnections(
	knowledgeConnections: unknown,
	userId: string,
	organizationId?: string,
): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		invalidIntegrations: [],
	};

	// If null/undefined/empty, no validation needed
	if (!knowledgeConnections || typeof knowledgeConnections !== "object") {
		return result;
	}

	// Parse with schema first
	const parseResult =
		knowledgeConnectionsSchema.safeParse(knowledgeConnections);
	if (!parseResult.success) {
		return {
			valid: false,
			errors: [
				"Invalid knowledge connections format: " +
					parseResult.error.message,
			],
			invalidIntegrations: [],
		};
	}

	const connections = parseResult.data;
	if (!connections) {
		return result;
	}

	// Validate each integration reference
	const validationPromises = Object.entries(connections).map(
		async ([sourceType, integrationId]) => {
			if (!integrationId) {
				return { sourceType, valid: true };
			}

			// OAuth providers use "oauth" as a marker value
			// Validate server-side that the OAuth connection actually exists
			if (isOAuthProvider(sourceType) && integrationId === "oauth") {
				const hasConnection = await hasOAuthConnection(
					sourceType,
					userId,
					organizationId,
				);
				if (!hasConnection) {
					return {
						sourceType,
						integrationId,
						valid: false,
						error: `OAuth connection for ${sourceType} is not established`,
					};
				}
				return { sourceType, integrationId, valid: true };
			}

			// Check if user has access to this integration
			const integration = await getWorkflowIntegrationByIdInTenant(
				integrationId,
				userId,
				organizationId,
			);

			if (!integration) {
				return {
					sourceType,
					integrationId,
					valid: false,
					error: `No access to integration "${integrationId}" for ${sourceType}`,
				};
			}

			// Verify integration is active
			if (!integration.isActive) {
				return {
					sourceType,
					integrationId,
					valid: false,
					error: `Integration "${integrationId}" for ${sourceType} is inactive`,
				};
			}

			// Verify the integration row's provider actually matches the
			// requested source type - without this, a caller could bind
			// e.g. DATABRICKS_VECTOR_SEARCH to a LINEAR integration id that
			// happens to be active and accessible, and runtime credential
			// mapping would follow the row's real provider instead.
			if (integration.provider !== sourceType) {
				return {
					sourceType,
					integrationId,
					valid: false,
					error: `Integration "${integrationId}" is a ${integration.provider} integration and cannot be used for ${sourceType}`,
				};
			}

			return { sourceType, integrationId, valid: true };
		},
	);

	const validationResults = await Promise.all(validationPromises);

	for (const res of validationResults) {
		if (!res.valid && "error" in res && "integrationId" in res) {
			result.valid = false;
			result.errors.push(res.error as string);
			result.invalidIntegrations.push(res.integrationId as string);
		}
	}

	return result;
}

/**
 * Validate tool connections - ensures all referenced integration IDs
 * in tool configurations are accessible by the user.
 */
async function validateToolConnections(
	toolConnections: unknown,
	userId: string,
	organizationId?: string,
): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		invalidIntegrations: [],
	};

	// If null/undefined/empty, no validation needed
	if (!toolConnections || typeof toolConnections !== "object") {
		return result;
	}

	// Parse with schema first
	const parseResult = toolConnectionsSchema.safeParse(toolConnections);
	if (!parseResult.success) {
		return {
			valid: false,
			errors: [
				`Invalid tool connections format: ${parseResult.error.message}`,
			],
			invalidIntegrations: [],
		};
	}

	const connections = parseResult.data;
	if (!connections) {
		return result;
	}

	// Validate each tool's connection references
	const validationPromises = Object.entries(connections).map(
		async ([toolName, toolConfig]) => {
			// If tool has a connectionId, validate it
			if (toolConfig?.connectionId) {
				const integration = await getWorkflowIntegrationByIdInTenant(
					toolConfig.connectionId,
					userId,
					organizationId,
				);

				if (!integration) {
					return {
						toolName,
						connectionId: toolConfig.connectionId,
						valid: false,
						error: `No access to integration "${toolConfig.connectionId}" for tool "${toolName}"`,
					};
				}

				// Verify integration is active
				if (!integration.isActive) {
					return {
						toolName,
						connectionId: toolConfig.connectionId,
						valid: false,
						error: `Integration "${toolConfig.connectionId}" for tool "${toolName}" is inactive`,
					};
				}
			}

			return { toolName, valid: true };
		},
	);

	const validationResults = await Promise.all(validationPromises);

	for (const res of validationResults) {
		if (!res.valid && "error" in res && "connectionId" in res) {
			result.valid = false;
			result.errors.push(res.error as string);
			result.invalidIntegrations.push(res.connectionId as string);
		}
	}

	return result;
}

/**
 * Validate all connections (both knowledge and tool) at once
 */
export async function validateAllConnections(
	knowledgeConnections: unknown,
	toolConnections: unknown,
	userId: string,
	organizationId?: string,
): Promise<ValidationResult> {
	const [knowledgeResult, toolResult] = await Promise.all([
		validateKnowledgeConnections(
			knowledgeConnections,
			userId,
			organizationId,
		),
		validateToolConnections(toolConnections, userId, organizationId),
	]);

	return {
		valid: knowledgeResult.valid && toolResult.valid,
		errors: [...knowledgeResult.errors, ...toolResult.errors],
		invalidIntegrations: [
			...knowledgeResult.invalidIntegrations,
			...toolResult.invalidIntegrations,
		],
	};
}
