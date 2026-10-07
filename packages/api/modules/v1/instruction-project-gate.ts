/**
 * The object-level gate every v1 coding-instructions route runs for a project,
 * after `requireScope("instructions:read")` and never instead of it.
 *
 * Shared by the project-scoped routes in `instructions.ts` and by the checkout
 * resolver, which has no project in its path but must put every project a
 * repository URL matches through this same gate before it says anything about
 * it.
 */
import { db, hasProjectAccess } from "@repo/database";
import { hasPermission, type Permission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../lib/effective-project-permissions";
import {
	credentialMayReachProject,
	type ExternalApiContext,
	isOrganizationBoundKey,
} from "../external-api/types";
import { forbidden, notFound } from "./helpers";

export type ResolvedProject =
	| { error: { message: string }; status: 400 | 403 | 404 }
	| { userId: string; organizationId: string };

/**
 * The object-level gate, run after `requireScope("instructions:read")` and
 * never instead of it (AGENTS.md: every API-key surface checks the key's
 * declared scope AND the creator's live permission, wildcard keys included).
 *
 * ## The project supplies the tenant, not the request
 *
 * This route does NOT go through `resolveV1Context`, and that is the whole
 * point rather than an omission. Every coding-instructions surface is
 * project-scoped, so the only organization any of them may act in is the
 * project's own — the oRPC twin resolves exactly that with
 * `requireHostingOrganizationId`, and the MCP gateway's
 * `resolvePublishedInstructionSnapshot` compares against the project's
 * hosting organization and says so in as many words: "so invited guests keep
 * access and cross-org IDs fail as 404".
 *
 * `resolveV1Context` answers a different question — which organization does
 * THIS CALLER belong to — and it refuses a caller who belongs to none of
 * them. An invited project guest holds an accepted `ProjectMember` row and
 * no membership in the host organization, so they pass the browser and the
 * MCP gateway and were refused here, for a project they can open in the app.
 *
 * ## What each key type still has to prove
 *
 * - ANY key: `resolveEffectiveProjectPermissions` — the SAME resolver
 *   `requireProjectPermission(Permissions.INSTRUCTION_READ)` runs for the
 *   oRPC twin (`orpc/middleware/require-permission.ts` →
 *   `assertProjectPermission`) — must grant `INSTRUCTION_READ`. That is what
 *   keeps this API neither broader nor narrower than the tab, and it is
 *   deliberately not `getProjectAccessById`, which matches only the owner or
 *   a `ProjectMember` row and would refuse an organization admin the browser
 *   admits.
 * - An ORGANIZATION key stays bound to its own organization: the project's
 *   hosting organization must equal the key's. An org key is minted for one
 *   tenant and must never read another's project, guest grant or not.
 * - A PERSONAL key is bound by the project access above and nothing else,
 *   which is precisely the browser's rule for the same person.
 *
 * A project whose hosting organization does not match an organization key is
 * NOT FOUND, never forbidden: a caller must not learn from this that a
 * project id exists in someone else's tenant. A personal project resolves
 * `organizationId: null`, which no organization id can equal — the
 * fail-closed arm, and the only answer an organization-only surface may give
 * it.
 *
 * ## An explicit context still binds
 *
 * `?org=<slug>` and `?personal=1` are the request's own statement of which
 * tenant it means. Taking the project's word for the organization is what
 * keeps an invited guest working; ignoring an explicit context that
 * CONTRADICTS it would make this route answer a question nobody asked. So a
 * named organization is resolved and must equal the project's — 404
 * otherwise, the same answer an organization key gets for someone else's
 * project — and `?personal=1` is refused outright, because this surface has
 * no personal arm to select.
 *
 * The slug is resolved WITHOUT a membership check on purpose. Membership is
 * what `resolveV1Context` requires and exactly what shuts an invited guest
 * out; here the slug is only ever used to compare against an organization the
 * caller has already proven project access to — which is why that lookup
 * happens only after the permission check, and why an unknown slug and a
 * mismatched one get the same generic 404.
 *
 * Unlike `resolveV1Context`, `?personal=1` is a refusal rather than an
 * accepted no-op. That no-op exists to keep clients already in the field
 * working through a tenancy change; this surface shipped after it, so there
 * are none, and a coding-instructions request naming a personal context is a
 * mistake worth reporting.
 */
export async function resolveInstructionProject(
	projectId: string,
	apiCtx: ExternalApiContext,
	requested: {
		org?: string;
		personal: boolean;
		requiredPermission?: Permission;
	},
): Promise<ResolvedProject> {
	if (requested.personal) {
		return {
			error: {
				message:
					"Coding instructions are an organization surface; ?personal=1 is not supported",
			},
			status: 403,
		};
	}

	// An agent that signed in for one project reaches that project alone, and
	// hears of any other as it hears of one that does not exist. Asked before
	// anything is read, so no lookup runs for a project it may not reach.
	if (!credentialMayReachProject(apiCtx, projectId)) {
		return { error: notFound("Project").error, status: 404 };
	}

	const access = await resolveEffectiveProjectPermissions(
		projectId,
		apiCtx.userId,
	);
	// A caller with no tie to the project at all — not its owner, no active
	// ProjectMember row, not a member of its host organization — is answered
	// as a missing project is, in the same words. An organization key already
	// got that from the hosting-organization comparison below; a PERSONAL key
	// skips that comparison, and without this it reached the permission check
	// and heard 403, which told it the project exists (Fizzy #2639). Same
	// rule as `assertProjectPermission` on the oRPC twin.
	if (!access || access.source === "none") {
		return { error: notFound("Project").error, status: 404 };
	}
	// An organization member with no tie to this project passes the check
	// above through the org-role fallback but cannot discover the project, so
	// they hear the same 404 as for an unknown id (the oRPC twin composes
	// `projectNotFoundUnlessVisible` for the same reason).
	if (!(await hasProjectAccess(projectId, apiCtx.userId))) {
		return { error: notFound("Project").error, status: 404 };
	}

	const hostingOrganizationId = access.organizationId;
	if (!hostingOrganizationId) {
		return {
			error: {
				message: "Coding instructions require an organization project",
			},
			status: 403,
		};
	}

	if (
		isOrganizationBoundKey(apiCtx) &&
		apiCtx.organizationId !== hostingOrganizationId
	) {
		return { error: notFound("Project").error, status: 404 };
	}

	// A personal-project owner passes `assertProjectPermission`
	// unconditionally; that arm is unreachable here because the null host org
	// above has already refused every personal project.
	//
	// This runs BEFORE the explicit-context lookup below, and the order is the
	// point: an unscoped organization lookup reachable by a caller with no
	// permission on the project turns `?org=` into an oracle — vary the slug
	// and the different refusals distinguish a slug that does not exist, one
	// that does, and the project's own. Nothing answers an arbitrary slug
	// until the caller has proven they may read this project.
	const requiredPermission =
		requested.requiredPermission ?? Permissions.INSTRUCTION_READ;
	if (!hasPermission(access.permissions, requiredPermission)) {
		const message =
			requiredPermission === Permissions.INSTRUCTION_READ
				? "No coding-instructions read permission for this project"
				: `No ${requiredPermission} permission for this project`;
		return {
			error: forbidden(message).error,
			status: 403,
		};
	}

	if (requested.org) {
		const named = await db.organization.findFirst({
			where: { slug: requested.org },
			select: { id: true },
		});
		// One answer for "no such slug" and "not this project's slug" alike.
		// Telling them apart would say whether an organization exists to a
		// caller who has no standing to ask. Covers an organization key naming
		// someone else's slug too: its own organization is already the
		// project's by the check above, so any other slug resolves to an id
		// this cannot equal.
		if (!named || named.id !== hostingOrganizationId) {
			return { error: notFound("Project").error, status: 404 };
		}
	}

	return { userId: apiCtx.userId, organizationId: hostingOrganizationId };
}
