/**
 * Database queries for WorkflowIntegration model
 */

import { db, type Prisma } from "../../client";
import type { WorkflowIntegrationProvider } from "../../generated/enums";
import { OAUTH_APP_ROW_NAMES } from "../lib/oauth-app-row";

/**
 * Excludes the `<PROVIDER>_OAUTH_APP` rows, which hold a provider's stored
 * OAuth client credentials rather than a connection. They share provider, user
 * and organization with the connection rows, so every connection listing and
 * every delete-by-type has to leave them out by their exact reserved name.
 */
const EXCLUDE_OAUTH_APP_ROWS = {
	NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
} satisfies Prisma.WorkflowIntegrationWhereInput;

/**
 * Create a workflow integration
 */
export async function createWorkflowIntegration(data: {
	workflowId?: string;
	userId: string;
	organizationId?: string;
	provider: WorkflowIntegrationProvider;
	name: string;
	credentials: string; // Encrypted JSON string
	settings?: Prisma.InputJsonValue;
}) {
	return await db.workflowIntegration.create({
		data: {
			workflowId: data.workflowId,
			userId: data.userId,
			organizationId: data.organizationId,
			provider: data.provider,
			name: data.name,
			credentials: data.credentials,
			settings: data.settings,
			isActive: true,
		},
	});
}

/**
 * Get workflow integration by ID
 * Enforces strict isolation between personal and organizational integrations
 */
export async function getWorkflowIntegrationById(
	integrationId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow fetching personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowIntegration.findFirst({
		where: {
			id: integrationId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Fetch a workflow integration by ID with tenant-level (not owner-level)
 * authorization: in org context any member may reference the org's
 * integration (callers must have verified membership); in personal context
 * the row must belong to the user.
 */
export async function getWorkflowIntegrationByIdInTenant(
	integrationId: string,
	userId: string,
	organizationId?: string,
) {
	return db.workflowIntegration.findFirst({
		where: {
			id: integrationId,
			...(organizationId
				? { organizationId }
				: { userId, organizationId: null }),
		},
	});
}

/**
 * List workflow integrations
 * Enforces strict isolation between personal and organizational integrations
 */
export async function listWorkflowIntegrations(options: {
	workflowId?: string;
	userId: string;
	organizationId?: string;
	provider?: WorkflowIntegrationProvider;
}) {
	const { workflowId, userId, organizationId, provider } = options;

	// Strict isolation: if no organizationId, only show personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowIntegration.findMany({
		where: {
			userId,
			...orgFilter,
			...(workflowId ? { workflowId } : {}),
			...(provider ? { provider } : {}),
			isActive: true,
			...EXCLUDE_OAUTH_APP_ROWS,
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * List workflow integrations with tenant-level (not owner-level)
 * authorization. Callers must verify organization membership before using
 * this helper in org context.
 */
export async function listWorkflowIntegrationsInTenant(options: {
	workflowId?: string;
	userId: string;
	organizationId?: string;
	provider?: WorkflowIntegrationProvider;
}) {
	const { workflowId, userId, organizationId, provider } = options;

	return await db.workflowIntegration.findMany({
		where: {
			...(organizationId
				? { organizationId }
				: { userId, organizationId: null }),
			...(workflowId ? { workflowId } : {}),
			...(provider ? { provider } : {}),
			isActive: true,
			...EXCLUDE_OAUTH_APP_ROWS,
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Update workflow integration
 * Enforces strict isolation between personal and organizational integrations
 */
export async function updateWorkflowIntegration(
	integrationId: string,
	userId: string,
	data: {
		name?: string;
		credentials?: string;
		settings?: Prisma.InputJsonValue;
		isActive?: boolean;
	},
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow updating personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowIntegration.update({
		where: {
			id: integrationId,
			userId,
			...orgFilter,
		},
		data: {
			...data,
			lastUsedAt: new Date(),
		},
	});
}

/**
 * Delete workflow integration
 * Enforces strict isolation between personal and organizational integrations
 */
export async function deleteWorkflowIntegration(
	integrationId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow deleting personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowIntegration.delete({
		where: {
			id: integrationId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Mark integration as used (update lastUsedAt)
 */
export async function markIntegrationUsed(integrationId: string) {
	return await db.workflowIntegration.update({
		where: { id: integrationId },
		data: { lastUsedAt: new Date() },
	});
}

/**
 * Get integrations by provider for a user/org
 * Enforces strict isolation between personal and organizational integrations
 */
export async function getIntegrationsByProvider(
	provider: WorkflowIntegrationProvider,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only show personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowIntegration.findMany({
		where: {
			provider,
			userId,
			...orgFilter,
			isActive: true,
			...EXCLUDE_OAUTH_APP_ROWS,
		},
		orderBy: { lastUsedAt: "desc" },
	});
}

/**
 * Delete workflow integration by type
 * Removes ALL matching integrations for a given provider type
 * Enforces strict isolation between personal and organizational integrations
 */
export async function deleteWorkflowIntegrationByType(
	provider: WorkflowIntegrationProvider,
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	// Strict isolation: if no organizationId, only allow deleting personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Delete all matching connection rows. Never the stored OAuth app
	// credentials: removing a connection must not switch OAuth off for the
	// whole organization (`gitlab.disconnect` and `oauth.disconnect` keep them
	// the same way).
	const result = await db.workflowIntegration.deleteMany({
		where: {
			provider,
			userId,
			...orgFilter,
			...EXCLUDE_OAUTH_APP_ROWS,
		},
	});

	return result.count > 0;
}
