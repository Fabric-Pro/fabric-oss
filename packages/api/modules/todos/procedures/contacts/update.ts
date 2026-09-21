/**
 * Edit a non-member contact (#2340).
 *
 * A rename touches no to-do. A contact's identity is its ROW, and every to-do
 * points at it by id, so correcting a misspelt name or adding the company that
 * tells two same-name people apart leaves every assignment exactly where it
 * was.
 *
 * Unlike create, an edit does not ask about duplicate names. Create's
 * confirmation exists to stop a person being entered twice by accident; an
 * edit is someone deliberately looking at one specific row, and making them
 * confirm a name collision there would block the ordinary case of correcting a
 * name TO the one the register already shows for the same person.
 *
 * A redacted contact cannot be edited: writing identifying content back into a
 * row whose whole purpose is that it no longer holds any would undo the
 * erasure. The database layer matches on `redactedAt: null`, so it answers the
 * same NOT_FOUND it gives for an id from another organization.
 */

import { ORPCError } from "@orpc/server";
import { updateNonMemberContact } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	contactNameSchema,
	optionalContactCompanySchema,
	optionalContactEmailSchema,
	requireOrganizationContext,
	toContactResponse,
} from "./shared";

export const updateNonMemberContactProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_MEMBERS_INVITE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/non-member-contacts/{contactId}",
		tags: ["Contacts"],
		summary: "Update a non-member contact",
		description:
			"Rename a contact or change its email/company. To-do assignments are unaffected.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			contactId: z.string(),
			name: contactNameSchema.optional(),
			email: optionalContactEmailSchema,
			company: optionalContactCompanySchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);

		const fieldsChanged = (["name", "email", "company"] as const).filter(
			(field) => input[field] !== undefined,
		);
		if (fieldsChanged.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Nothing to update",
			});
		}

		const contact = await updateNonMemberContact({
			contactId: input.contactId,
			organizationId,
			name: input.name,
			email: input.email,
			company: input.company,
		});
		if (!contact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Contact not found",
			});
		}

		// Field NAMES, never their values — see the note in `create.ts`. This
		// still answers what an audit reader asks of an edit ("was the person's
		// identity changed, or only their company?") without copying the
		// person's details into a record that cannot later be erased.
		recordAuditFromRequest(context, {
			action: "org.contact.updated",
			category: "org",
			organizationId,
			resource: {
				type: "non_member_contact",
				id: contact.id,
				name: null,
			},
			metadata: { fieldsChanged },
		});

		return { contact: toContactResponse(contact) };
	});
