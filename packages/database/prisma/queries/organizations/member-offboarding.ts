/**
 * Revoke one person's access to one organization.
 *
 * Offboarding has two halves and they have very different consequences if they
 * are lost. Revoking ACCESS is the half that must not be: while a
 * `ProjectMember` row survives, its holder is still authorized on that project
 * by the ladder `requireProjectPermission` walks (owner -> active
 * ProjectMember -> org role), and org membership is only the LAST rung. Since
 * `checkPublishingGenerationActor` began mirroring that ladder, such a row is by
 * itself enough to spend the organization's model budget with no org membership
 * at all. Deleting the owned DATA is the other half — heavy, batched, and
 * legitimately a background job (`memberCascadeDeleteWorkflow`).
 *
 * This function is only the first half, so a caller can do it inline and let
 * the second half be a workflow that may or may not start.
 *
 * EVERY STATEMENT IS IDEMPOTENT — `deleteMany` / `updateMany` over predicates,
 * never a read-then-write. That is what lets the cascade workflow run the same
 * deletions again a second later without conflicting, and lets a caller retry
 * without checking what already happened. The predicates are deliberately the
 * same ones `clearUserOrgSessionsActivity`,
 * `removeUserProjectMembershipsInOrgActivity` and
 * `removeUserWorkspaceMembershipsInOrgActivity` use; if one side ever changes
 * its definition of "access", the two must move together.
 *
 * Scoped to ONE organization on both sides of every join. A user normally
 * belongs to several, and the personal-tenant rows (`organizationId: null`) are
 * somebody's own workspaces — a predicate that matched on `userId` alone would
 * empty those too.
 */

import { db } from "../../client";

export interface RevokeOrganizationMemberAccessInput {
	organizationId: string;
	userId: string;
}

export interface RevokeOrganizationMemberAccessResult {
	/** `ProjectMember` rows deleted across the organization's projects. */
	projectMemberships: number;
	/** Administrator + contributor + stakeholder rows, summed. */
	workspaceMemberships: number;
	/** Sessions whose `activeOrganizationId` pointed at this organization. */
	sessionsCleared: number;
}

export async function revokeOrganizationMemberAccess(
	input: RevokeOrganizationMemberAccessInput,
): Promise<RevokeOrganizationMemberAccessResult> {
	const { organizationId, userId } = input;

	// Sessions first. It is the cheapest statement and the one that stops an
	// in-flight request from resolving the organization it is losing; the
	// deletions below can then race nothing that still has org context.
	//
	// `updateMany`, not the single session better-auth clears on its way out:
	// `leaveOrganization` clears only the token that made the request, so a
	// second browser signed in as the same person keeps pointing at the
	// organization it has just left.
	const sessions = await db.session.updateMany({
		where: { userId, activeOrganizationId: organizationId },
		data: { activeOrganizationId: null },
	});

	const projects = await db.project.findMany({
		where: { organizationId },
		select: { id: true },
	});
	const projectIds = projects.map((project) => project.id);

	const projectMemberships = projectIds.length
		? (
				await db.projectMember.deleteMany({
					where: { userId, projectId: { in: projectIds } },
				})
			).count
		: 0;

	const workspaces = await db.workspace.findMany({
		where: { organizationId },
		select: { id: true },
	});
	const workspaceIds = workspaces.map((workspace) => workspace.id);

	// All three membership tables, because a person can hold more than one role
	// on the same workspace and each table is a separate grant. Dropping only
	// the administrator row would leave contributor access intact and look, from
	// the outside, like offboarding had worked.
	let workspaceMemberships = 0;
	if (workspaceIds.length) {
		const scope = { userId, workspaceId: { in: workspaceIds } };
		const [administrators, contributors, stakeholders] = await Promise.all([
			db.workspaceAdministrator.deleteMany({ where: scope }),
			db.workspaceContributor.deleteMany({ where: scope }),
			db.workspaceStakeholder.deleteMany({ where: scope }),
		]);
		workspaceMemberships =
			administrators.count + contributors.count + stakeholders.count;
	}

	return {
		projectMemberships,
		workspaceMemberships,
		sessionsCleared: sessions.count,
	};
}
