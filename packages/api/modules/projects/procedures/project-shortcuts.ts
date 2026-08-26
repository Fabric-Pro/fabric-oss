/**
 * AUTHORIZATION
 *
 * `tenantProtectedProcedure` + `requireInputOrgPermission(PROJECT_READ)`.
 *
 * The organization is verified against the one the CALLER NAMED, not the one on
 * the session. That is the point: the session's active organization is shared
 * across browser tabs, so a tab open on one organization could otherwise render
 * another's project names. It is also what the input-org verification ratchet
 * requires — `resolveOrganizationId` returns the client's string as-is, so a
 * procedure that trusts it without a membership check lets a caller pair their
 * own data with someone else's organization id.
 *
 * Project-scoped guests still resolve. A guest is presented the personal
 * navigation rooted at `/app`, so their client sends `organizationId: null` and
 * this middleware short-circuits before the membership check — exactly the
 * branch that would otherwise reject them, since a guest holds no Member row in
 * the host organization.
 *
 * It deliberately does NOT use `requireProjectPermission`: that decorator reads
 * a project id off the input and rejects a request without one, so it cannot
 * gate a list read. The result set is scoped by `listProjectShortcuts`, which
 * derives reachability from the project rather than from the preference row.
 *
 * `organizationId` is a REQUIRED nullable field, not an optional one. An omitted
 * optional field arrives as `undefined`, which `resolveOrganizationId` treats as
 * "fall back to the session's active organization" — a value shared across
 * browser tabs. A personal-context tab would then render another organization's
 * project names.
 */
import { listProjectShortcuts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/** Fixed by product decision (#1694); not caller-configurable. */
const SHORTCUT_LIMIT = 3;

export const listProjectShortcutsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/shortcuts",
		tags: ["Projects"],
		summary: "List quick-access project shortcuts",
		description:
			"Up to three project shortcuts for the caller — favorites first, remaining slots filled by most recently visited.",
	})
	.input(
		z.object({
			// Required, not optional. See the AUTHORIZATION note above.
			organizationId: z.string().nullable(),
		}),
	)
	.output(
		z.object({
			shortcuts: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					organizationSlug: z.string().nullable(),
					isFavorite: z.boolean(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const shortcuts = await listProjectShortcuts({
			userId: context.user.id,
			organizationId: organizationId ?? null,
			limit: SHORTCUT_LIMIT,
		});

		return { shortcuts };
	});
