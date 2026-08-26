/**
 * Data Connections Queries
 *
 * This module provides database queries for external data connections.
 * All queries follow the XOR tenant isolation pattern:
 * - Personal context: userId is set, organizationId is NULL
 * - Org context: organizationId is set (userId may be included for filtering)
 *
 * CRITICAL: Never use OR patterns for tenant isolation - always use explicit XOR.
 */

import {
	decryptApiKey,
	decryptApiKeyMaybe,
	encryptApiKey,
	isEncryptedApiKey,
} from "@repo/utils";
import { db, Prisma } from "../client";
import type {
	DataConnectionProvider,
	DataConnectionStatus,
	ResourceSyncStatus,
	SyncFrequency,
	SyncJobStatus,
	SyncJobType,
} from "../zod";

// ============================================================================
// Encryption-at-rest for the legacy DataConnection secret columns (SOC 2 CC6.1)
// ----------------------------------------------------------------------------
// `accessToken` / `refreshToken` / `credentials` are encrypted IN PLACE with the
// shared AES-256-GCM primitive. Reads decrypt-with-passthrough, so pre-existing
// PLAINTEXT rows keep working with no backfill and only newly-written values are
// ciphertext. Server readers therefore always receive plaintext; client-facing
// procedures strip these fields entirely (they never consume them).
// ============================================================================

/** Encrypt a token for storage. Passes null/undefined/empty through unchanged. */
function encryptToken<T extends string | null | undefined>(token: T): T {
	return (token ? encryptApiKey(token) : token) as T;
}

/**
 * Encrypt the heterogeneous `credentials` JSON blob as an encrypted string (a
 * valid JSON scalar). undefined / null / Json(Db)Null pass through so Prisma
 * update semantics (skip vs explicit-null) are preserved.
 */
function encryptCredentials<T>(credentials: T): T | string {
	if (credentials === undefined || credentials === null) {
		return credentials;
	}
	return encryptApiKey(JSON.stringify(credentials));
}

/** Decrypt an encrypted credentials string back to its object; passthrough otherwise. */
function decryptCredentials(credentials: unknown): unknown {
	if (typeof credentials === "string" && isEncryptedApiKey(credentials)) {
		try {
			return JSON.parse(decryptApiKey(credentials));
		} catch {
			return credentials;
		}
	}
	return credentials;
}

/**
 * Decrypt-with-passthrough a connection row's secret fields so every server
 * reader receives plaintext regardless of which query loaded it. Returns a shallow
 * copy; only mutates the secret fields that are present (the already-encrypted
 * `credential.encryptedPayload` relation is a different column and is untouched).
 */
function decryptConnectionSecrets<T extends Record<string, unknown> | null>(
	conn: T,
): T {
	if (!conn) {
		return conn;
	}
	const out: Record<string, unknown> = { ...conn };
	if ("accessToken" in out) {
		out.accessToken = decryptApiKeyMaybe(
			out.accessToken as string | null | undefined,
		);
	}
	if ("refreshToken" in out) {
		out.refreshToken = decryptApiKeyMaybe(
			out.refreshToken as string | null | undefined,
		);
	}
	if ("credentials" in out) {
		out.credentials = decryptCredentials(out.credentials);
	}
	return out as T;
}

// ============================================================================
// Data Connection Queries
// ============================================================================

/**
 * Get tenant filter for data connection queries.
 * Follows XOR pattern - NEVER use OR for tenant isolation.
 */
function getTenantFilter(params: {
	userId: string;
	organizationId: string | null | undefined;
}): Prisma.DataConnectionWhereInput {
	if (params.organizationId) {
		// Org context: filter by organizationId
		return { organizationId: params.organizationId };
	}
	// Personal context: filter by userId AND explicitly null organizationId
	return { userId: params.userId, organizationId: null };
}

function getCredentialTenantFilter(params: {
	userId: string;
	organizationId: string | null | undefined;
}): Prisma.DataConnectionCredentialWhereInput {
	if (params.organizationId) {
		return { organizationId: params.organizationId };
	}
	return { userId: params.userId, organizationId: null };
}

/**
 * List data connections for a tenant.
 *
 * @param params.userId - User ID (required)
 * @param params.organizationId - Organization ID (null for personal context)
 * @param params.provider - Optional provider filter
 * @param params.status - Optional status filter
 */
export async function getDataConnections(params: {
	userId: string;
	organizationId: string | null | undefined;
	provider?: DataConnectionProvider;
	status?: DataConnectionStatus;
}) {
	const { userId, organizationId, provider, status } = params;

	const tenantFilter = getTenantFilter({ userId, organizationId });

	return db.dataConnection
		.findMany({
			where: {
				...tenantFilter,
				...(provider && { provider }),
				...(status && { status }),
			},
			include: {
				_count: {
					select: {
						syncedResources: true,
						syncJobs: true,
					},
				},
				syncJobs: {
					orderBy: { createdAt: "desc" },
					take: 1,
					select: {
						id: true,
						status: true,
						type: true,
						failedItems: true,
						completedAt: true,
						createdAt: true,
						stats: true,
					},
				},
				schedules: true,
			},
			orderBy: { createdAt: "desc" },
		})
		.then((connections) =>
			connections.map((connection) => {
				const latestJob = connection.syncJobs[0];
				const rawStats =
					latestJob?.stats && typeof latestJob.stats === "object"
						? (latestJob.stats as Record<string, unknown>)
						: null;
				const itemsAdded =
					typeof rawStats?.added === "number" ? rawStats.added : 0;
				const itemsUpdated =
					typeof rawStats?.updated === "number"
						? rawStats.updated
						: 0;

				return decryptConnectionSecrets({
					...connection,
					lastSyncDelta: itemsAdded + itemsUpdated,
					lastSyncJob: latestJob ?? null,
				});
			}),
		);
}

/**
 * Get a single data connection by ID.
 *
 * SECURITY: Always include tenant context to prevent ID enumeration attacks.
 */
export async function getDataConnectionById(params: {
	id: string;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const { id, userId, organizationId } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	const connection = await db.dataConnection.findFirst({
		where: {
			id,
			...tenantFilter,
		},
		include: {
			syncJobs: {
				orderBy: { createdAt: "desc" },
				take: 10,
			},
			schedules: true,
			syncedResources: {
				orderBy: { updatedAt: "desc" },
				take: 100,
			},
			_count: {
				select: {
					syncedResources: true,
					syncJobs: true,
				},
			},
			credential: {
				select: {
					id: true,
					name: true,
					credentialType: true,
					updatedAt: true,
				},
			},
		},
	});
	return decryptConnectionSecrets(connection);
}

/**
 * Get a data connection by provider (for checking if already connected).
 */
export async function getDataConnectionByProvider(params: {
	provider: DataConnectionProvider;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const { provider, userId, organizationId } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	const connection = await db.dataConnection.findFirst({
		where: {
			provider,
			...tenantFilter,
		},
	});
	return decryptConnectionSecrets(connection);
}

/**
 * Create a new data connection.
 *
 * @returns The created data connection
 */
export async function createDataConnection(params: {
	userId: string;
	organizationId: string | null | undefined;
	provider: DataConnectionProvider;
	name: string;
	createdBy: string;
	externalWorkspaceId?: string;
	externalWorkspaceName?: string;
	accessToken?: string;
	refreshToken?: string;
	tokenExpiresAt?: Date;
	credentials?: Prisma.InputJsonValue;
	config?: Prisma.InputJsonValue;
	status?: DataConnectionStatus;
	credentialId?: string;
}) {
	const {
		userId,
		organizationId,
		provider,
		name,
		createdBy,
		externalWorkspaceId,
		externalWorkspaceName,
		accessToken,
		refreshToken,
		tokenExpiresAt,
		credentials,
		config,
		status,
		credentialId,
	} = params;

	// Enforce XOR pattern for tenant isolation
	const tenantFields = organizationId
		? { organizationId, userId: null }
		: { userId, organizationId: null };

	const created = await db.dataConnection.create({
		data: {
			...tenantFields,
			provider,
			name,
			createdBy,
			externalWorkspaceId,
			externalWorkspaceName,
			accessToken: encryptToken(accessToken),
			refreshToken: encryptToken(refreshToken),
			tokenExpiresAt,
			credentials: encryptCredentials(credentials),
			config,
			status: status ?? "PENDING",
			credentialId,
		},
	});
	return decryptConnectionSecrets(created);
}

/**
 * Get a data connection by provider and external workspace ID.
 * Useful for checking if a specific workspace is already connected.
 */
export async function getDataConnectionByWorkspace(params: {
	provider: DataConnectionProvider;
	externalWorkspaceId: string;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const { provider, externalWorkspaceId, userId, organizationId } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	const connection = await db.dataConnection.findFirst({
		where: {
			provider,
			externalWorkspaceId,
			...tenantFilter,
		},
	});
	return decryptConnectionSecrets(connection);
}

/**
 * Create or update a data connection by provider and workspace.
 * Used for OAuth completion where we want to update existing or create new.
 */
export async function upsertDataConnection(params: {
	userId: string;
	organizationId: string | null | undefined;
	provider: DataConnectionProvider;
	externalWorkspaceId: string;
	name: string;
	createdBy: string;
	externalWorkspaceName?: string;
	accessToken: string;
	refreshToken?: string;
	tokenExpiresAt?: Date;
	credentials?: Prisma.InputJsonValue;
	config?: Prisma.InputJsonValue;
}) {
	const {
		userId,
		organizationId,
		provider,
		externalWorkspaceId,
		name,
		createdBy,
		externalWorkspaceName,
		accessToken,
		refreshToken,
		tokenExpiresAt,
		credentials,
		config,
	} = params;

	// Check if connection already exists
	const existing = await getDataConnectionByWorkspace({
		provider,
		externalWorkspaceId,
		userId,
		organizationId,
	});

	if (existing) {
		// Update existing connection
		await db.dataConnection.update({
			where: { id: existing.id },
			data: {
				name,
				externalWorkspaceName,
				accessToken: encryptToken(accessToken),
				refreshToken: encryptToken(refreshToken),
				tokenExpiresAt,
				credentials: encryptCredentials(credentials),
				config,
				status: "CONNECTED",
				lastSyncError: null,
			},
		});
		return getDataConnectionById({
			id: existing.id,
			userId,
			organizationId,
		});
	}

	// Create new connection
	return createDataConnection({
		userId,
		organizationId,
		provider,
		name,
		createdBy,
		externalWorkspaceId,
		externalWorkspaceName,
		accessToken,
		refreshToken,
		tokenExpiresAt,
		credentials,
		config,
		status: "CONNECTED",
	});
}

/**
 * Update a data connection.
 */
export async function updateDataConnection(params: {
	id: string;
	userId: string;
	organizationId: string | null | undefined;
	data: {
		name?: string;
		status?: DataConnectionStatus;
		accessToken?: string | null;
		refreshToken?: string | null;
		tokenExpiresAt?: Date | null;
		credentials?: Prisma.InputJsonValue;
		config?: Prisma.InputJsonValue;
		credentialId?: string | null;
		lastSyncAt?: Date | null;
		lastSyncError?: string | null;
	};
}) {
	const { id, userId, organizationId, data } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	// Transform null JSON values to Prisma.JsonNull for proper handling.
	// Secret fields (accessToken/refreshToken/credentials) are encrypted here —
	// these overrides come AFTER `...data`, so the encrypted values win.
	const updateData: Prisma.DataConnectionUpdateManyMutationInput = {
		...data,
		...(data.accessToken !== undefined && {
			accessToken: encryptToken(data.accessToken),
		}),
		...(data.refreshToken !== undefined && {
			refreshToken: encryptToken(data.refreshToken),
		}),
		...(data.credentials !== undefined && {
			credentials:
				encryptCredentials(data.credentials) ?? Prisma.JsonNull,
		}),
		...(data.config !== undefined && {
			config: data.config ?? Prisma.JsonNull,
		}),
		...(data.credentialId !== undefined && {
			credentialId: data.credentialId,
		}),
	};

	return db.dataConnection.updateMany({
		where: {
			id,
			...tenantFilter,
		},
		data: updateData,
	});
}

/**
 * Delete a data connection.
 */
export async function deleteDataConnection(params: {
	id: string;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const { id, userId, organizationId } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	return db.dataConnection.deleteMany({
		where: {
			id,
			...tenantFilter,
		},
	});
}

// ============================================================================
// Sync Job Queries
// ============================================================================

/**
 * Create a new sync job.
 */
export async function createSyncJob(params: {
	connectionId: string;
	type?: SyncJobType;
	workflowId?: string;
	runId?: string;
}) {
	return db.dataSyncJob.create({
		data: {
			connectionId: params.connectionId,
			type: params.type ?? "FULL",
			status: "PENDING",
			workflowId: params.workflowId,
			runId: params.runId,
		},
	});
}

/**
 * Get sync jobs for a connection.
 */
export async function getSyncJobs(params: {
	connectionId: string;
	status?: SyncJobStatus;
	limit?: number;
}) {
	return db.dataSyncJob.findMany({
		where: {
			connectionId: params.connectionId,
			...(params.status && { status: params.status }),
		},
		orderBy: { createdAt: "desc" },
		take: params.limit ?? 20,
	});
}

/**
 * Get a sync job by ID.
 */
export async function getSyncJobById(id: string) {
	return db.dataSyncJob.findUnique({
		where: { id },
		include: {
			connection: {
				select: {
					id: true,
					provider: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
}

/**
 * Get a sync job by workflow ID.
 */
export async function getSyncJobByWorkflowId(workflowId: string) {
	return db.dataSyncJob.findFirst({
		where: { workflowId },
		include: {
			connection: {
				select: {
					id: true,
					provider: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
}

/**
 * Update a sync job.
 */
export async function updateSyncJob(params: {
	id: string;
	data: {
		status?: SyncJobStatus;
		totalItems?: number;
		processedItems?: number;
		failedItems?: number;
		startedAt?: Date;
		completedAt?: Date;
		error?: string | null;
		stats?: Prisma.InputJsonValue;
	};
}) {
	return db.dataSyncJob.update({
		where: { id: params.id },
		data: params.data,
	});
}

// ============================================================================
// Synced Resource Queries
// ============================================================================

/**
 * Create or update a synced resource.
 */
export async function upsertSyncedResource(params: {
	connectionId: string;
	externalId: string;
	data: {
		externalPath?: string;
		resourceType?: string;
		title?: string;
		contentHash?: string;
		metadata?: Prisma.InputJsonValue;
		workspaceId?: string;
		documentId?: string;
		lastSyncedAt?: Date;
		syncStatus?: ResourceSyncStatus;
		syncError?: string;
		sizeBytes?: number;
		textLength?: number;
	};
}) {
	const { connectionId, externalId, data } = params;

	// Prepare create/update data - handle optional fields properly
	const createData: Prisma.SyncedResourceCreateInput = {
		connection: { connect: { id: connectionId } },
		externalId,
		resourceType: data.resourceType ?? "document",
		title: data.title ?? externalId,
		...(data.externalPath && { externalPath: data.externalPath }),
		...(data.contentHash && { contentHash: data.contentHash }),
		...(data.metadata && { metadata: data.metadata }),
		...(data.workspaceId && {
			workspace: { connect: { id: data.workspaceId } },
		}),
		...(data.documentId && {
			document: { connect: { id: data.documentId } },
		}),
		...(data.lastSyncedAt && { lastSyncedAt: data.lastSyncedAt }),
		...(data.syncStatus && { syncStatus: data.syncStatus }),
		...(data.syncError && { syncError: data.syncError }),
		...(data.sizeBytes !== undefined && { sizeBytes: data.sizeBytes }),
		...(data.textLength !== undefined && { textLength: data.textLength }),
	};

	const updateData: Prisma.SyncedResourceUpdateInput = {
		...(data.resourceType && { resourceType: data.resourceType }),
		...(data.title && { title: data.title }),
		updatedAt: new Date(),
		...(data.externalPath !== undefined && {
			externalPath: data.externalPath,
		}),
		...(data.contentHash !== undefined && {
			contentHash: data.contentHash,
		}),
		...(data.metadata !== undefined && {
			metadata: data.metadata ?? Prisma.JsonNull,
		}),
		...(data.workspaceId && {
			workspace: { connect: { id: data.workspaceId } },
		}),
		...(data.documentId && {
			document: { connect: { id: data.documentId } },
		}),
		...(data.lastSyncedAt && { lastSyncedAt: data.lastSyncedAt }),
		...(data.syncStatus && { syncStatus: data.syncStatus }),
		...(data.syncError !== undefined && { syncError: data.syncError }),
		...(data.sizeBytes !== undefined && { sizeBytes: data.sizeBytes }),
		...(data.textLength !== undefined && { textLength: data.textLength }),
	};

	return db.syncedResource.upsert({
		where: {
			connectionId_externalId: { connectionId, externalId },
		},
		create: createData,
		update: updateData,
	});
}

/**
 * Get synced resources for a connection.
 */
export async function getSyncedResources(params: {
	connectionId: string;
	syncStatus?: ResourceSyncStatus;
	limit?: number;
	offset?: number;
}) {
	return db.syncedResource.findMany({
		where: {
			connectionId: params.connectionId,
			...(params.syncStatus && { syncStatus: params.syncStatus }),
		},
		orderBy: { updatedAt: "desc" },
		take: params.limit ?? 50,
		skip: params.offset ?? 0,
		include: {
			document: {
				select: {
					id: true,
					filename: true,
					status: true,
				},
			},
		},
	});
}

export async function getConnectorBackedDocumentsForWorkspaces(params: {
	workspaceIds: string[];
	userId: string;
	organizationId?: string;
}) {
	if (params.workspaceIds.length === 0) {
		return [];
	}

	const tenantFilter = params.organizationId
		? { organizationId: params.organizationId }
		: { userId: params.userId, organizationId: null };

	return db.syncedResource.findMany({
		where: {
			workspaceId: { in: params.workspaceIds },
			documentId: { not: null },
			syncStatus: "SYNCED",
			connection: tenantFilter,
		},
		select: {
			documentId: true,
			workspaceId: true,
			title: true,
			externalPath: true,
			lastSyncedAt: true,
			connection: {
				select: {
					id: true,
					name: true,
					provider: true,
					externalWorkspaceName: true,
				},
			},
		},
	});
}

/**
 * Get a synced resource by external ID.
 */
export async function getSyncedResourceByExternalId(params: {
	connectionId: string;
	externalId: string;
}) {
	return db.syncedResource.findUnique({
		where: {
			connectionId_externalId: {
				connectionId: params.connectionId,
				externalId: params.externalId,
			},
		},
	});
}

/**
 * Mark resources as deleted that are not in the current sync.
 */
export async function markDeletedResources(params: {
	connectionId: string;
	currentExternalIds: string[];
}) {
	const { connectionId, currentExternalIds } = params;

	return db.syncedResource.updateMany({
		where: {
			connectionId,
			externalId: { notIn: currentExternalIds },
			syncStatus: { not: "DELETED" },
		},
		data: {
			syncStatus: "DELETED",
			updatedAt: new Date(),
		},
	});
}

/**
 * Delete synced resources for a connection.
 */
export async function deleteSyncedResources(connectionId: string) {
	return db.syncedResource.deleteMany({
		where: { connectionId },
	});
}

// ============================================================================
// Sync Schedule Queries
// ============================================================================

/**
 * Create or update a sync schedule.
 */
export async function upsertSyncSchedule(params: {
	connectionId: string;
	frequency: SyncFrequency;
	cronExpression?: string | null;
	isActive?: boolean;
	nextRunAt?: Date | null;
}) {
	const { connectionId, frequency, cronExpression, isActive, nextRunAt } =
		params;

	return db.dataSyncSchedule.upsert({
		where: { connectionId },
		create: {
			connectionId,
			frequency,
			cronExpression,
			isActive: isActive ?? true,
			nextRunAt,
		},
		update: {
			frequency,
			cronExpression,
			isActive,
			nextRunAt,
			updatedAt: new Date(),
		},
	});
}

/**
 * Get active schedules that are due.
 */
export async function getDueSchedules(beforeDate?: Date) {
	const dueDate = beforeDate ?? new Date();

	return db.dataSyncSchedule.findMany({
		where: {
			isActive: true,
			nextRunAt: { lte: dueDate },
		},
		include: {
			connection: {
				select: {
					id: true,
					provider: true,
					name: true,
					status: true,
					userId: true,
					organizationId: true,
				},
			},
		},
		orderBy: { nextRunAt: "asc" },
	});
}

/**
 * Update schedule after run.
 */
export async function updateScheduleAfterRun(params: {
	connectionId: string;
	lastRunAt: Date;
	nextRunAt: Date;
}) {
	return db.dataSyncSchedule.update({
		where: { connectionId: params.connectionId },
		data: {
			lastRunAt: params.lastRunAt,
			nextRunAt: params.nextRunAt,
		},
	});
}

// ============================================================================
// Credential Management
// ============================================================================

/**
 * Get connection credentials (for sync workflows).
 * Returns full connection with decryptable tokens.
 *
 * SECURITY: Only use in server-side workflows, never expose to client.
 */
export async function getConnectionWithCredentials(params: {
	id: string;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const { id, userId, organizationId } = params;
	const tenantFilter = getTenantFilter({ userId, organizationId });

	const connection = await db.dataConnection.findFirst({
		where: {
			id,
			...tenantFilter,
		},
		select: {
			id: true,
			provider: true,
			name: true,
			status: true,
			accessToken: true,
			refreshToken: true,
			tokenExpiresAt: true,
			credentials: true,
			credentialId: true,
			credential: {
				select: {
					id: true,
					name: true,
					credentialType: true,
					encryptedPayload: true,
				},
			},
			config: true,
			lastSyncAt: true,
			userId: true,
			organizationId: true,
		},
	});
	return decryptConnectionSecrets(connection);
}

export async function getDataConnectionCredentials(params: {
	userId: string;
	organizationId: string | null | undefined;
	provider?: DataConnectionProvider;
}) {
	const tenantFilter = getCredentialTenantFilter(params);

	return db.dataConnectionCredential.findMany({
		where: {
			...tenantFilter,
			...(params.provider ? { provider: params.provider } : {}),
		},
		include: {
			_count: {
				select: {
					dataConnections: true,
				},
			},
		},
		orderBy: { updatedAt: "desc" },
	});
}

export async function getDataConnectionCredentialById(params: {
	id: string;
	userId: string;
	organizationId: string | null | undefined;
}) {
	const tenantFilter = getCredentialTenantFilter(params);

	return db.dataConnectionCredential.findFirst({
		where: {
			id: params.id,
			...tenantFilter,
		},
		include: {
			_count: {
				select: {
					dataConnections: true,
				},
			},
		},
	});
}

export async function createDataConnectionCredential(params: {
	userId: string;
	organizationId: string | null | undefined;
	provider: DataConnectionProvider;
	name: string;
	credentialType?: string;
	encryptedPayload: string;
	createdBy: string;
}) {
	const tenantFields = params.organizationId
		? { organizationId: params.organizationId, userId: null }
		: { userId: params.userId, organizationId: null };

	return db.dataConnectionCredential.create({
		data: {
			...tenantFields,
			provider: params.provider,
			name: params.name,
			credentialType: params.credentialType,
			encryptedPayload: params.encryptedPayload,
			createdBy: params.createdBy,
		},
		include: {
			_count: {
				select: {
					dataConnections: true,
				},
			},
		},
	});
}

/**
 * Update OAuth tokens for a connection.
 */
export async function updateConnectionTokens(params: {
	id: string;
	accessToken: string;
	refreshToken?: string | null;
	tokenExpiresAt?: Date | null;
}) {
	const updated = await db.dataConnection.update({
		where: { id: params.id },
		data: {
			accessToken: encryptToken(params.accessToken),
			refreshToken: encryptToken(params.refreshToken),
			tokenExpiresAt: params.tokenExpiresAt,
			status: "CONNECTED",
		},
	});
	return decryptConnectionSecrets(updated);
}

/**
 * Mark connection as needing re-authentication.
 */
export async function markConnectionExpired(id: string) {
	return db.dataConnection.update({
		where: { id },
		data: {
			status: "EXPIRED",
			accessToken: null,
		},
	});
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get sync statistics for a connection.
 */
export async function getConnectionStats(connectionId: string) {
	const [resourceStats, recentJobs] = await Promise.all([
		db.syncedResource.groupBy({
			by: ["syncStatus"],
			where: { connectionId },
			_count: { syncStatus: true },
		}),
		db.dataSyncJob.findMany({
			where: { connectionId },
			orderBy: { createdAt: "desc" },
			take: 5,
			select: {
				id: true,
				status: true,
				type: true,
				totalItems: true,
				processedItems: true,
				failedItems: true,
				startedAt: true,
				completedAt: true,
				createdAt: true,
			},
		}),
	]);

	return {
		resourcesByStatus: resourceStats.reduce(
			(acc, { syncStatus, _count }) => {
				acc[syncStatus] = _count.syncStatus;
				return acc;
			},
			{} as Record<string, number>,
		),
		recentJobs,
	};
}
