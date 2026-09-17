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
	AuthoritySessionConflictError,
	approveAuthoritySession,
	denyAuthoritySession,
	findOrCreateAuthoritySessionForRun,
	listMcpConfigsForTenant,
	resolveCanonicalProviderKey,
} from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import { AUTHORITY_CHECK_FAILED } from "../../workflows/orchestrator/orchestrator-config";
import {
	type AuthorityPolicyResult,
	evaluateAuthorityPolicy,
	extractRequiredProviders,
} from "./approval/authority-policy";
import { loadTrustConfiguration } from "./approval/trust-manager";
import { maxToolAccessLevel } from "./execution/authority-gate";

export { AUTHORITY_CHECK_FAILED };

/**
 * Failure type for an authority activity invoked without an organization.
 * Non-retryable: the run's tenant does not appear on retry.
 */
export const AUTHORITY_ORGANIZATION_MISSING = "AuthorityOrganizationMissing";

/**
 * The organization an authority activity acts in, or a non-retryable failure.
 *
 * Runtime authority is tenant state: the session, its grants and the MCP
 * configs that decide which providers a step reaches all live in an
 * organization (ADR-018, organization is the only tenant context). The
 * inputs kept `organizationId` optional and mapped its absence to the
 * personal, organization-less arm, so a starter that lost the organization
 * would have its authority checked, approved or denied against rows no
 * tenant can see. Every orchestrator starter now resolves an organization
 * before it starts a run; an activity that still receives none fails the
 * step rather than entering that arm.
 */
function requireOrganization(
	organizationId: string | undefined,
	activity: string,
): string {
	if (organizationId) {
		return organizationId;
	}
	throw ApplicationFailure.nonRetryable(
		`${activity}: no organization on the run. Runtime authority is organization-scoped (ADR-018); the run must be started from an organization.`,
		AUTHORITY_ORGANIZATION_MISSING,
	);
}

export interface CheckStepAuthorityInput {
	userId: string;
	/** The run's organization. Required; see `requireOrganization`. */
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
	/**
	 * Policy outcome (`authority_missing`, `step_approval_required`) or
	 * `AUTHORITY_CHECK_FAILED` when the check itself could not be completed.
	 */
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
	const { userId, executionId, step, toolToConfig, matchedIntegrations } =
		input;
	const organizationId = requireOrganization(
		input.organizationId,
		"Authority check",
	);

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

				// Without a tool->config mapping every enabled provider is a
				// candidate, so each gets the level of the most privileged tool
				// in the step. `maxToolAccessLevel` returns WRITE for an empty
				// list, which covers steps that name no tools at all.
				const accessLevel = maxToolAccessLevel(step.toolsToUse ?? []);

				for (const config of enabledConfigs) {
					const serverKey =
						config.mcpServer?.key?.toLowerCase() ?? config.id;
					const providerKey = resolveCanonicalProviderKey(serverKey);
					if (!seen.has(providerKey)) {
						seen.add(providerKey);
						fromConfigs.push({ providerKey, accessLevel });
					}
				}
				requiredProviders = fromConfigs;
			}
		} catch (error) {
			// Fail closed. If the tenant's MCP configs cannot be read we do not
			// know which providers this step reaches, and "no providers found"
			// would fall straight through to `allowed: true` below - running the
			// step with whatever external access its tools carry and no
			// authority check at all. Report the failure as a block instead; the
			// workflow surfaces it as a step error rather than an approval prompt.
			const message =
				error instanceof Error ? error.message : String(error);
			console.error(
				"[AuthorityCheck] Failed to load MCP configs for provider resolution:",
				error,
			);
			return {
				allowed: false,
				blockedBy: AUTHORITY_CHECK_FAILED,
				blockedDetails: {
					message: `Authority check could not determine the providers this step requires (${message}). The step was not run.`,
				},
			};
		}
	}

	// If no external providers needed, allow immediately
	if (requiredProviders.length === 0) {
		return { allowed: true };
	}

	// Load trust configuration for the user
	let trustConfig = null;
	try {
		trustConfig = await loadTrustConfiguration(userId, organizationId);
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

	// If authority is missing, resolve the pending authority session for
	// THIS run — reusing one this run already raised, or creating one — so
	// the user sees an approval request in the Fabric UI and the workflow
	// always knows which session the decision activates.
	if (!result.allowed && result.blockedBy === "authority_missing") {
		// Errors here propagate: the workflow only treats `authority_missing`
		// as an approvable checkpoint when it carries a session id, and it
		// fails the step otherwise. Returning the blocked result without an id
		// would make an unrelated lookup failure look like a decision the
		// user already took.
		if (!executionId) {
			throw new Error(
				"Authority check: cannot resolve a run-bound authority session without an executionId",
			);
		}
		const sessionId = await resolveAuthoritySessionForRun({
			userId,
			organizationId,
			executionId,
			requiredProviders,
		});

		return {
			allowed: false,
			blockedBy: result.blockedBy,
			blockedDetails: {
				...result.blockedDetails,
				message: `Runtime authority required. An approval request has been created (session ${sessionId}). Approve in Fabric UI to continue.`,
			},
			authoritySessionId: sessionId,
		};
	}

	return {
		allowed: result.allowed,
		blockedBy: result.blockedBy,
		blockedDetails: result.blockedDetails,
		trustAutoApproved: result.trustAutoApproved,
	};
}

/**
 * Find or raise the authority session bound to this run.
 *
 * A session raised by another concurrent run must not stand in for this
 * one: the workflow activates the session it is handed, so handing it
 * nothing (because "a session already exists") lets the step fall through
 * to plain step approval and run with no authority at all. The lookup is
 * keyed on the run, and an existing session is only reused when its grants
 * cover every provider this step needs at the required level; lookup and
 * creation are one locked step in the database so two attempts for the
 * same run never raise two requests.
 */
async function resolveAuthoritySessionForRun(input: {
	userId: string;
	organizationId: string;
	executionId: string;
	requiredProviders: Array<{
		providerKey: string;
		accessLevel: "READ" | "WRITE";
	}>;
}): Promise<string> {
	// One serialized find-or-create per run: overlapping attempts (a
	// retried activity racing its first attempt) resolve to the same
	// session instead of each raising their own request.
	const { session } = await findOrCreateAuthoritySessionForRun({
		userId: input.userId,
		organizationId: input.organizationId,
		runType: "ORCHESTRATOR",
		runId: input.executionId,
		ttlMinutes: 30,
		grants: input.requiredProviders.map((p) => ({
			providerType: "MCP" as const,
			providerKey: p.providerKey,
			providerDisplayName: p.providerKey,
			accessLevel: p.accessLevel,
		})),
		covers: (existing) =>
			sessionCoversProviders(existing, input.requiredProviders),
	});
	return session.id;
}

/**
 * True when every required provider has a live (PENDING or APPROVED) grant
 * on the session at the required access level or higher.
 */
export function sessionCoversProviders(
	session: {
		grants: Array<{
			providerKey: string;
			accessLevel: "READ" | "WRITE";
			status: string;
		}>;
	},
	required: Array<{ providerKey: string; accessLevel: "READ" | "WRITE" }>,
): boolean {
	return required.every((need) =>
		session.grants.some(
			(grant) =>
				(grant.status === "PENDING" || grant.status === "APPROVED") &&
				resolveCanonicalProviderKey(grant.providerKey) ===
					resolveCanonicalProviderKey(need.providerKey) &&
				(need.accessLevel === "READ" || grant.accessLevel === "WRITE"),
		),
	);
}

/**
 * Temporal activity: approve an authority session when the user approves
 * the orchestrator step that required authority.
 *
 * Ownership, tenant, status and expiry are all checked inside the database
 * transition (`approveAuthoritySession` only lands on a PENDING, unexpired
 * session of this user in this tenant), so a revoke, deny or expiry that
 * races this decision is never overwritten. A session that is already
 * ACTIVE is a retry of an approval that committed and succeeds again.
 *
 * Any other state is a conflict, not a transient fault: retrying cannot
 * make a REVOKED session approvable, so the failure is non-retryable and
 * the workflow fails the step instead of running it.
 */
export async function approveAuthoritySessionActivity(input: {
	authoritySessionId: string;
	userId: string;
	organizationId?: string;
	instructions?: string;
}): Promise<{ success: boolean }> {
	const organizationId = requireOrganization(
		input.organizationId,
		"Authority approval",
	);
	try {
		await approveAuthoritySession(
			input.authoritySessionId,
			input.userId,
			input.instructions,
			{ organizationId },
		);
	} catch (error) {
		if (error instanceof AuthoritySessionConflictError) {
			throw ApplicationFailure.nonRetryable(
				error.message,
				"AuthoritySessionConflict",
			);
		}
		throw error;
	}
	return { success: true };
}

/**
 * Temporal activity: deny an authority session when the user rejects
 * the orchestrator step that required authority.
 *
 * The transition (`denyAuthoritySession`) is conditional on PENDING or
 * ACTIVE and unexpired: a session that is already REVOKED or COMPLETED
 * grants nothing, so denying it again is a no-op rather than a failure — the
 * ordinary sequence of a user revoking authority in the UI and then
 * declining the step must not take down the run. A session past its
 * deadline is settled as EXPIRED and reported as `success: false,
 * outcome: "expired"`, never as a successful denial. An ACTIVE session (one
 * approved out-of-band before the step was declined) is withdrawn with its
 * grants. A session this user cannot see in this tenant is an anomaly and
 * fails the activity.
 */
export async function denyAuthoritySessionActivity(input: {
	authoritySessionId: string;
	userId: string;
	organizationId?: string;
	reason?: string;
}): Promise<{
	success: boolean;
	outcome: "withdrawn" | "expired" | "already-final";
}> {
	const organizationId = requireOrganization(
		input.organizationId,
		"Authority denial",
	);
	let result: Awaited<ReturnType<typeof denyAuthoritySession>>;
	try {
		result = await denyAuthoritySession(
			input.authoritySessionId,
			input.userId,
			input.reason,
			{ organizationId },
		);
	} catch (error) {
		if (error instanceof AuthoritySessionConflictError) {
			throw ApplicationFailure.nonRetryable(
				error.message,
				"AuthoritySessionConflict",
			);
		}
		throw error;
	}
	if (result.outcome === "expired") {
		// Not a denial: the request ran out before the decision. The step is
		// skipped either way (the user declined it), so the run is not failed;
		// the result says what actually happened instead of claiming success.
		console.warn(
			"[AuthorityCheck] Authority session expired before it was denied",
			{ authoritySessionId: input.authoritySessionId },
		);
		return { success: false, outcome: "expired" };
	}
	return { success: true, outcome: result.outcome };
}
