// `@orpc/server` re-exports this very class from `@orpc/client` — they are the
// same function object, so an error constructed here is `instanceof` the server
// one and serializes identically. Both import paths appear across this package;
// `@orpc/client` is what the other files in `lib/` and the reference handler
// (`publishing-suite/get-settings.ts`) use, so it is the local convention.
import { ORPCError } from "@orpc/client";

/**
 * Tenant handling for a procedure that is ALREADY behind
 * `requireProjectPermission`.
 *
 * That middleware is the authoritative gate: it resolves `(projectId, userId)`
 * through `resolveEffectiveProjectPermissions`, whose precedence is
 * owner → active ProjectMember → org role. A handler that then re-derives the
 * project with `{ id, organizationId: null, userId: context.user.id }` drops
 * the last two paths — in personal context that clause means *owner*, so an
 * accepted project member (an external guest, most visibly) is authorized by
 * the middleware and then rejected by the handler with NOT_FOUND.
 *
 * So: load the project by id alone, take the tenant from the loaded row, and
 * use `input.organizationId` only as a guard. Extracted here because the guard
 * is the half that is easy to drop silently, and twenty call sites should not
 * each carry their own copy of the reasoning.
 *
 * The middleware never inspects the organization, and `resolveOrganizationId`
 * returns the caller's string verbatim with no membership lookup — so a caller
 * could otherwise pair a project they legitimately reach with an organization
 * id they made up. Pinned repo-wide by `input-org-unverified-ratchet.test.ts`
 * and `project-scoped-lookup-ownership-ratchet.test.ts`.
 */

/**
 * Reject only a POSITIVELY-WRONG non-null `input.organizationId`.
 *
 * `null` and `undefined` always pass: a guest viewing an org-owned project from
 * a personal-context page legitimately sends `null`, and rejecting that would
 * reintroduce the very bug this exists to prevent.
 *
 * BAD_REQUEST rather than NOT_FOUND because `requireProjectPermission` has
 * already authorized this caller for this exact project — the response
 * discloses nothing they do not already know.
 */
export function assertInputOrgMatchesProject(
	inputOrganizationId: string | null | undefined,
	project: { organizationId: string | null },
): void {
	if (
		inputOrganizationId != null &&
		inputOrganizationId !== (project.organizationId ?? null)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId does not match the project",
		});
	}
}
