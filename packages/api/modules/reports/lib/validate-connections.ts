/**
 * Validation utilities for report template instance connections
 *
 * Validates that MCP bindings and integration bindings reference configurations
 * the user actually has access to, enforcing tenant isolation at
 * create/update time rather than just at runtime.
 */

import {
	getMcpConfigById,
	getWorkflowIntegrationById,
	resolveReportMcpConfig,
} from "@repo/database";
import { z } from "zod";

/**
 * Schema for report template connections
 */
const reportConnectionsSchema = z.object({
	mcpConfigs: z.array(z.string()).default([]),
	// Mapping of data source ID to MCP config ID
	mcpBindings: z.record(z.string(), z.string()).optional(),
	// Mapping of data source ID to parameter values (e.g., project, team, etc.)
	parameterBindings: z
		.record(z.string(), z.record(z.string(), z.string()))
		.optional(),
	workflows: z.array(z.string()).default([]),
	agents: z.array(z.string()).default([]),
	workspaces: z.array(z.string()).default([]),
	integrations: z.array(z.string()).default([]),
	integrationBindings: z.record(z.string(), z.string()).optional(),
	resourceBindings: z
		.record(
			z.string(),
			z.object({
				resourceId: z.string(),
				resourceName: z.string(),
				resourceType: z.string(),
			}),
		)
		.optional(),
});

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	invalidBindings: string[];
}

/** Minimal template data-source shape needed to map a binding key → its server. */
export type ReportDataSourceMeta = {
	id?: string;
	key?: string;
	provider?: string;
};

/**
 * Candidate server keys for a binding, used by the self-heal fallback. A binding
 * may be keyed by the template data source's `key` ("fizzy") OR its `id`
 * ("task-board") — only the former matches the MCP server, so we map through the
 * template to also include the data source's `provider`/`key` (the real server
 * identity). Without this, a binding keyed by the data source id can't self-heal.
 */
export function serverKeysForBinding(
	bindingKey: string,
	dataSources?: ReportDataSourceMeta[],
): string[] {
	const keys = new Set<string>([bindingKey]);
	const ds = dataSources?.find(
		(d) =>
			d.id === bindingKey ||
			d.key === bindingKey ||
			d.provider === bindingKey,
	);
	if (ds) {
		if (ds.provider) {
			keys.add(ds.provider);
		}
		if (ds.key) {
			keys.add(ds.key);
		}
		if (ds.id) {
			keys.add(ds.id);
		}
	}
	return [...keys];
}

/**
 * Whether a config connects to the data source's own server. Any connected
 * tool may fill a data source, but only the report's owner chooses one of
 * another tool: an editor may not repoint the owner's connections.
 */
async function bindsToOwnServer(
	configId: string,
	serverKeys: string[],
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	const config = await getMcpConfigById(configId, { userId, organizationId });
	const serverKey = config?.mcpServer.key.trim().toLowerCase();
	return (
		!!serverKey &&
		serverKeys.some((key) => key.trim().toLowerCase() === serverKey)
	);
}

/**
 * Validate MCP bindings — a binding is valid when its stored config id still
 * resolves for the user.
 *
 * Resolution goes through {@link resolveReportMcpConfig}, which CAN self-heal to
 * the user's own config for the same server — but that fallback is disabled by
 * default (FABRIC_REPORTS_CONNECTION_SELF_HEAL). With it off, a removed/foreign
 * config id is invalid and the save fails with a clear "reconnect" message, so
 * the user re-selects a connection explicitly instead of silently running on a
 * substitute. (See resolveReportMcpConfig for the rationale + how to re-enable.)
 */
async function validateMcpBindings(
	mcpBindings: Record<string, string> | undefined,
	userId: string,
	organizationId: string | undefined,
	dataSources: ReportDataSourceMeta[] | undefined,
	sameServerOnly: boolean,
): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		invalidBindings: [],
	};

	// If null/undefined/empty, no validation needed
	if (!mcpBindings || Object.keys(mcpBindings).length === 0) {
		return result;
	}

	// Validate each MCP config reference
	const validationPromises = Object.entries(mcpBindings).map(
		async ([bindingKey, configId]) => {
			if (!configId) {
				return { bindingKey, valid: true };
			}

			// Prefer the stored config; self-heal to the user's config for the
			// same server (mapped from the binding key via the template).
			const resolved = await resolveReportMcpConfig({
				storedConfigId: configId,
				serverKeys: serverKeysForBinding(bindingKey, dataSources),
				userId,
				organizationId,
			});

			if (!resolved) {
				return {
					bindingKey,
					configId,
					valid: false,
					error: `No available connection for "${bindingKey}". Reconnect the data source, then re-select it.`,
				};
			}

			// A config resolved but is disabled — only happens for the stored
			// config (the server fallback returns enabled configs only).
			if (!resolved.enabled) {
				return {
					bindingKey,
					configId,
					valid: false,
					error: `The connection for "${bindingKey}" is disabled. Enable it or re-select a connection.`,
				};
			}

			if (
				sameServerOnly &&
				!(await bindsToOwnServer(
					resolved.configId,
					serverKeysForBinding(bindingKey, dataSources),
					userId,
					organizationId,
				))
			) {
				return {
					bindingKey,
					configId,
					valid: false,
					error: `Only the report's owner can connect a different tool to "${bindingKey}".`,
				};
			}

			return { bindingKey, configId, valid: true };
		},
	);

	const validationResults = await Promise.all(validationPromises);

	for (const res of validationResults) {
		if (!res.valid && "error" in res && "configId" in res) {
			result.valid = false;
			result.errors.push(res.error as string);
			result.invalidBindings.push(res.configId as string);
		}
	}

	return result;
}

/**
 * Validate integration bindings - ensures all referenced integration IDs
 * are accessible by the user in the current tenant context.
 */
async function validateIntegrationBindings(
	integrationBindings: Record<string, string> | undefined,
	userId: string,
	organizationId?: string,
): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		invalidBindings: [],
	};

	// If null/undefined/empty, no validation needed
	if (!integrationBindings || Object.keys(integrationBindings).length === 0) {
		return result;
	}

	// Validate each integration reference
	const validationPromises = Object.entries(integrationBindings).map(
		async ([bindingKey, integrationId]) => {
			if (!integrationId) {
				return { bindingKey, valid: true };
			}

			// Check if user has access to this integration
			const integration = await getWorkflowIntegrationById(
				integrationId,
				userId,
				organizationId,
			);

			if (!integration) {
				return {
					bindingKey,
					integrationId,
					valid: false,
					error: `No access to integration "${integrationId}" for binding "${bindingKey}"`,
				};
			}

			// Verify integration is active
			if (!integration.isActive) {
				return {
					bindingKey,
					integrationId,
					valid: false,
					error: `Integration "${integrationId}" for binding "${bindingKey}" is inactive`,
				};
			}

			return { bindingKey, integrationId, valid: true };
		},
	);

	const validationResults = await Promise.all(validationPromises);

	for (const res of validationResults) {
		if (!res.valid && "error" in res && "integrationId" in res) {
			result.valid = false;
			result.errors.push(res.error as string);
			result.invalidBindings.push(res.integrationId as string);
		}
	}

	return result;
}

function changedBindings(
	next: Record<string, string> | undefined,
	previous: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!next || !previous) {
		return next;
	}
	return Object.fromEntries(
		Object.entries(next).filter(([key, id]) => previous[key] !== id),
	);
}

/**
 * Validate all report connections at once.
 *
 * `userId` is the report's owner: reports run on their owner's connections, so
 * a binding is valid only when it resolves for the owner. Pass the stored
 * `previousConnections` on update so bindings that did not change are not
 * re-checked. `sameServerOnly` is for a caller who is not the owner: a
 * changed MCP binding must then connect to the data source's own server.
 */
export async function validateReportConnections(
	connections: unknown,
	userId: string,
	organizationId?: string,
	dataSources?: ReportDataSourceMeta[],
	previousConnections?: unknown,
	{ sameServerOnly = false }: { sameServerOnly?: boolean } = {},
): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: true,
		errors: [],
		invalidBindings: [],
	};

	// If null/undefined/empty, no validation needed
	if (!connections || typeof connections !== "object") {
		return result;
	}

	// Parse with schema first
	const parseResult = reportConnectionsSchema.safeParse(connections);
	if (!parseResult.success) {
		return {
			valid: false,
			errors: [
				`Invalid connections format: ${parseResult.error.message}`,
			],
			invalidBindings: [],
		};
	}

	const parsedConnections = parseResult.data;
	const previous = reportConnectionsSchema.safeParse(
		previousConnections ?? {},
	).data;

	// Validate MCP bindings and integration bindings in parallel
	const [mcpResult, integrationResult] = await Promise.all([
		validateMcpBindings(
			changedBindings(
				parsedConnections.mcpBindings,
				previous?.mcpBindings,
			),
			userId,
			organizationId,
			dataSources,
			sameServerOnly,
		),
		validateIntegrationBindings(
			changedBindings(
				parsedConnections.integrationBindings,
				previous?.integrationBindings,
			),
			userId,
			organizationId,
		),
	]);

	return {
		valid: mcpResult.valid && integrationResult.valid,
		errors: [...mcpResult.errors, ...integrationResult.errors],
		invalidBindings: [
			...mcpResult.invalidBindings,
			...integrationResult.invalidBindings,
		],
	};
}
