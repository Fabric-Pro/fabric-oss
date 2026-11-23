import { assertInputOrgMatchesProject } from "../../lib/authorized-project-tenant";
import {
	assertProjectPermission,
	assertSessionOrganizationPermission,
	authorizeInputOrganization,
	Permissions,
} from "../../orpc/procedures";
import { assertCapabilityAvailable } from "../capabilities/assert";
import { assertAtlasEnabled } from "./lib";

/**
 * Who may ask the Atlas codebase chat, as one set of checks for both of its
 * doors: the `atlas.chat` / `atlas.systemChat` procedures (through their
 * middleware and handler) and the agent runtime's `atlas-chat` engine
 * (through `authorizeAtlasChat`).
 */

/**
 * Codebase Q&A must be available. Both chat procedures call it after
 * `assertAtlasEnabled`, outside the try whose catch maps Atlas errors, so the
 * gate's refusal (and its `data.gate`) reaches the caller unchanged.
 */
export async function admitAtlasChat(request: {
	projectId: string;
	userId: string;
	organizationId: string | null;
}): Promise<void> {
	await assertCapabilityAvailable({
		capabilityKey: "atlas.codebase-qa",
		...request,
	});
}

/**
 * Every check `atlas.chat` makes, for the agent runtime's `atlas-chat`
 * engine. The request runs in `caller.organizationId`, which the runtime
 * endpoint tie-checked; `activeOrganizationId` is the organization the
 * caller's session names, whose role `atlas.chat` judges.
 *
 * The order differs from the procedure's. There the tenant middleware first
 * refuses a session naming an organization the caller has left or that is
 * deleted; project access and then AI_CHAT on the session's role follow.
 * Here the checks run as: project access (PROJECT_READ), the request's
 * organization against the project's, the session's organization (left,
 * deleted, or no AI_CHAT), AI_CHAT in the request's organization, Atlas
 * enabled, then Codebase Q&A available. A caller refused by more than one
 * check can therefore see a different refusal here than from `atlas.chat`;
 * whether they are refused does not change.
 */
export async function authorizeAtlasChat(
	caller: {
		userId: string;
		organizationId: string;
		activeOrganizationId: string | null;
	},
	projectId: string,
): Promise<void> {
	// `requireProjectPermission`'s check: NOT_FOUND first (a caller with no tie
	// to the project), then a deleted organization, then FORBIDDEN.
	const project = await assertProjectPermission(
		projectId,
		caller.userId,
		Permissions.PROJECT_READ,
	);
	// The refusal the middleware gives a request that names another
	// organization than the project's.
	assertInputOrgMatchesProject(caller.organizationId, project);
	// AI_CHAT as `atlas.chat`'s `requirePermission` judges it: on the role in
	// the organization the session names. A member whose session names
	// another organization, where they lack AI_CHAT, is refused here as
	// there.
	await assertSessionOrganizationPermission(Permissions.AI_CHAT, caller);
	// And in the organization the turn runs in, the project's (checked
	// above), as the runtime checks a conversation write (`thread.ts`).
	await authorizeInputOrganization(
		Permissions.AI_CHAT,
		caller.organizationId,
		{
			user: { id: caller.userId },
			session: { activeOrganizationId: caller.organizationId },
		},
		{ requireOrganization: true },
	);
	assertAtlasEnabled();
	await admitAtlasChat({
		projectId,
		userId: caller.userId,
		organizationId: caller.organizationId,
	});
}
