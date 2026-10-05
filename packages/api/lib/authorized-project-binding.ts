/**
 * The organization of the project a request was authorized on, recorded by the
 * permission check itself and enforced by the organization resolvers.
 *
 * WHY THIS EXISTS. `requireProjectPermission` authorizes `(projectId, userId)`
 * and never looked at the organization, while `resolveOrganizationId` returned a
 * non-null `input.organizationId` verbatim. A caller with access to any project
 * could therefore name another organization and have the handler run AI,
 * embeddings or crawls on that organization's provider key — billed to it — and
 * stamp rows with it. The project's own organization is the only tenant the
 * caller was authorized in, so once a project has been authorized this request,
 * that organization is the answer and a different one in the input is refused.
 *
 * WHY A DEDICATED STORE. `TenantContext.effectiveWriteOrgId` already carries an
 * organization set by the permission check, but only for the guest path, and
 * several surfaces read it as "this caller is a project guest"
 * (`integrations/lib/gitlab-request-tenant.ts`, `integrations/procedures/oauth.ts`,
 * the maturation answer procedures, the MCP gateway's platform tools). Setting it
 * for every caller would change their meaning. The tenant context also only
 * exists under `tenantProtectedProcedure`, and two weave procedures authorize a
 * project on the plain protected builder. So this is its own AsyncLocalStorage,
 * opened for EVERY oRPC call by `projectBindingMiddleware` at the root of the
 * procedure chain (`orpc/procedures.ts`).
 *
 * WHY A SEPARATE ALS FROM THE TENANT ONE. `resolve-unambiguous-organization.ts`
 * re-enters `runWithTenantContext` with a fresh context when it resolves a
 * workspace. Living in a different store means nothing that replaces the tenant
 * context can drop or replace this binding.
 *
 * OUTSIDE AN oRPC CALL there is no holder: `recordAuthorizedProject` is a no-op
 * and `peekAuthorizedProject` reports no binding, so the resolvers behave exactly
 * as they did before. That covers Temporal activities and unit tests that call a
 * handler without its middleware. It is not a hole in production oRPC because the
 * holder is mounted on the root of every builder, which
 * `orpc/__tests__/authorized-project-binding.test.ts` pins; and
 * `assertProjectPermission` still RETURNS the binding, so a handler-side caller
 * can consume it directly without the store.
 *
 * Deliberately imports nothing that loads Prisma: `orpc/procedures.ts` and
 * `orpc/middleware/require-permission.ts` both read it, and tests import those
 * with `@repo/database` mocked.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ORPCError } from "@orpc/server";

/** What `assertProjectPermission` authorized. Frozen; never mutated. */
export type AuthorizedProject = Readonly<{
	projectId: string;
	/** `null` only for a project with no organization (the owner path). */
	organizationId: string | null;
}>;

/**
 * "No project authorized" is its own state, distinct from "a project with no
 * organization was authorized" — the second must be refused when consumed, the
 * first must leave the resolvers' previous behaviour alone.
 */
type BindingState =
	| { readonly kind: "none" }
	| { readonly kind: "bound"; readonly project: AuthorizedProject };

type BindingHolder = { state: BindingState };

const NO_BINDING: BindingState = Object.freeze({ kind: "none" as const });

const bindingStorage = new AsyncLocalStorage<BindingHolder>();

const PROJECT_WITHOUT_ORGANIZATION_MESSAGE =
	"This project does not belong to an organization";

/**
 * The refusal for a project with no organization. Shared with
 * `modules/projects/lib/project-organization.ts` so both say the same thing.
 */
export function projectWithoutOrganizationError() {
	return new ORPCError("FORBIDDEN", {
		message: PROJECT_WITHOUT_ORGANIZATION_MESSAGE,
	});
}

/**
 * Run `fn` with a FRESH, empty binding holder. One holder per call — never a
 * shared default object, so two concurrent requests can never see each other's
 * binding.
 */
export function runWithProjectBindingHolder<T>(fn: () => T): T {
	return bindingStorage.run({ state: NO_BINDING }, fn);
}

/** Whether the current async context has a holder (i.e. is inside an oRPC call). */
export function hasProjectBindingHolder(): boolean {
	return bindingStorage.getStore() !== undefined;
}

/**
 * The project authorized in this request, or `null` when none has been (or when
 * there is no holder). A null-organization project is returned as a binding
 * with `organizationId: null`, never as `null`.
 */
export function peekAuthorizedProject(): AuthorizedProject | null {
	const state = bindingStorage.getStore()?.state ?? NO_BINDING;
	return state.kind === "bound" ? state.project : null;
}

/**
 * Throws if binding `project` would conflict with what this request already
 * authorized. Pure — call it BEFORE any side effect of the authorization (the
 * guest carve-out in `grantProjectAccess`), so a refused second binding leaves
 * nothing half-applied.
 *
 * Same organization (including the same project twice, which
 * `begin-snapshot.ts` does) is fine. A different organization is refused: one
 * request acts in one organization, and picking either would let the second
 * authorization silently retarget the first's writes.
 */
export function assertProjectBindable(project: AuthorizedProject): void {
	const current = peekAuthorizedProject();
	if (current && current.organizationId !== project.organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "A request can only act on projects in one organization",
		});
	}
}

/**
 * Record the authorized project. Idempotent for the same organization: the
 * first project stays recorded. Returns whether a holder existed to record into.
 */
export function recordAuthorizedProject(project: AuthorizedProject): boolean {
	const holder = bindingStorage.getStore();
	if (!holder) {
		return false;
	}
	assertProjectBindable(project);
	if (holder.state.kind === "none") {
		holder.state = Object.freeze({
			kind: "bound" as const,
			project: Object.freeze({ ...project }),
		});
	}
	return true;
}

/**
 * The binding's answer to "which organization does this request run in", for
 * the organization resolvers.
 *
 *  - No project authorized → `{ bound: false }`; the caller keeps its previous
 *    precedence.
 *  - A non-null input organization that differs from the authorized project's →
 *    BAD_REQUEST, with the same message as `assertInputOrgMatchesProject`.
 *  - The authorized project has no organization → FORBIDDEN (ADR-018: an
 *    organization is the only tenant context).
 *  - Otherwise the authorized project's organization, whatever the input said
 *    (null, undefined or the same id).
 */
export function resolveBoundOrganization(
	inputOrganizationId: string | null | undefined,
): { bound: false } | { bound: true; organizationId: string } {
	const project = peekAuthorizedProject();
	if (!project) {
		return { bound: false };
	}
	if (!project.organizationId) {
		throw projectWithoutOrganizationError();
	}
	if (inputOrganizationId && inputOrganizationId !== project.organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId does not match the project",
		});
	}
	return { bound: true, organizationId: project.organizationId };
}
