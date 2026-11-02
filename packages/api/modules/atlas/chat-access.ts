import { assertInputOrgMatchesProject } from "../../lib/authorized-project-tenant";
import {
	assertProjectPermission,
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
 * Every check `atlas.chat` makes, in the procedure's order, for the agent
 * runtime's `atlas-chat` engine. The request runs in `caller.organizationId`,
 * which the runtime endpoint tie-checked.
 */
export async function authorizeAtlasChat(
	caller: { userId: string; organizationId: string },
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
	// AI_CHAT in the organization the turn runs in, as the runtime checks a
	// conversation write (`thread.ts`). `requirePermission` reads the
	// session's role from the oRPC tenant context, which a runtime request
	// has none of. This is the project's organization (checked above), so a
	// member whose session's active organization is another one, where they
	// lack AI_CHAT, is admitted here and refused by `atlas.chat`.
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
