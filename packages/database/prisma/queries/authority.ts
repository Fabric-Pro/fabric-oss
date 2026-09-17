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

import type { Prisma } from "../client";
import { db } from "../client";
import type {
	AuthorityAccessLevel,
	AuthorityGrantKind,
	AuthorityProviderType,
	AuthorityRunType,
	AuthoritySessionStatus,
} from "../zod";
import { advisoryObjectKey } from "./lib/refresh-lock-key";

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
 * Find the authority session bound to one run, whether it is still waiting
 * for a decision (PENDING) or already granted (ACTIVE).
 *
 * This is the lookup a run must use before raising a new request for
 * itself: `findActiveAuthoritySession` ignores `runId`, so a session raised
 * by an unrelated concurrent run would otherwise satisfy the "already
 * requested" check and leave this run with no session of its own.
 */
export async function findAuthoritySessionForRun(
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
			status: { in: ["PENDING", "ACTIVE"] },
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
 * Thrown when an authority decision cannot be applied because the session is
 * not in the state the decision requires (already decided, revoked, expired,
 * or not visible to this user and tenant). The transition was not made.
 */
export class AuthoritySessionConflictError extends Error {
	readonly sessionId: string;
	readonly currentStatus: AuthoritySessionStatus | null;

	constructor(
		sessionId: string,
		currentStatus: AuthoritySessionStatus | null,
		detail: string,
	) {
		super(`Authority session ${sessionId} ${detail}`);
		this.name = "AuthoritySessionConflictError";
		this.sessionId = sessionId;
		this.currentStatus = currentStatus;
	}
}

export interface AuthorityDecisionOptions {
	/**
	 * Tenant the deciding user is acting in. `null` pins the session to the
	 * personal (organization-less) arm; `undefined` leaves the tenant
	 * unchecked, which only the trusted internal callers that already
	 * verified it may do.
	 */
	organizationId?: string | null;
}

function decisionTenantFilter(options?: AuthorityDecisionOptions) {
	if (options?.organizationId === undefined) {
		return {};
	}
	return options.organizationId
		? { organizationId: options.organizationId }
		: { organizationId: null };
}

/**
 * Approve an authority session and all its PENDING grants.
 * Transitions session from PENDING → ACTIVE.
 *
 * The transition is a single conditional update: it only lands on a session
 * that is still PENDING, unexpired, owned by `userId` and (when given) in
 * the caller's tenant. A revoke, deny or expiry that raced ahead of this
 * call is therefore never overwritten, and the grants are only approved
 * when this call is the one that activated the session.
 *
 * Retry-safe: a session that is already ACTIVE is returned as-is, so an
 * at-least-once caller that lost the first result sees its own success
 * rather than a conflict. Any other state throws
 * `AuthoritySessionConflictError`.
 */
export async function approveAuthoritySession(
	sessionId: string,
	userId: string,
	approvalInstructions?: string,
	options?: AuthorityDecisionOptions,
) {
	const now = new Date();
	const tenantFilter = decisionTenantFilter(options);

	return db.$transaction(async (tx) => {
		const activated = await tx.authoritySession.updateMany({
			where: {
				id: sessionId,
				userId,
				...tenantFilter,
				status: "PENDING",
				expiresAt: { gt: now },
			},
			data: {
				status: "ACTIVE",
				approvedAt: now,
				approvalInstructions,
			},
		});

		if (activated.count === 1) {
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
		} else {
			const current = await tx.authoritySession.findFirst({
				where: { id: sessionId, userId, ...tenantFilter },
				select: { status: true, expiresAt: true },
			});
			if (!current) {
				throw new AuthoritySessionConflictError(
					sessionId,
					null,
					"was not found for this user and tenant",
				);
			}
			if (current.status !== "ACTIVE") {
				throw new AuthoritySessionConflictError(
					sessionId,
					current.status,
					current.status === "PENDING"
						? `expired at ${current.expiresAt.toISOString()}; refusing to approve`
						: `is ${current.status}; refusing to approve`,
				);
			}
			if (current.expiresAt.getTime() <= now.getTime()) {
				throw new AuthoritySessionConflictError(
					sessionId,
					current.status,
					`expired at ${current.expiresAt.toISOString()}; refusing to approve`,
				);
			}
			// Already ACTIVE and unexpired: a retry of an approval that
			// committed. Nothing to transition.
		}

		return tx.authoritySession.findUnique({
			where: { id: sessionId },
			include: { grants: true },
		});
	});
}

/**
 * The statuses a decision can still act on. EXPIRED, REVOKED and COMPLETED
 * are terminal: a session in one of them grants nothing, so withdrawing it
 * again is a no-op rather than a transition.
 */
const DECIDABLE_SESSION_STATUSES = [
	"PENDING",
	"ACTIVE",
] as const satisfies readonly AuthoritySessionStatus[];

export interface AuthorityWithdrawalResult {
	/** True only when this call moved the session to REVOKED. */
	transitioned: boolean;
	previousStatus: AuthoritySessionStatus;
	/**
	 * - `withdrawn`: this call revoked the session.
	 * - `expired`: the session was past its `expiresAt`, so there was nothing
	 *   left to decide; it is (now) EXPIRED. Not a successful denial.
	 * - `already-final`: the session was already REVOKED or COMPLETED, or a
	 *   concurrent decision landed first.
	 */
	outcome: "withdrawn" | "expired" | "already-final";
}

/**
 * The shared PENDING|ACTIVE → REVOKED transition behind `denyAuthoritySession`
 * and `revokeAuthoritySession`.
 *
 * One conditional `updateMany`, same shape as `approveAuthoritySession`: it
 * only lands on a session in a decidable status owned by `userId` in the
 * caller's tenant, and — when `requireUnexpired` — still inside its
 * `expiresAt`. There is no read before it, so nothing observed earlier can
 * be overwritten: a concurrent approval, sweep or second decision either
 * lands first and this one becomes a no-op, or this one lands first and the
 * other sees REVOKED. The grants are only withdrawn when this call is the
 * one that transitioned the session. When the update did not land, one read
 * classifies the outcome: a session the caller cannot see throws
 * `AuthoritySessionConflictError`; anything else reports
 * `{ transitioned: false }` with the status that actually held.
 */
async function withdrawAuthoritySessionWithin(
	tx: Prisma.TransactionClient,
	args: {
		sessionId: string;
		userId: string;
		tenantFilter: ReturnType<typeof decisionTenantFilter>;
		now: Date;
		requireUnexpired: boolean;
		/** Recorded on PENDING grants that are denied by this withdrawal. */
		denialReason?: string;
	},
): Promise<AuthorityWithdrawalResult> {
	const { sessionId, userId, tenantFilter, now } = args;

	const withdrawn = await tx.authoritySession.updateMany({
		where: {
			id: sessionId,
			userId,
			...tenantFilter,
			status: { in: [...DECIDABLE_SESSION_STATUSES] },
			...(args.requireUnexpired ? { expiresAt: { gt: now } } : {}),
		},
		data: { status: "REVOKED", revokedAt: now },
	});

	if (withdrawn.count !== 1) {
		// Did not land. When the transition required an unexpired session,
		// first settle a live-but-expired one as EXPIRED — in the same
		// conditional family, owner-, tenant- and status-scoped — so an
		// unanswered request past its deadline does not stay PENDING and the
		// caller is told it expired rather than that it was denied.
		let expiredNow = 0;
		if (args.requireUnexpired) {
			const expired = await tx.authoritySession.updateMany({
				where: {
					id: sessionId,
					userId,
					...tenantFilter,
					status: { in: [...DECIDABLE_SESSION_STATUSES] },
					expiresAt: { lte: now },
				},
				data: { status: "EXPIRED" },
			});
			expiredNow = expired.count;
			if (expiredNow === 1) {
				await tx.authorityGrant.updateMany({
					where: {
						authoritySessionId: sessionId,
						status: { in: ["PENDING", "APPROVED"] },
					},
					data: { status: "EXPIRED" },
				});
			}
		}

		const current = await tx.authoritySession.findFirst({
			where: { id: sessionId, userId, ...tenantFilter },
			select: { status: true, approvedAt: true },
		});
		if (!current) {
			throw new AuthoritySessionConflictError(
				sessionId,
				null,
				"was not found for this user and tenant",
			);
		}
		if (expiredNow === 1) {
			return {
				transitioned: false,
				previousStatus: current.approvedAt ? "ACTIVE" : "PENDING",
				outcome: "expired",
			};
		}
		return {
			transitioned: false,
			previousStatus: current.status,
			outcome: current.status === "EXPIRED" ? "expired" : "already-final",
		};
	}

	const previous = await tx.authoritySession.findUniqueOrThrow({
		where: { id: sessionId },
		select: { approvedAt: true },
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
			denialReason: args.denialReason,
		},
	});
	await tx.authorityGrant.updateMany({
		where: {
			authoritySessionId: sessionId,
			status: "APPROVED",
		},
		data: { status: "REVOKED" },
	});

	// The session row no longer says which status it left; an approved
	// session carries `approvedAt`, a merely requested one does not.
	return {
		transitioned: true,
		previousStatus: previous.approvedAt ? "ACTIVE" : "PENDING",
		outcome: "withdrawn",
	};
}

/**
 * Deny an authority session: PENDING → REVOKED with its PENDING grants
 * DENIED. An ACTIVE session is withdrawn the same way (its APPROVED grants
 * become REVOKED), so a decision that lands after an out-of-band approval
 * still removes the authority.
 *
 * A single conditional transition like `approveAuthoritySession`, with the
 * same expiry predicate: it only lands on a PENDING or ACTIVE session that
 * is still inside its `expiresAt`, owned by `userId` in the caller's tenant.
 * A session whose `expiresAt` has passed is not denied: it is settled as
 * EXPIRED (session and its live grants) and reported with
 * `outcome: "expired"`, which callers must not present as a successful
 * denial. A session already REVOKED or COMPLETED is `already-final`. A
 * session the caller cannot see throws `AuthoritySessionConflictError`.
 */
export async function denyAuthoritySession(
	sessionId: string,
	userId: string,
	reason?: string,
	options?: AuthorityDecisionOptions,
): Promise<AuthorityWithdrawalResult> {
	const now = new Date();
	const tenantFilter = decisionTenantFilter(options);

	return db.$transaction((tx) =>
		withdrawAuthoritySessionWithin(tx, {
			sessionId,
			userId,
			tenantFilter,
			now,
			requireUnexpired: true,
			denialReason: reason,
		}),
	);
}

/**
 * Revoke an authority session the user no longer wants (the manual revoke
 * in the UI and the MCP gateway tool): PENDING|ACTIVE → REVOKED with its
 * grants withdrawn.
 *
 * Conditional and owner-and-tenant-scoped like `denyAuthoritySession`, so
 * a status that changed under the caller — a run that completed, a sweep
 * that expired the session — is never overwritten: the revoke becomes a
 * no-op that reports the status that held. Unlike deny it does not require
 * the session to be unexpired: an explicit revoke of a session the sweep
 * has not reached yet still lands, because the user asked for it to be
 * gone now rather than at the next sweep, and REVOKED and EXPIRED grant
 * exactly the same thing.
 */
export async function revokeAuthoritySession(
	sessionId: string,
	userId: string,
	options?: AuthorityDecisionOptions,
): Promise<AuthorityWithdrawalResult> {
	const now = new Date();
	const tenantFilter = decisionTenantFilter(options);

	return db.$transaction((tx) =>
		withdrawAuthoritySessionWithin(tx, {
			sessionId,
			userId,
			tenantFilter,
			now,
			requireUnexpired: false,
		}),
	);
}

/**
 * Complete an authority session (run finished normally).
 *
 * Conditional on the session still being live (PENDING or ACTIVE): a revoke,
 * denial or expiry that landed first is the status that holds, and a
 * completion that arrives after it must not relabel the session COMPLETED.
 * Returns whether this call completed it.
 */
export async function completeAuthoritySession(
	sessionId: string,
): Promise<{ completed: boolean }> {
	const result = await db.authoritySession.updateMany({
		where: {
			id: sessionId,
			status: { in: [...DECIDABLE_SESSION_STATUSES] },
		},
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
		},
	});
	return { completed: result.count === 1 };
}

/**
 * Expire authority sessions and grants that have passed their expiresAt.
 * Should be called periodically (e.g., every minute via cron/timer).
 */
export async function expireAuthoritySessions() {
	const now = new Date();

	const [expiredSessions, expiredGrants] = await Promise.all([
		// PENDING as well as ACTIVE: a request nobody answered before its
		// deadline must not stay PENDING (and approvable-looking) forever.
		db.authoritySession.updateMany({
			where: {
				status: { in: [...DECIDABLE_SESSION_STATUSES] },
				expiresAt: { lte: now },
			},
			data: { status: "EXPIRED" },
		}),
		db.authorityGrant.updateMany({
			where: {
				status: { in: ["PENDING", "APPROVED"] },
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
	return db.$transaction((tx) => createAuthorityRequestWithin(tx, input));
}

/** `createAuthorityRequest` for a caller that already holds a transaction. */
async function createAuthorityRequestWithin(
	tx: Prisma.TransactionClient,
	input: CreateAuthorityRequestInput,
) {
	const ttlMinutes = input.ttlMinutes ?? 30;
	const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

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
}

// ─── Run-bound session resolution ───────────────────────────────────────────

/**
 * Advisory-lock class for run-bound authority session resolution. Its own
 * class so a resolution never queues behind an OAuth refresh, a prompt
 * retirement or a workflow reservation that happens to hash to the same
 * object key.
 */
const AUTHORITY_RUN_SESSION_ADVISORY_CLASS = 0x41755273; // "AuRs"

/** The advisory-lock object key for one run's authority session. */
function authorityRunSessionLockKey(run: {
	runType: AuthorityRunType;
	runId: string;
	userId: string;
	organizationId?: string | null;
}): string {
	return [
		"authrun",
		run.runType,
		run.runId,
		run.userId,
		run.organizationId ?? "",
	].join("\u0000");
}

export type AuthoritySessionWithGrants = NonNullable<
	Awaited<ReturnType<typeof findAuthoritySessionForRun>>
>;

export interface FindOrCreateAuthoritySessionForRunInput
	extends Omit<CreateAuthorityRequestInput, "runId"> {
	runId: string;
	/**
	 * Whether a live session already bound to this run satisfies the caller.
	 * When it does not (its grants do not cover what the step needs) a new
	 * request is raised for the run alongside it.
	 */
	covers: (session: AuthoritySessionWithGrants) => boolean;
}

export type FindOrCreateAuthoritySessionForRunResult = {
	session: AuthoritySessionWithGrants;
	/** True when this call raised the request; false when it reused one. */
	created: boolean;
};

/**
 * Find the live authority session bound to one run, or raise one — as one
 * serialized step, so overlapping attempts resolve to the same session.
 *
 * A find-then-create in two statements let two concurrent attempts for the
 * same run (a retried activity racing its first attempt, two workers) both
 * see nothing and both create: two approval requests for one run, one of
 * them orphaned or, worse, competing for the user's decision. The schema
 * has no uniqueness over (runType, runId) — a run legitimately raises a
 * second request when its first does not cover a later step — so the
 * serialization is a transaction-scoped advisory lock keyed on the run and
 * its tenant: the second attempt waits for the first to commit, then finds
 * what it created. Same primitive and `$executeRaw` requirement as the
 * refresh and reservation locks (`pg_advisory_xact_lock()` returns `void`,
 * which `$queryRaw` cannot deserialize). It locks no table row and no
 * other run.
 */
export async function findOrCreateAuthoritySessionForRun(
	input: FindOrCreateAuthoritySessionForRunInput,
): Promise<FindOrCreateAuthoritySessionForRunResult> {
	const orgFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { organizationId: null };
	const lockKey = advisoryObjectKey(
		authorityRunSessionLockKey({
			runType: input.runType,
			runId: input.runId,
			userId: input.userId,
			organizationId: input.organizationId,
		}),
	);

	return db.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTHORITY_RUN_SESSION_ADVISORY_CLASS}::int, ${lockKey}::int)`;

			const existing = await tx.authoritySession.findFirst({
				where: {
					runType: input.runType,
					runId: input.runId,
					userId: input.userId,
					...orgFilter,
					status: { in: [...DECIDABLE_SESSION_STATUSES] },
					expiresAt: { gt: new Date() },
				},
				include: { grants: true },
				orderBy: { requestedAt: "desc" },
			});
			if (existing && input.covers(existing)) {
				return { session: existing, created: false };
			}

			const { covers: _covers, ...request } = input;
			const { session, grants } = await createAuthorityRequestWithin(
				tx,
				request,
			);
			return { session: { ...session, grants }, created: true };
		},
		// A lookup and two inserts are milliseconds; the budget is for
		// waiting on this run's other attempt, never for the run itself.
		{ maxWait: 5_000, timeout: 10_000 },
	);
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
