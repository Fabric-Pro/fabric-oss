import { hasOrganizationTie } from "@repo/database";

/**
 * Result of resolving the organization a request runs in. On success the id
 * is always a string: there is no personal/null arm (ADR-018, organization
 * is the only tenant context).
 */
export type RequestedOrganizationResolution =
	| { ok: true; organizationId: string }
	| { ok: false; status: 403; error: "Forbidden"; message: string };

export const NOT_A_MEMBER_MESSAGE = "You are not a member of this organization";
export const NO_ORGANIZATION_MESSAGE =
	"No organization is active for this session";

/**
 * Bind the organization a request runs in to the authenticated caller.
 *
 * Route handlers outside oRPC (`/api/copilotkit`, the direct-chat stream)
 * receive `organizationId` from the client and use it to pick the tenant's
 * model, provider key, bound prompts and agent headers. That value must never
 * be trusted on its own: a non-member could bill another organization's key
 * or read its prompts by editing a query string.
 *
 * Same rule as `resolveOrganizationIdForCaller` applies to oRPC input, with
 * one deliberate difference: there is no personal fall-through. ADR-018 made
 * the organization the only tenant context, so a request that names no
 * organization runs in the SESSION's active organization, and a session with
 * none is refused rather than served from a null tenant.
 *
 * - Id supplied → it must be one the caller has a tie to. A "tie" is
 *   organization membership or an accepted, unexpired project guest
 *   invitation into that organization (`hasOrganizationTie`), so a project
 *   guest keeps the document assistant, and a user with two organizations
 *   open in two tabs is served the one each tab asked for.
 * - Id omitted → the session's active organization, verified with the same
 *   tie check (a stale active organization the caller has since left is
 *   refused, never silently served).
 * - Neither → 403. Never silently substitute another organization, so the
 *   client cannot end up talking to a tenant it did not ask for.
 */
export async function resolveRequestedOrganization(input: {
	userId: string;
	requestedOrganizationId: string | null | undefined;
	/** The session's active organization, used when the request names none. */
	activeOrganizationId: string | null | undefined;
	hasTie?: (userId: string, organizationId: string) => Promise<boolean>;
}): Promise<RequestedOrganizationResolution> {
	const requested = input.requestedOrganizationId || undefined;
	const candidate = requested ?? (input.activeOrganizationId || undefined);
	if (!candidate) {
		return {
			ok: false,
			status: 403,
			error: "Forbidden",
			message: NO_ORGANIZATION_MESSAGE,
		};
	}

	const check = input.hasTie ?? hasOrganizationTie;
	if (!(await check(input.userId, candidate))) {
		return {
			ok: false,
			status: 403,
			error: "Forbidden",
			message: NOT_A_MEMBER_MESSAGE,
		};
	}

	return { ok: true, organizationId: candidate };
}
/** JSON 403 body shared by the route handlers that use the resolver. */
export function forbiddenOrganizationResponse(
	resolution: Extract<RequestedOrganizationResolution, { ok: false }>,
): Response {
	return new Response(
		JSON.stringify({
			error: resolution.error,
			message: resolution.message,
		}),
		{
			status: resolution.status,
			headers: { "Content-Type": "application/json" },
		},
	);
}
