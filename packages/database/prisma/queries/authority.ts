/**
 * Authority Session & Grant Queries
 *
 * Runtime authorization layer for Fabric's Pipes-style session-scoped
 * authorization model. Separates persistent credentials from ephemeral
 * runtime authority.
 *
 * Key concepts:
 * - AuthoritySession: time-bounded execution context (tied to a run/session)
 * - AuthorityGrant: specific permission within a session (provider + access level)
 *
 * Tenant isolation follows the standard XOR pattern.
 */

import { db } from "../client";
import type {
	AuthorityAccessLevel,
	AuthorityGrantKind,
	AuthorityProviderType,
	AuthorityRunType,
	AuthoritySessionStatus,
} from "../zod";

// ─── Authority Session ──────────────────────────────────────────────────────

export interface CreateAuthoritySessionInput {
	userId: string;
	organizationId?: string;
	runType: AuthorityRunType;
	runId?: string;
	expiresAt: Date;
	requestedByAgentId?: string;
}

/**
 * Create a new authority session in PENDING state.
 * Must be approved before grants become usable.
 */
export async function createAuthoritySession(
	input: CreateAuthoritySessionInput,
) {
	return db.authoritySession.create({
		data: {
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			runType: input.runType,
			runId: input.runId,
			status: "PENDING",
			expiresAt: input.expiresAt,
			requestedByAgentId: input.requestedByAgentId,
		},
		include: { grants: true },
	});
}

/**
 * Get an authority session by ID with tenant isolation.
 */
export async function getAuthoritySession(
	sessionId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return db.authoritySession.findFirst({
		where: {
			id: sessionId,
			userId,
			...orgFilter,
		},
		include: { grants: true },
	});
}

/**
 * Get the active authority session for a specific run.
 * Returns null if no active session exists.
 */
export async function getActiveAuthoritySessionForRun(
	runType: AuthorityRunType,
	runId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return db.authoritySession.findFirst({
		where: {
			runType,
			runId,
			userId,
			...orgFilter,
			status: "ACTIVE",
			expiresAt: { gt: new Date() },
		},
		include: { grants: true },
		orderBy: { requestedAt: "desc" },
	});
}

/**
 * Find any active authority session for a user (across all run types).
 * Used by the MCP gateway to find applicable sessions.
 */
export async function findActiveAuthoritySession(
	userId: string,
	organizationId?: string,
	runType?: AuthorityRunType,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return db.authoritySession.findFirst({
		where: {
			userId,
			...orgFilter,
			status: "ACTIVE",
			expiresAt: { gt: new Date() },
			...(runType ? { runType } : {}),
		},
		include: { grants: true },
		orderBy: { requestedAt: "desc" },
	});
}

/**
 * List authority sessions for a user (with pagination).
 */
export async function listAuthoritySessions(options: {
	userId: string;
	organizationId?: string;
	status?: AuthoritySessionStatus;
	limit?: number;
	offset?: number;
}) {
	const { userId, organizationId, status, limit = 20, offset = 0 } = options;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where = {
		userId,
		...orgFilter,
		...(status ? { status } : {}),
	};

	const [sessions, total] = await Promise.all([
		db.authoritySession.findMany({
			where,
			include: {
				grants: {
					select: {
						id: true,
						providerKey: true,
						providerDisplayName: true,
						accessLevel: true,
						status: true,
						kind: true,
					},
				},
			},
			orderBy: { requestedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.authoritySession.count({ where }),
	]);

	return { sessions, total, hasMore: offset + limit < total };
}

/**
 * Approve an authority session and all its PENDING grants.
 * Transitions session from PENDING → ACTIVE.
 */
export async function approveAuthoritySession(
	sessionId: string,
	userId: string,
	approvalInstructions?: string,
) {
	const now = new Date();

	return db.$transaction(async (tx) => {
		// Update session
		await tx.authoritySession.update({
			where: { id: sessionId },
			data: {
				status: "ACTIVE",
				approvedAt: now,
				approvalInstructions,
			},
		});

		// Approve all PENDING grants in this session
		await tx.authorityGrant.updateMany({
			where: {
				authoritySessionId: sessionId,
				status: "PENDING",
			},
			data: {
				status: "APPROVED",
				approvedBy: userId,
				approvedAt: now,
			},
		});

		return tx.authoritySession.findUnique({
			where: { id: sessionId },
			include: { grants: true },
		});
	});
}

/**
 * Deny an authority session and all its PENDING grants.
 */
export async function denyAuthoritySession(
	sessionId: string,
	userId: string,
	reason?: string,
) {
	const now = new Date();

	return db.$transaction(async (tx) => {
		await tx.authoritySession.update({
			where: { id: sessionId },
			data: { status: "REVOKED", revokedAt: now },
		});

		await tx.authorityGrant.updateMany({
			where: {
				authoritySessionId: sessionId,
				status: "PENDING",
			},
			data: {
				status: "DENIED",
				approvedBy: userId,
				deniedAt: now,
				denialReason: reason,
			},
		});
	});
}

/**
 * Revoke an active authority session (e.g., user manually revokes).
 */
export async function revokeAuthoritySession(sessionId: string) {
	const now = new Date();

	return db.$transaction(async (tx) => {
		await tx.authoritySession.update({
			where: { id: sessionId },
			data: { status: "REVOKED", revokedAt: now },
		});

		await tx.authorityGrant.updateMany({
			where: {
				authoritySessionId: sessionId,
				status: "APPROVED",
			},
			data: { status: "REVOKED" },
		});
	});
}

/**
 * Complete an authority session (run finished normally).
 */
export async function completeAuthoritySession(sessionId: string) {
	return db.authoritySession.update({
		where: { id: sessionId },
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
		},
	});
}

/**
 * Expire authority sessions and grants that have passed their expiresAt.
 * Should be called periodically (e.g., every minute via cron/timer).
 */
export async function expireAuthoritySessions() {
	const now = new Date();

	const [expiredSessions, expiredGrants] = await Promise.all([
		db.authoritySession.updateMany({
			where: {
				status: "ACTIVE",
				expiresAt: { lte: now },
			},
			data: { status: "EXPIRED" },
		}),
		db.authorityGrant.updateMany({
			where: {
				status: "APPROVED",
				expiresAt: { lte: now },
			},
			data: { status: "EXPIRED" },
		}),
	]);

	return {
		expiredSessions: expiredSessions.count,
		expiredGrants: expiredGrants.count,
	};
}

// ─── Authority Grants ───────────────────────────────────────────────────────

export interface CreateAuthorityGrantInput {
	authoritySessionId: string;
	kind?: AuthorityGrantKind;
	providerType: AuthorityProviderType;
	providerKey: string;
	providerRefId?: string;
	providerDisplayName?: string;
	accessLevel: AuthorityAccessLevel;
	toolScope?: string[];
	requestFingerprint?: string;
	expiresAt: Date;
	metadata?: Record<string, unknown>;
}

/**
 * Add a grant to an authority session.
 */
export async function createAuthorityGrant(input: CreateAuthorityGrantInput) {
	return db.authorityGrant.create({
		data: {
			authoritySessionId: input.authoritySessionId,
			kind: input.kind ?? "BROAD",
			providerType: input.providerType,
			providerKey: input.providerKey,
			providerRefId: input.providerRefId,
			providerDisplayName: input.providerDisplayName,
			accessLevel: input.accessLevel,
			toolScope: input.toolScope ?? [],
			requestFingerprint: input.requestFingerprint,
			status: "PENDING",
			expiresAt: input.expiresAt,
			metadata: input.metadata as any,
		},
	});
}

/**
 * Approve a specific grant within a session.
 */
export async function approveAuthorityGrant(
	grantId: string,
	approvedBy: string,
) {
	return db.authorityGrant.update({
		where: { id: grantId },
		data: {
			status: "APPROVED",
			approvedBy,
			approvedAt: new Date(),
		},
	});
}

/**
 * Deny a specific grant.
 */
export async function denyAuthorityGrant(
	grantId: string,
	deniedBy: string,
	reason?: string,
) {
	return db.authorityGrant.update({
		where: { id: grantId },
		data: {
			status: "DENIED",
			approvedBy: deniedBy,
			deniedAt: new Date(),
			denialReason: reason,
		},
	});
}

/**
 * Consume a one-shot REQUEST grant (marks it as used).
 */
export async function consumeRequestGrant(grantId: string) {
	return db.authorityGrant.update({
		where: { id: grantId },
		data: {
			status: "CONSUMED",
			consumedAt: new Date(),
		},
	});
}

// ─── Authority Checking (Core Enforcement) ──────────────────────────────────

export interface AuthorityCheckResult {
	authorized: boolean;
	grant?: {
		id: string;
		kind: string;
		accessLevel: string;
		expiresAt: Date;
		providerKey: string;
		sessionId: string;
	};
	reason?: string;
}

/**
 * Check whether a specific provider action is authorized.
 * This is the core enforcement function called before every external action.
 *
 * @param userId - User performing the action
 * @param organizationId - Org context (null for personal)
 * @param providerKey - Normalized provider key
 * @param accessLevel - Required access level (READ or WRITE)
 * @param toolName - Optional specific tool name for scoped grants
 * @param requestFingerprint - Optional fingerprint for one-shot grants
 * @param boundSessionId - If set, only grants from this specific AuthoritySession are considered
 * @param boundRunType - If set, only grants from sessions with this runType are considered
 * @param boundRunId - If set, only grants from sessions with this runId are considered
 */
export async function checkAuthority(params: {
	userId: string;
	organizationId?: string;
	providerKey: string;
	accessLevel: AuthorityAccessLevel;
	toolName?: string;
	requestFingerprint?: string;
	boundSessionId?: string;
	boundRunType?: AuthorityRunType;
	boundRunId?: string;
}): Promise<AuthorityCheckResult> {
	const {
		userId,
		organizationId,
		providerKey,
		accessLevel,
		toolName,
		requestFingerprint,
		boundSessionId,
		boundRunType,
		boundRunId,
	} = params;

	const now = new Date();

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Find active grants for this provider, optionally bound to a specific session
	const sessionFilter: Record<string, unknown> = {
		userId,
		...orgFilter,
		status: "ACTIVE",
		expiresAt: { gt: now },
	};
	if (boundSessionId) {
		sessionFilter.id = boundSessionId;
	}
	if (boundRunType) {
		sessionFilter.runType = boundRunType;
	}
	if (boundRunId) {
		sessionFilter.runId = boundRunId;
	}

	const grants = await db.authorityGrant.findMany({
		where: {
			providerKey,
			status: "APPROVED",
			expiresAt: { gt: now },
			authoritySession: sessionFilter,
		},
		include: {
			authoritySession: {
				select: {
					id: true,
					expiresAt: true,
					runType: true,
					runId: true,
				},
			},
		},
		orderBy: { approvedAt: "desc" },
	});

	if (grants.length === 0) {
		return {
			authorized: false,
			reason: `No active authority grant for provider "${providerKey}". Request authority first.`,
		};
	}

	// Check for matching grant
	for (const grant of grants) {
		// Access level check: WRITE grant covers READ, but not vice versa
		const levelSufficient =
			grant.accessLevel === accessLevel ||
			(grant.accessLevel === "WRITE" && accessLevel === "READ");

		if (!levelSufficient) {
			continue;
		}

		// Tool scope check
		if (grant.toolScope.length > 0 && toolName) {
			if (!grant.toolScope.includes(toolName)) {
				continue;
			}
		}

		// For BROAD grants
		if (grant.kind === "BROAD") {
			return {
				authorized: true,
				grant: {
					id: grant.id,
					kind: grant.kind,
					accessLevel: grant.accessLevel,
					expiresAt: grant.expiresAt,
					providerKey: grant.providerKey,
					sessionId: grant.authoritySession.id,
				},
			};
		}

		// For REQUEST grants (one-shot)
		if (grant.kind === "REQUEST" && requestFingerprint) {
			if (grant.requestFingerprint === requestFingerprint) {
				return {
					authorized: true,
					grant: {
						id: grant.id,
						kind: grant.kind,
						accessLevel: grant.accessLevel,
						expiresAt: grant.expiresAt,
						providerKey: grant.providerKey,
						sessionId: grant.authoritySession.id,
					},
				};
			}
		}
	}

	// Found grants but none matched access level or scope
	const highestLevel = grants.some((g) => g.accessLevel === "WRITE")
		? "WRITE"
		: "READ";

	if (accessLevel === "WRITE" && highestLevel === "READ") {
		return {
			authorized: false,
			reason: `Provider "${providerKey}" has READ authority but WRITE is required. Request WRITE authority.`,
		};
	}

	return {
		authorized: false,
		reason: `No matching authority grant for provider "${providerKey}" with required scope.`,
	};
}

// ─── Convenience: Create Session with Grants ────────────────────────────────

export interface CreateAuthorityRequestInput {
	userId: string;
	organizationId?: string;
	runType: AuthorityRunType;
	runId?: string;
	ttlMinutes?: number;
	requestedByAgentId?: string;
	grants: Array<{
		providerType: AuthorityProviderType;
		providerKey: string;
		providerRefId?: string;
		providerDisplayName?: string;
		accessLevel: AuthorityAccessLevel;
		toolScope?: string[];
		kind?: AuthorityGrantKind;
		requestFingerprint?: string;
	}>;
}

/**
 * Create an authority session with grants in one operation.
 * Returns PENDING session that must be approved before use.
 */
export async function createAuthorityRequest(
	input: CreateAuthorityRequestInput,
) {
	const ttlMinutes = input.ttlMinutes ?? 30;
	const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

	return db.$transaction(async (tx) => {
		const session = await tx.authoritySession.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				runType: input.runType,
				runId: input.runId,
				status: "PENDING",
				expiresAt,
				requestedByAgentId: input.requestedByAgentId,
			},
		});

		const grants = await Promise.all(
			input.grants.map((g) =>
				tx.authorityGrant.create({
					data: {
						authoritySessionId: session.id,
						kind: g.kind ?? "BROAD",
						providerType: g.providerType,
						providerKey: g.providerKey,
						providerRefId: g.providerRefId,
						providerDisplayName: g.providerDisplayName,
						accessLevel: g.accessLevel,
						toolScope: g.toolScope ?? [],
						requestFingerprint: g.requestFingerprint,
						status: "PENDING",
						expiresAt,
					},
				}),
			),
		);

		return { session, grants };
	});
}

// ─── Convenience: Sensitive Operation Authority ─────────────────────────────

export interface EnsureSensitiveAuthorityInput {
	userId: string;
	organizationId?: string;
	providerKey: string;
	accessLevel: AuthorityAccessLevel;
	providerType: AuthorityProviderType;
	providerRefId?: string;
	providerDisplayName?: string;
	runType?: AuthorityRunType;
	runId?: string;
	toolName?: string;
	ttlMinutes?: number;
}

export interface EnsureSensitiveAuthorityResult {
	authorized: boolean;
	grant?: AuthorityCheckResult["grant"];
	reason?: string;
	action?: "request_authority" | "approve_pending" | "upgrade_access_level";
	pendingSessionId?: string;
	skipped?: boolean;
}

/**
 * Shared helper for "only sensitive operations require authority".
 *
 * READ operations are treated as autonomous. WRITE operations require runtime
 * authority; on the first miss for a run-bound execution, this creates a
 * pending authority session so subsequent retries can reuse the session grant.
 */
/**
 * Tools that are safe content-creation operations and should be auto-authorized.
 * These tools create visual/content artifacts, not persistent data mutations.
 * They are classified as WRITE by name pattern ("create_*") but are functionally
 * idempotent rendering operations.
 */
const CONTENT_CREATION_TOOLS = new Set([
	// Excalidraw
	"create_view",
	// Draw.io MCP App / tool server
	"create_diagram",
	"open_drawio_xml",
	"open_drawio_csv",
	"open_drawio_mermaid",
	// First-class Frame tools (create/read/update/share are all content operations)
	"fabric_create_frame",
	"fabric_create_slideshow",
	"fabric_update_frame",
	"fabric_get_frame",
	"fabric_list_frames",
	"fabric_share_frame",
]);

export async function ensureSensitiveOperationAuthority(
	input: EnsureSensitiveAuthorityInput,
): Promise<EnsureSensitiveAuthorityResult> {
	const {
		userId,
		organizationId,
		providerKey,
		accessLevel,
		providerType,
		providerRefId,
		providerDisplayName,
		runType,
		runId,
		toolName,
		ttlMinutes = 30,
	} = input;

	// Auto-authorize READ operations and content creation tools
	if (
		accessLevel === "READ" ||
		(toolName && CONTENT_CREATION_TOOLS.has(toolName))
	) {
		return {
			authorized: true,
			skipped: true,
		};
	}

	const authority = await checkAuthority({
		userId,
		organizationId,
		providerKey,
		accessLevel,
		toolName,
		boundRunType: runType,
		boundRunId: runId,
	});

	if (authority.authorized) {
		return {
			authorized: true,
			grant: authority.grant,
		};
	}

	if (!runType || !runId) {
		return {
			authorized: false,
			reason: authority.reason,
			action: authority.reason?.includes(
				"READ authority but WRITE is required",
			)
				? "upgrade_access_level"
				: "request_authority",
		};
	}

	const now = new Date();
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const pendingSession = await db.authoritySession.findFirst({
		where: {
			userId,
			...orgFilter,
			runType,
			runId,
			status: "PENDING",
			expiresAt: { gt: now },
		},
		include: { grants: true },
		orderBy: { requestedAt: "desc" },
	});

	const pendingGrantMatches = pendingSession?.grants.some(
		(grant) =>
			grant.status === "PENDING" &&
			grant.providerKey === providerKey &&
			grant.accessLevel === "WRITE",
	);

	if (pendingSession && pendingGrantMatches) {
		return {
			authorized: false,
			reason: authority.reason,
			action: "approve_pending",
			pendingSessionId: pendingSession.id,
		};
	}

	if (pendingSession && !pendingGrantMatches) {
		const existingGrant = pendingSession.grants.find(
			(grant) =>
				grant.providerKey === providerKey && grant.status === "PENDING",
		);

		if (!existingGrant) {
			await createAuthorityGrant({
				authoritySessionId: pendingSession.id,
				providerType,
				providerKey,
				providerRefId,
				providerDisplayName,
				accessLevel,
				expiresAt: pendingSession.expiresAt,
			});
		}

		return {
			authorized: false,
			reason: authority.reason,
			action: "approve_pending",
			pendingSessionId: pendingSession.id,
		};
	}

	const created = await createAuthorityRequest({
		userId,
		organizationId,
		runType,
		runId,
		ttlMinutes,
		grants: [
			{
				providerType,
				providerKey,
				providerRefId,
				providerDisplayName,
				accessLevel,
			},
		],
	});

	return {
		authorized: false,
		reason: authority.reason,
		action: "request_authority",
		pendingSessionId: created.session.id,
	};
}
