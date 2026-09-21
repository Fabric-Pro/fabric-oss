/**
 * List the organization's non-member contacts (#2340).
 *
 * The register holds names and contact details of client-side staff across
 * every project, so it is gated on `ORG_MEMBERS_READ` and, through
 * `requireInputOrgPermission`, on membership of the organization actually
 * named in the input. A project-scoped guest has no `Member` row and is
 * refused outright: their invitation is to one project, and this list spans
 * all of them.
 */

import { listNonMemberContacts } from "@repo/database";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrganizationContext, toContactResponse } from "./shared";

export const listNonMemberContactsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_MEMBERS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/non-member-contacts",
		tags: ["Contacts"],
		summary: "List non-member contacts",
		description:
			"List the organization's contacts who have no Fabric account. Redacted contacts are never returned.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			search: z.string().max(INPUT_BOUNDS.name).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);

		const result = await listNonMemberContacts({
			organizationId,
			search: input.search,
			limit: input.limit,
			offset: input.offset,
		});

		return {
			contacts: result.contacts.map((contact) => ({
				...toContactResponse(contact),
				todoCount: contact.todoCount,
			})),
			total: result.total,
			hasMore: result.hasMore,
			nextOffset: result.nextOffset,
		};
	});
