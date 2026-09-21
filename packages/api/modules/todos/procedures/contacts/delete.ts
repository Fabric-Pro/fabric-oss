/**
 * Remove a non-member contact from the register (#2340).
 *
 * DELETING REDACTS, IT DOES NOT REMOVE. The row stays, anonymised in place:
 * `redactedAt` is set, the name becomes a tombstone, email and company are
 * nulled, and every to-do that pointed at the contact is detached into the
 * Unassigned bucket.
 *
 * Both halves of that are load-bearing, and they pull against each other:
 *
 *  - A person outside this system can ask to be erased, and that request has
 *    to be satisfiable at any time. So open to-dos are NEVER a reason to
 *    refuse the deletion.
 *  - The organization is still tracking those obligations. So the deletion
 *    must not take them with it. They lose their assignee and nothing else,
 *    and the response says how many moved, so the person doing the deletion
 *    can be told what they now have to reassign.
 *
 * Gated on `ORG_MEMBERS_REMOVE`, and through `requireInputOrgPermission` on
 * membership of the organization named in the input.
 */

import { ORPCError } from "@orpc/server";
import { redactNonMemberContact } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrganizationContext } from "./shared";

export const deleteNonMemberContactProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_MEMBERS_REMOVE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "DELETE",
		path: "/non-member-contacts/{contactId}",
		tags: ["Contacts"],
		summary: "Delete a non-member contact",
		description:
			"Redact a contact in place and detach its to-dos, which stay on the list as unassigned.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			contactId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);

		const result = await redactNonMemberContact({
			contactId: input.contactId,
			organizationId,
		});
		// `null` covers an id from another organization AND one that is already
		// redacted. The second is not a failure to retry — the erasure already
		// happened — but it must not report a fresh success either, or the
		// ledger gains a second redaction row for something that did not occur.
		if (!result) {
			throw new ORPCError("NOT_FOUND", {
				message: "Contact not found",
			});
		}

		// No name, no email, no company: a redaction row that recorded who was
		// erased would be the one place the erased details survived. What the
		// ledger keeps instead is the consequence — how many tracked
		// obligations this erasure moved to Unassigned.
		recordAuditFromRequest(context, {
			action: "org.contact.redacted",
			category: "org",
			organizationId,
			resource: {
				type: "non_member_contact",
				id: result.contact.id,
				name: null,
			},
			metadata: {
				detachedTodoCount: result.detachedTodoCount,
				clearedSuggestionCount: result.clearedSuggestionCount,
				strippedCandidateCount: result.strippedCandidateCount,
			},
		});

		return {
			success: true as const,
			contactId: result.contact.id,
			redactedAt: result.contact.redactedAt?.toISOString() ?? null,
			detachedTodoCount: result.detachedTodoCount,
			clearedSuggestionCount: result.clearedSuggestionCount,
			strippedCandidateCount: result.strippedCandidateCount,
		};
	});
