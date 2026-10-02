import { ORPCError } from "@orpc/server";
import {
	normalizeContextMetadataValue,
	updateCompanyContextSourceMetadata,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { contextAuditResourceName } from "../../../projects/lib/context-metadata-audit";
import {
	MAX_EXPECTED_LENGTH,
	MAX_INSTRUCTIONS_LENGTH,
	MAX_SOURCE_TYPE_LENGTH,
} from "../../../projects/procedures/contexts/update-context-metadata";
import { assertCompanyContextEditor } from "./lib/access";

const COMPANY_CONTEXT_METADATA_AUDIT_ACTION =
	"org.company_context.metadata_updated" as const;

/**
 * Edit a company source's type label and AI instructions (Fizzy #2719),
 * with the project `updateMetadata` semantics and limits: `null` or blank
 * clears a field and `undefined` leaves it alone; `expected` is a
 * compare-and-swap that answers CONFLICT, with the stored values, instead of
 * overwriting a concurrent edit; a save that changes nothing writes nothing.
 * No re-embed — both fields are read live at retrieval time.
 *
 * A real change records `org.company_context.metadata_updated`: these
 * two fields steer every Proposal and Business Case the organization
 * generates, so who changed what the AI is told has to have an answer. Both
 * values before and after are recorded, as for a project source — short,
 * bounded text the question needs.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, admin or
 * owner of it, then the company context gate. The source is found by
 * `(id, organizationId)`.
 */
export const updateCompanyContextMetadataProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PATCH",
		path: "/organizations/{organizationId}/company-context/{sourceId}/metadata",
		tags: ["Organizations", "Company context"],
		summary:
			"Update a company context source's type label and AI instructions",
		description:
			"Set or clear the type label and AI instructions of a company context source. Takes effect on the next generation. Pass `expected` to refuse with CONFLICT instead of overwriting a concurrent edit.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
			sourceType: z
				.string()
				.trim()
				.min(1)
				.max(MAX_SOURCE_TYPE_LENGTH)
				.nullable()
				.optional(),
			aiInstructions: z
				.string()
				.trim()
				.max(MAX_INSTRUCTIONS_LENGTH)
				.nullable()
				.optional(),
			expected: z
				.object({
					sourceType: z.string().max(MAX_EXPECTED_LENGTH).nullable(),
					aiInstructions: z
						.string()
						.max(MAX_EXPECTED_LENGTH)
						.nullable(),
				})
				.optional(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { organizationId, sourceId } = input;
		const { user } = context;
		await assertCompanyContextEditor(organizationId, user.id);

		const result = await updateCompanyContextSourceMetadata(
			sourceId,
			organizationId,
			user.id,
			{
				sourceType: input.sourceType,
				aiInstructions: input.aiInstructions,
			},
			{ expected: input.expected },
		);

		if (result.status === "not-found") {
			throw new ORPCError("NOT_FOUND", {
				message: "Company context source not found",
			});
		}
		if (result.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"This source's details were changed by someone else while you were editing.",
				data: {
					current: {
						sourceType: normalizeContextMetadataValue(
							result.current.sourceType,
						),
						aiInstructions: normalizeContextMetadataValue(
							result.current.aiInstructions,
						),
						metadataUpdatedByUserId:
							result.current.metadataUpdatedByUserId,
					},
				},
			});
		}

		const { source } = result;
		if (result.status === "updated") {
			recordAuditFromRequest(context, {
				action: COMPANY_CONTEXT_METADATA_AUDIT_ACTION,
				category: "org",
				organizationId,
				resource: {
					type: "company_context_source",
					id: source.id,
					name: contextAuditResourceName(source),
				},
				metadata: {
					changed: result.changed,
					before: {
						sourceType: result.before.sourceType,
						aiInstructions: result.before.aiInstructions,
					},
					after: {
						sourceType: result.after.sourceType,
						aiInstructions: result.after.aiInstructions,
					},
					via: "web",
				},
			});
		}

		return {
			sourceId: source.id,
			sourceType: source.sourceType,
			aiInstructions: source.aiInstructions,
			metadataUpdatedAt: source.metadataUpdatedAt,
			metadataUpdatedByUserId: source.metadataUpdatedByUserId,
		};
	});
