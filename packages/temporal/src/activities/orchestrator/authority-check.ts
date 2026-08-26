/**
 * Authority Check Activity
 *
 * Temporal activity that evaluates the authority policy for a step.
 * This wraps evaluateAuthorityPolicy() as a Temporal activity so it
 * can be called from workflow code (which cannot directly import DB queries).
 *
 * Called by the orchestrator execution phase before each step to ensure
 * runtime authority exists for all required providers.
 */

import {
	approveAuthoritySession,
	createAuthorityRequest,
	denyAuthoritySession,
	findActiveAuthoritySession,
	getAuthoritySession,
	listMcpConfigsForTenant,
	resolveCanonicalProviderKey,
	revokeAuthoritySession,
} from "@repo/database";
import {
	type AuthorityPolicyResult,
	evaluateAuthorityPolicy,
	extractRequiredProviders,
} from "./approval/authority-policy";
import { loadTrustConfiguration } from "./approval/trust-manager";
import { classifyToolAccessLevel } from "./execution/authority-gate";

export interface CheckStepAuthorityInput {
	userId: string;
	organizationId?: string;
	executionId?: string;
	step: {
		id: string;
		description: string;
		type: string;
		status: string;
		order: number;
		riskLevel?: string;
		requiresApproval?: boolean;
		approvalId?: string;
		capability?: string;
		executor?: string;
		app?: string;
		toolsToUse?: string[];
	};
	/** MCP tool configs discovered during tool loading */
	toolToConfig?: Record<string, { serverName?: string; configId: string }>;
	/** Matched integrations from routing */
	matchedIntegrations?: Array<{ provider: string }>;
}

export interface CheckStepAuthorityOutput {
	allowed: boolean;
	blockedBy?: string;
	blockedDetails?: {
		providerKey?: string;
		requiredAccessLevel?: string;
		riskLevel?: string;
		message: string;
	};
	trustAutoApproved?: boolean;
	/** If authority was missing, an authority session was auto-created for approval */
	authoritySessionId?: string;
}

/**
 * Temporal activity: evaluate authority policy for a step.
 *
 * Returns whether the step is allowed to proceed and why not if blocked.
 */
export async function checkStepAuthorityActivity(
	input: CheckStepAuthorityInput,
): Promise<CheckStepAuthorityOutput> {
	const {
		userId,
		organizationId,
		executionId,
		step,
		toolToConfig,
		matchedIntegrations,
	} = input;

	// Extract required providers from step context
	let requiredProviders = extractRequiredProviders(
		step as any,
		toolToConfig,
		matchedIntegrations,
	);

	// If extractRequiredProviders returned nothing but the step may use MCP tools,
	// derive providers from the user's enabled MCP configs. This handles the common
	// case where the workflow passes step.toolsToUse but no toolToConfig mapping.
	//
	// Only check when the step is likely to use MCP tools:
	// - capability is "mcp_tool" or unset (defaults to mcp_tool in handler registry)
	// - step has explicit toolsToUse
	// Skip for: llm, web, agent, workflow capabilities (they don't use MCP)
	const mayUseMcpTools =
		!step.capability ||
		step.capability === "mcp_tool" ||
		(step.toolsToUse && step.toolsToUse.length > 0);

	if (requiredProviders.length === 0 && mayUseMcpTools) {
		try {
			const configs = await listMcpConfigsForTenant({
				userId,
				organizationId,
			});
			const enabledConfigs = configs.filter((c) => c.enabled);

			if (enabledConfigs.length > 0) {
				const seen = new Set<string>();
				const fromConfigs: Array<{
					providerKey: string;
					accessLevel: "READ" | "WRITE";
				}> = [];

				for (const config of enabledConfigs) {
					const serverKey =
						config.mcpServer?.key?.toLowerCase() ?? config.id;
					const providerKey = resolveCanonicalProviderKey(serverKey);
					if (!seen.has(providerKey)) {
						seen.add(providerKey);
						// If step has specific tools, classify access; otherwise default to WRITE
						const accessLevel = step.toolsToUse?.[0]
							? classifyToolAccessLevel(step.toolsToUse[0])
							: ("WRITE" as const);
						fromConfigs.push({ providerKey, accessLevel });
					}
				}
				requiredProviders = fromConfigs;
			}
		} catch (error) {
			console.error(
				"[AuthorityCheck] Failed to load MCP configs for provider resolution:",
				error,
			);
		}
	}

	// If no external providers needed, allow immediately
	if (requiredProviders.length === 0) {
		return { allowed: true };
	}

	// Load trust configuration for the user
	let trustConfig = null;
	try {
		trustConfig = await loadTrustConfiguration(
			userId,
			organizationId || undefined,
		);
	} catch {
		// Trust config is optional — continue without it
	}

	// Evaluate the unified authority policy
	const result: AuthorityPolicyResult = await evaluateAuthorityPolicy({
		step: step as any,
		userId,
		organizationId,
		executionId,
		requiredProviders,
		trustConfig,
	});

	// If authority is missing, auto-create a pending authority session
	// so the user sees an approval request in the Fabric UI
	if (!result.allowed && result.blockedBy === "authority_missing") {
		try {
			// Check if there's already a pending session for this execution
			const existing = await findActiveAuthoritySession(
				userId,
				organizationId || undefined,
				"ORCHESTRATOR",
			);

			if (!existing) {
				const { session: newSession } = await createAuthorityRequest({
					userId,
					organizationId: organizationId || undefined,
					runType: "ORCHESTRATOR",
					runId: executionId,
					ttlMinutes: 30,
					grants: requiredProviders.map((p) => ({
						providerType: "MCP" as const,
						providerKey: p.providerKey,
						providerDisplayName: p.providerKey,
						accessLevel: p.accessLevel,
					})),
				});

				return {
					allowed: false,
					blockedBy: result.blockedBy,
					blockedDetails: {
						...result.blockedDetails,
						message: `Runtime authority required. An approval request has been created (session ${newSession.id}). Approve in Fabric UI to continue.`,
					},
					authoritySessionId: newSession.id,
				};
			}
		} catch (error) {
			// If auto-creation fails, still return the blocked result
			console.error(
				"[AuthorityCheck] Failed to auto-create authority session:",
				error,
			);
		}
	}

	return {
		allowed: result.allowed,
		blockedBy: result.blockedBy,
		blockedDetails: result.blockedDetails,
		trustAutoApproved: result.trustAutoApproved,
	};
}

/**
 * Load the session this step raised and confirm it is still owned by the
 * deciding user in the same tenant.
 *
 * `approveAuthoritySession` / `denyAuthoritySession` update by id alone and
 * leave ownership, tenant and status to the caller — the same contract the
 * approval API honours before calling them. A session the workflow cannot
 * find under this identity is an anomaly, not a decision outcome, so it
 * throws; what to do about a session that is no longer PENDING differs
 * between approving and denying, and is left to each caller.
 */
async function loadDecidableSession(input: {
	authoritySessionId: string;
	userId: string;
	organizationId?: string;
}): Promise<{ status: string; expiresAt: Date }> {
	const session = await getAuthoritySession(
		input.authoritySessionId,
		input.userId,
		input.organizationId,
	);

	if (!session) {
		throw new Error(
			`Authority session ${input.authoritySessionId} not found for this user and tenant`,
		);
	}

	return session;
}

/**
 * Temporal activity: approve an authority session when the user approves
 * the orchestrator step that required authority.
 */
export async function approveAuthoritySessionActivity(input: {
	authoritySessionId: string;
	userId: string;
	organizationId?: string;
	instructions?: string;
}): Promise<{ success: boolean }> {
	// This path waits on a human, so the session can be revoked or expire
	// while it waits. Approving it anyway would resurrect it to ACTIVE with no
	// PENDING grants left to approve — a live session nobody granted.
	//
	// ACTIVE is the exception, and has to be: activities are at-least-once, so
	// a completion lost after the approval transaction committed leaves a
	// retry looking at its own successful work. Treating that as a conflict
	// would fail a run whose authority was granted correctly. The activity's
	// postcondition is "this session is approved", and for an ACTIVE session
	// it already holds.
	const session = await loadDecidableSession(input);

	// `expireAuthoritySessions` only sweeps ACTIVE sessions, so a PENDING one
	// can sit past its expiry indefinitely — which is exactly what happens
	// when a human answers slowly. Approving it would mint an ACTIVE session
	// that is already expired. `findActiveAuthoritySession` filters on
	// `expiresAt`, so such a session grants nothing at the point of use, but
	// the approval should not claim otherwise either.
	if (session.expiresAt.getTime() <= Date.now()) {
		throw new Error(
			`Authority session ${input.authoritySessionId} expired at ${session.expiresAt.toISOString()}; refusing to approve`,
		);
	}

	if (session.status === "ACTIVE") return { success: true };
	if (session.status !== "PENDING") {
		throw new Error(
			`Authority session ${input.authoritySessionId} is ${session.status}; refusing to approve`,
		);
	}

	// Deliberately unguarded from here: the caller executes the step
	// immediately after this returns and does not re-check authority, so
	// swallowing a failure would run the step with the session still PENDING —
	// authority failing open. Letting the error out gives Temporal its retries
	// and, if the write genuinely cannot land, fails the step instead of
	// privileging it.
	await approveAuthoritySession(
		input.authoritySessionId,
		input.userId,
		input.instructions,
	);
	return { success: true };
}

/**
 * Temporal activity: deny an authority session when the user rejects
 * the orchestrator step that required authority.
 */
export async function denyAuthoritySessionActivity(input: {
	authoritySessionId: string;
	userId: string;
	organizationId?: string;
	reason?: string;
}): Promise<{ success: boolean }> {
	// A session that is already REVOKED, EXPIRED or COMPLETED grants nothing,
	// so denying it again is a no-op — and failing here would take down a run
	// for the ordinary sequence of a user revoking authority in the UI and
	// then declining the step.
	//
	// ACTIVE is not in that set: a session approved out-of-band (through the
	// approval UI) before the step was declined still grants authority, and
	// declining the step has to withdraw it.
	const session = await loadDecidableSession(input);
	if (session.status !== "PENDING" && session.status !== "ACTIVE") {
		return { success: true };
	}

	// Errors propagate from here for the same reason as the approve path, with
	// a milder consequence: a swallowed failure leaves the session PENDING
	// rather than REVOKED, so a request the user explicitly declined outlives
	// the step that raised it and stays available to approve later.
	if (session.status === "ACTIVE") {
		// `denyAuthoritySession` only transitions PENDING grants, so on an
		// already-approved session it would revoke the session while leaving
		// its grants APPROVED. Revoking is the transition that covers those.
		await revokeAuthoritySession(input.authoritySessionId);
	} else {
		await denyAuthoritySession(
			input.authoritySessionId,
			input.userId,
			input.reason,
		);
	}
	return { success: true };
}
