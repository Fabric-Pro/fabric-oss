/**
 * Publishing Suite — may this actor still drive a generation run on this
 * project?
 *
 * ## Why this predicate lives in @repo/database rather than in the activity
 *
 * The five generation activities used to answer it with
 * `isCurrentOrgMember(actorUserId, organizationId)`, which asks a DIFFERENT
 * question than the one the API gate asked when the run was authorized. The
 * gate is `requireProjectPermission(PUBLISHING_TOPIC_UPDATE)`, whose precedence
 * is owner -> active ProjectMember -> org role. Org membership is only the LAST
 * of those three, so an actor authorized by the second — a project-scoped guest
 * with an EDITOR row, exactly the collaborator the invite flow exists to create
 * — passed the gate, had a GENERATING draft row written for them, and was then
 * refused here. Every time, with a message that said they were "no longer an
 * org member" when they never were one.
 *
 * The re-check has to ask the gate's question. It cannot do that in
 * `@repo/temporal`: that package does not depend on `@repo/permissions` and
 * must not start to, because the permission vocabulary is not a thing a
 * workflow worker should be able to reinterpret. So the ladder and the
 * permission constant stay together on this side of the boundary, and the
 * activity receives a decision rather than a permission set — the same shape
 * `isCurrentOrgMember` gave it.
 *
 * ## The tenant half
 *
 * `organizationId` is captured when the run is queued and travels in the
 * workflow input; it is NOT re-derived when the activity finally runs. Nothing
 * in the product moves a project between organizations today — `PROJECT_TRANSFER`
 * is declared in the permission vocabulary and consumed by nothing — so this
 * half is defence in depth rather than a fix. It is here because
 * `assertProjectTenantTuple`, the same suite's other tenancy guard, already
 * makes exactly this comparison, and because a transfer feature that lands
 * later should find the hole closed rather than have to remember it.
 */

import { hasPermission, Permissions } from "@repo/permissions";
import { resolveProjectAccess } from "./projects";

/**
 * Why a run was refused.
 *
 * Two reasons and not one, because they are two different events for whoever
 * reads the failure: `TENANT_MISMATCH` means the project is not the one this
 * run was authorized against, `NOT_AUTHORIZED` means the person is not.
 */
export type PublishingGenerationActorRefusal =
	| "TENANT_MISMATCH"
	| "NOT_AUTHORIZED";

export type PublishingGenerationActorCheck =
	| { ok: true }
	| {
			ok: false;
			reason: PublishingGenerationActorRefusal;
			/**
			 * The organization that hosts the project NOW, for the operator log.
			 * Equal to the input on `NOT_AUTHORIZED`; the whole point of the
			 * line on `TENANT_MISMATCH`.
			 */
			currentOrganizationId: string | null;
	  };

export async function checkPublishingGenerationActor(input: {
	projectId: string;
	/** The organization the run was authorized under, from the workflow input. */
	organizationId: string | null;
	actorUserId: string;
}): Promise<PublishingGenerationActorCheck> {
	const access = await resolveProjectAccess(
		input.projectId,
		input.actorUserId,
	);

	// A project that no longer exists is a tenant mismatch, not an authorization
	// failure: there is nothing left to be authorized against, and saying "you
	// are not allowed" about a deleted row would be a false statement about a
	// person.
	if (!access) {
		return {
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: null,
		};
	}

	if (access.organizationId !== (input.organizationId ?? null)) {
		return {
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: access.organizationId,
		};
	}

	// The owner short-circuit is not optional decoration — it is what makes this
	// "the gate's question" rather than "a permission lookup that usually agrees
	// with the gate". See `resolveProjectAccess`.
	const authorized =
		access.source === "owner" ||
		hasPermission(access.permissions, Permissions.PUBLISHING_TOPIC_UPDATE);

	return authorized
		? { ok: true }
		: {
				ok: false,
				reason: "NOT_AUTHORIZED",
				currentOrganizationId: access.organizationId,
			};
}
