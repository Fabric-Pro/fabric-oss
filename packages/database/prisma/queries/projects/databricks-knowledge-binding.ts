/**
 * Project-level Databricks Vector Search knowledge binding queries.
 *
 * One binding per project (v1): a project is bound to ONE Databricks Vector
 * Search integration plus a set of its indexes, read-only. The binding row
 * carries no tenant columns — the parent Project is the authorization
 * boundary, so every read here scopes the project lookup the same way
 * `loadAgentDatabricksBindings` scopes the agent instance:
 *
 *   organizationId ? { organizationId } : { userId, organizationId: null }
 *
 * IMPORTANT: in org context the filter is `{ organizationId }` ONLY — not the
 * generic `{ organizationId, userId }` XOR — because any org member's runtime
 * may read the org project's binding, including projects owned by another
 * member. Copying the generic XOR shape here would silently break org
 * projects for everyone but their creator.
 */

import { db, Prisma } from "../../client";

/** Runtime shape consumed by tool exposure and RAG retrieval. */
export interface ProjectDatabricksKnowledgeBindingRuntime {
	integrationId: string;
	schema: string;
	indexNames: string[];
}

/** Parsed `allowedResources` payload: `{ schema, indexes }`. */
function parseAllowedResources(allowedResources: unknown): {
	schema: string;
	indexNames: string[];
} {
	const resources = allowedResources as {
		schema?: unknown;
		indexes?: unknown;
	} | null;
	const indexNames = Array.isArray(resources?.indexes)
		? resources.indexes.filter(
				(indexName): indexName is string =>
					typeof indexName === "string" && indexName.length > 0,
			)
		: [];
	return {
		schema:
			typeof resources?.schema === "string"
				? resources.schema
				: "unknown",
		indexNames,
	};
}

function projectTenantFilter(userId: string, organizationId?: string | null) {
	return organizationId
		? { organizationId }
		: { userId, organizationId: null };
}

/**
 * Full binding row (plus integration summary) for the settings UI / API get.
 * Returns `null` when the project is outside the caller's tenant or has no
 * binding.
 */
export async function getProjectDatabricksKnowledgeBinding(input: {
	projectId: string;
	userId: string;
	organizationId?: string | null;
}) {
	const project = await db.project.findFirst({
		where: {
			id: input.projectId,
			...projectTenantFilter(input.userId, input.organizationId),
		},
		select: {
			databricksKnowledgeBinding: {
				include: {
					integration: {
						select: {
							id: true,
							name: true,
							provider: true,
							isActive: true,
						},
					},
				},
			},
		},
	});

	const binding = project?.databricksKnowledgeBinding;
	if (!binding) {
		return null;
	}

	const { schema, indexNames } = parseAllowedResources(
		binding.allowedResources,
	);
	return {
		id: binding.id,
		projectId: binding.projectId,
		integrationId: binding.integrationId,
		schema,
		indexNames,
		isEnabled: binding.isEnabled,
		createdAt: binding.createdAt,
		updatedAt: binding.updatedAt,
		createdBy: binding.createdBy,
		integration: binding.integration,
	};
}

/**
 * Runtime loader for tool exposure and RAG retrieval: the project's enabled
 * binding, only when its integration is still active and still a
 * DATABRICKS_VECTOR_SEARCH row. Returns `null` (silent no-op) otherwise —
 * including for cross-tenant callers and project-scoped guests, whose own
 * tenant does not resolve the credentials (the safe outcome; do not "fix" by
 * falling back to the project owner's tenant).
 */
export async function loadProjectDatabricksKnowledgeBinding(input: {
	projectId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<ProjectDatabricksKnowledgeBindingRuntime | null> {
	const project = await db.project.findFirst({
		where: {
			id: input.projectId,
			...projectTenantFilter(input.userId, input.organizationId),
		},
		select: {
			databricksKnowledgeBinding: {
				include: {
					integration: {
						select: { provider: true, isActive: true },
					},
				},
			},
		},
	});

	const binding = project?.databricksKnowledgeBinding;
	if (
		!binding ||
		!binding.isEnabled ||
		!binding.integration.isActive ||
		binding.integration.provider !== "DATABRICKS_VECTOR_SEARCH"
	) {
		return null;
	}

	const { schema, indexNames } = parseAllowedResources(
		binding.allowedResources,
	);
	if (indexNames.length === 0) {
		return null;
	}

	return { integrationId: binding.integrationId, schema, indexNames };
}

/**
 * Thrown when the integration referenced by a save is unusable for a project
 * knowledge binding: missing in the caller's tenant, inactive, or not a
 * DATABRICKS_VECTOR_SEARCH row. The API layer maps this to a 400.
 */
export class InvalidDatabricksKnowledgeIntegrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidDatabricksKnowledgeIntegrationError";
	}
}

/**
 * Create or replace the project's Databricks knowledge binding.
 *
 * The integration validation runs INSIDE the same transaction as the upsert,
 * and against the PROJECT's tenant (resolved from the project row itself,
 * never from caller-supplied context): RLS (and the caller's permission
 * middleware) validate the *project*, not the *integration* — without this
 * check nothing stops binding a personal integration to an org project,
 * which would then silently no-op for every org member at read time.
 * Mirrors the check shape in
 * `packages/api/modules/agent-templates/lib/validate-connections.ts`.
 */
export async function saveProjectDatabricksKnowledgeBinding(input: {
	projectId: string;
	integrationId: string;
	schema: string;
	indexNames: string[];
	isEnabled?: boolean;
	/** The caller performing the save (recorded as createdBy). */
	createdBy: string;
}) {
	return db.$transaction(async (tx) => {
		const project = await tx.project.findUnique({
			where: { id: input.projectId },
			select: { userId: true, organizationId: true },
		});
		if (!project) {
			throw new InvalidDatabricksKnowledgeIntegrationError(
				"Project not found",
			);
		}

		const integration = await tx.workflowIntegration.findFirst({
			where: {
				id: input.integrationId,
				...(project.organizationId
					? { organizationId: project.organizationId }
					: { userId: project.userId, organizationId: null }),
			},
			select: { id: true, provider: true, isActive: true },
		});

		if (!integration) {
			throw new InvalidDatabricksKnowledgeIntegrationError(
				`No access to integration "${input.integrationId}" in this workspace`,
			);
		}
		if (!integration.isActive) {
			throw new InvalidDatabricksKnowledgeIntegrationError(
				`Integration "${input.integrationId}" is inactive`,
			);
		}
		if (integration.provider !== "DATABRICKS_VECTOR_SEARCH") {
			throw new InvalidDatabricksKnowledgeIntegrationError(
				`Integration "${input.integrationId}" is a ${integration.provider} integration and cannot be used for Databricks knowledge`,
			);
		}

		const allowedResources = {
			schema: input.schema,
			indexes: input.indexNames,
		} satisfies Prisma.InputJsonValue;

		return tx.projectDatabricksKnowledgeBinding.upsert({
			where: { projectId: input.projectId },
			create: {
				projectId: input.projectId,
				integrationId: input.integrationId,
				allowedResources,
				isEnabled: input.isEnabled ?? true,
				createdBy: input.createdBy,
			},
			update: {
				integrationId: input.integrationId,
				allowedResources,
				isEnabled: input.isEnabled ?? true,
			},
		});
	});
}

/**
 * Remove the project's binding. Returns the deleted row, or `null` when the
 * project has none — including when a CONCURRENT disconnect won the race
 * (Prisma P2025 is treated as already-deleted, so double-clicked or racing
 * disconnects are idempotent instead of a 500). Freely reconnectable — no
 * lock-in; nothing here replaces existing data, so there is nothing to
 * protect via a one-way transition.
 */
export async function deleteProjectDatabricksKnowledgeBinding(input: {
	projectId: string;
}) {
	try {
		return await db.projectDatabricksKnowledgeBinding.delete({
			where: { projectId: input.projectId },
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2025"
		) {
			return null;
		}
		throw error;
	}
}

/**
 * Projects bound to an integration — used by the integration delete
 * procedures to fail loudly (naming the dependent projects) instead of
 * surfacing the raw `onDelete: Restrict` FK error.
 */
export async function listProjectsBoundToIntegration(integrationId: string) {
	const bindings = await db.projectDatabricksKnowledgeBinding.findMany({
		where: { integrationId },
		select: {
			projectId: true,
			project: { select: { name: true } },
		},
	});
	return bindings.map((binding) => ({
		projectId: binding.projectId,
		projectName: binding.project.name,
	}));
}
