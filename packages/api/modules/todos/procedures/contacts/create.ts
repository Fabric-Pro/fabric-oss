/**
 * Add a non-member contact to the organization's register (#2340).
 *
 * THE DUPLICATE RULE. Two people at one client really can share a name, so a
 * same-name contact is not an error — but creating one by accident splits a
 * person's obligations across two rows that nobody notices are the same
 * person. So a same-name create is REFUSED once, with the existing match(es)
 * handed back, and goes through only when the caller comes back with
 * `confirmDuplicate: true`.
 *
 * That refusal is a normal outcome rather than an `ORPCError`, and the
 * response is a discriminated union on `status`: the client has to branch to
 * find the contact at all, so "duplicate" can never be mistaken for a
 * successful create. `contact` is `null` on that branch for the same reason.
 *
 * Gated on `ORG_MEMBERS_INVITE` — adding an outsider to the register is the
 * same kind of act as inviting one into the organization — and, through
 * `requireInputOrgPermission`, on membership of the organization named in the
 * input rather than whichever one the caller's session happens to hold.
 */

import {
	createNonMemberContact,
	findNonMemberContactsByName,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	type ContactResponse,
	contactNameSchema,
	optionalContactCompanySchema,
	optionalContactEmailSchema,
	requireOrganizationContext,
	toContactResponse,
} from "./shared";

export const createNonMemberContactProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_MEMBERS_INVITE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/non-member-contacts",
		tags: ["Contacts"],
		summary: "Create a non-member contact",
		description:
			"Add a contact with no Fabric account. A name that already exists in the organization is refused until the caller re-sends with confirmDuplicate.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			name: contactNameSchema,
			email: optionalContactEmailSchema,
			company: optionalContactCompanySchema,
			/**
			 * Explicit acknowledgement that a contact with this name already
			 * exists and this is a different person.
			 */
			confirmDuplicate: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);

		const duplicates = await findNonMemberContactsByName({
			organizationId,
			name: input.name,
		});

		if (duplicates.length > 0 && !input.confirmDuplicate) {
			// Nothing was written, so nothing is audited: an audit row here
			// would claim a contact was added that does not exist.
			return {
				status: "duplicate" as const,
				contact: null,
				duplicates: duplicates.map(toContactResponse),
			};
		}

		const contact = await createNonMemberContact({
			organizationId,
			name: input.name,
			email: input.email,
			company: input.company,
			createdById: context.user.id,
		});

		// The contact's own name, email and company are deliberately NOT in
		// this row. The audit log is append-only, so anything identifying
		// written here would outlive the redaction that `contacts.delete`
		// performs — the erasure would leave its own subject behind in the
		// ledger. The id is enough to answer "who added which record, when".
		recordAuditFromRequest(context, {
			action: "org.contact.created",
			category: "org",
			organizationId,
			resource: {
				type: "non_member_contact",
				id: contact.id,
				name: null,
			},
			metadata: { confirmedDuplicate: duplicates.length > 0 },
		});

		return {
			status: "created" as const,
			contact: toContactResponse(contact) as ContactResponse,
			duplicates: [] as ContactResponse[],
		};
	});
