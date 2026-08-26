/**
 * Signup / sign-in invite reconciliation — auth-layer orchestration wrapper.
 *
 * Bridges the Better Auth trigger points (user create, email verification,
 * session create) to the pure DB-layer `reconcilePendingInvitesForUser`
 * (`@repo/database`): loads the user, gates on a verified email, runs the
 * org-grant side effects (MCP-config seeding, audit row, subscription
 * seats), and emits structured logs for every outcome.
 *
 * Contract: `runInviteReconciliationForUser` NEVER throws — every path
 * resolves. Reconciliation is strictly best-effort: a failure here must
 * never break signup, email verification, or sign-in (mirrors the
 * welcome-email / MCP-seed best-effort blocks in `auth.ts`).
 *
 * Security boundary: the `emailVerified === true` gate is mandatory — an
 * unverified signup claiming someone else's invited email must never
 * consume their invitations. Unverified runs skip silently (info log).
 *
 * Logging hygiene: invitation IDs are logged; invitation/magic-link/
 * verification TOKEN values are never logged (none are even loaded here).
 */
import { seedDefaultMcpConfigsForTenant } from "@repo/agent-core/backend";
import {
	db,
	type ReconcileCreatedOrgMembership,
	reconcilePendingInvitesForUser,
	recordAudit,
} from "@repo/database";
import { logger } from "@repo/logs";
import { updateSeatsInOrganizationSubscription } from "./organization";

/** Which Better Auth hook fired the reconciliation run. */
export type InviteReconciliationTrigger =
	| "user_create"
	| "email_verification"
	| "session_create";

interface ReconciliationUser {
	id: string;
	email: string;
	name: string | null;
	emailVerified: boolean;
}

/**
 * Side effects for ONE reconciliation-created org membership — parity with
 * the manual Better Auth accept path (`afterAcceptInvitation` +
 * `/organization/accept-invitation` after-hook). Runs only for created
 * memberships: never for `already_member` skips and never for project
 * grants (guest-scoped, no org side effects). Each block is individually
 * best-effort so one failure never blocks the others.
 */
async function runOrgGrantSideEffects(params: {
	user: ReconciliationUser;
	grant: ReconcileCreatedOrgMembership;
	trigger: InviteReconciliationTrigger;
}): Promise<void> {
	const { user, grant, trigger } = params;

	// 1. Org-context managed-default MCP configs (idempotent per tuple).
	try {
		await seedDefaultMcpConfigsForTenant({
			userId: user.id,
			organizationId: grant.organizationId,
		});
	} catch (error) {
		logger.error(
			"[Auth] Invite reconciliation: failed to seed default MCP configs",
			{
				trigger,
				userId: user.id,
				organizationId: grant.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	// 2. Audit row — same action the manual accept path emits; `via`
	// distinguishes the reconciliation origin. `recordAudit` is
	// fire-and-forget by signature; the guard is defense-in-depth.
	try {
		recordAudit({
			action: "org.member.invited",
			category: "org",
			actor: {
				type: "user",
				userId: user.id,
				emailSnapshot: user.email ?? null,
				nameSnapshot: user.name ?? null,
			},
			organizationId: grant.organizationId,
			resource: {
				type: "user",
				id: user.id,
				name: user.email ?? null,
			},
			metadata: {
				role: grant.role,
				via: "signup_reconciliation",
				invitationIds: grant.invitationIds,
			},
		});
	} catch (error) {
		logger.error(
			"[Auth] Invite reconciliation: failed to record audit row",
			{
				trigger,
				userId: user.id,
				organizationId: grant.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	// 3. Subscription seat sync — same call the
	// `/organization/accept-invitation` after-hook performs.
	try {
		await updateSeatsInOrganizationSubscription(grant.organizationId);
	} catch (error) {
		logger.error(
			"[Auth] Invite reconciliation: failed to update subscription seats",
			{
				trigger,
				userId: user.id,
				organizationId: grant.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/**
 * Resolve every pending org/project invitation for the user's (verified)
 * email into memberships. Safe to call from any auth hook: resolves on ALL
 * paths — never throws, never blocks the auth flow.
 */
export async function runInviteReconciliationForUser(params: {
	userId: string;
	trigger: InviteReconciliationTrigger;
}): Promise<void> {
	const { userId, trigger } = params;

	try {
		const user = await db.user.findUnique({
			where: { id: userId },
			select: { id: true, email: true, name: true, emailVerified: true },
		});

		if (!user) {
			// Deleted-user race (e.g. account removed between session create
			// and hook execution) — nothing to reconcile.
			logger.warn(
				"[Auth] Invite reconciliation skipped: user not found",
				{
					trigger,
					userId,
				},
			);
			return;
		}

		if (user.emailVerified !== true) {
			// Security boundary: unverified emails never consume invites.
			logger.info(
				"[Auth] Invite reconciliation skipped: email not verified",
				{
					trigger,
					userId,
					reason: "email_unverified",
				},
			);
			return;
		}

		const email = user.email.trim().toLowerCase();
		const result = await reconcilePendingInvitesForUser({ userId, email });

		// Non-blocking anomalies surfaced by the core (e.g. an org invite
		// carrying a teamId — teams are not enabled in this app).
		for (const warning of result.warnings) {
			logger.warn("[Auth] Invite reconciliation anomaly", {
				trigger,
				userId,
				type: warning.type,
				invitationId: warning.invitationId,
				organizationId: warning.organizationId,
				code: warning.code,
				teamId: warning.teamId,
			});
		}

		// Per-skip outcome. Isolated per-group/per-row failures (reason
		// "error") log at error level — they were swallowed by the core so
		// the run could continue; this is where they surface.
		for (const skip of result.skipped) {
			if (skip.reason === "error") {
				logger.error("[Auth] Invite reconciliation: invite failed", {
					trigger,
					userId,
					type: skip.type,
					invitationId: skip.invitationId,
					reason: skip.reason,
					message: skip.message,
				});
			} else {
				logger.info("[Auth] Invite reconciliation: invite skipped", {
					trigger,
					userId,
					type: skip.type,
					invitationId: skip.invitationId,
					reason: skip.reason,
				});
			}
		}

		// Org grants: per-grant log + side-effect parity with the manual
		// accept path. Side effects fire ONLY for created memberships.
		for (const grant of result.createdOrgMemberships) {
			logger.info("[Auth] Invite reconciliation created org membership", {
				trigger,
				userId,
				organizationId: grant.organizationId,
				memberId: grant.memberId,
				role: grant.role,
				invitationIds: grant.invitationIds,
			});
			await runOrgGrantSideEffects({ user, grant, trigger });
		}

		// Project grants: guest-scoped — log only, no side effects (parity
		// with the manual project accept path, which records no audit row
		// and has no seat impact).
		for (const grant of result.createdProjectMemberships) {
			logger.info(
				"[Auth] Invite reconciliation created project membership",
				{
					trigger,
					userId,
					projectId: grant.projectId,
					memberId: grant.memberId,
					role: grant.role,
					invitationIds: [grant.invitationId],
				},
			);
		}

		// Completion summary. The all-zero no-op logs at debug to keep
		// per-sign-in noise low; any run that found >= 1 invite logs info.
		const summary = {
			trigger,
			userId,
			email,
			orgInvitesFound: result.orgInvitesFound,
			orgMembershipsCreated: result.orgMembershipsCreated,
			projectInvitesFound: result.projectInvitesFound,
			projectMembershipsCreated: result.projectMembershipsCreated,
			skippedCount: result.skipped.length,
		};
		if (result.orgInvitesFound === 0 && result.projectInvitesFound === 0) {
			logger.debug("[Auth] Invite reconciliation no-op", summary);
		} else {
			logger.info("[Auth] Invite reconciliation completed", summary);
		}
	} catch (error) {
		// Last line of defense: reconciliation must NEVER break an auth
		// flow. Log and resolve.
		logger.error("[Auth] Invite reconciliation failed", {
			trigger,
			userId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
