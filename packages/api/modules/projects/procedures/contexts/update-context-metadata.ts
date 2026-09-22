/**
 * updateContextMetadata — Context Source Type Labeling (Fizzy #1888).
 *
 * Edits the user-declared source type label ("Client Chat", "Architect
 * Chat", …) and the free-text AI instructions on ANY context source,
 * regardless of type — LINK, FILE, TEXT, MEETING_TRANSCRIPT, INTEGRATION,
 * … — so every source can carry the same metadata (FR8).
 *
 * Distinct from `updateUrlSource`, which owns the LINK-specific crawl
 * settings (scope / maxPages / refreshMode). Metadata lives here so the
 * edit surface is uniform across source types.
 *
 * The write itself is `updateContextMetadata` in `@repo/database`, shared
 * with the `fabric_update_project_context` MCP tool, and the audit row is
 * built by `buildContextMetadataAuditEvent`, shared the same way.
 */
import { ORPCError } from "@orpc/client";
import {
	hasProjectAccess,
	normalizeContextMetadataValue,
	updateContextMetadata,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { emitContextChange } from "../../../../lib/realtime";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { buildContextMetadataAuditEvent } from "../../lib/context-metadata-audit";

/** Upper bound for a custom source type label. The six presets are far
 * shorter; this only stops an unbounded string reaching prompt headers. */
const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 500;
/** Ceiling on each `expected` value: generous, so a stored value that
 * predates today's bounds is still expressible, but never unbounded. */
const MAX_EXPECTED_LENGTH = 2000;

export const updateContextMetadataProcedure = tenantProtectedProcedure
	// SOC 2 input-org ratchet: the caller-supplied organizationId must name
	// an org this user is actually a member of (with CONTEXT_UPDATE) —
	// requireProjectPermission alone checks the project, not the org.
	.use(requireInputOrgPermission(Permissions.CONTEXT_UPDATE))
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/contexts/:contextId/metadata",
		tags: ["Projects", "Contexts"],
		summary: "Update context source type label and AI instructions",
		description:
			"Set or clear the user-declared type label and AI instructions on any context source. Takes effect on the next AI invocation — no re-embed needed. Pass `expected` (the values you read) to refuse with CONFLICT instead of overwriting a concurrent edit.",
	})
	.input(
		z.object({
			contextId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// `null` clears the field; `undefined` leaves it untouched — the UI
			// sends both fields explicitly so "cleared both" is a valid save.
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
			// Compare-and-swap: the values the caller loaded. When the row no
			// longer holds them, the save is refused with CONFLICT and nothing
			// is written, so two people editing the same source never silently
			// overwrite each other. OPTIONAL on this path only, as the
			// compatibility mode for older clients: absent, the comparison is
			// skipped. The MCP tool always requires it.
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
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Project access — required because permission middleware only
		// checks the permission token, not membership XOR.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Tenant + IDOR guard live inside the shared write: the row is found
		// under the XOR filter and `projectId`, so a personal-context user
		// can't address an org row by id.
		const result = await updateContextMetadata(
			input.contextId,
			input.projectId,
			{ userId: user.id, organizationId: organizationId ?? null },
			{
				sourceType: input.sourceType,
				aiInstructions: input.aiInstructions,
			},
			{ expected: input.expected },
		);

		if (result.status === "not-found") {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found",
			});
		}

		if (result.status === "stale") {
			// The dialog keys off this code to say "someone else changed this
			// while you were editing" and offer their values; `data.current`
			// carries them so it need not refetch first.
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

		const ctx = result.context;

		// A no-op save (no fields supplied, or the same values) wrote nothing
		// and must not churn other clients' realtime feeds or the ledger.
		if (result.status === "updated") {
			recordAuditFromRequest(
				context,
				buildContextMetadataAuditEvent({
					organizationId,
					projectId: input.projectId,
					context: ctx,
					before: result.before,
					after: result.after,
					changed: result.changed,
					via: "web",
				}),
			);

			await emitContextChange({
				projectId: input.projectId,
				contextId: ctx.id,
				action: "updated",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: ctx.type,
				contextName:
					ctx.originalFilename ||
					ctx.sourceTitle ||
					`${ctx.type} context`,
			});

			// Operator trail for metadata changes (#1888 NFR). Field NAMES
			// only — the values are user content and stay out of ops logs.
			// The flags say what actually changed, not what the client sent:
			// the dialog always sends both fields.
			console.info("analytics_event", {
				event: "project_context_metadata_updated",
				contextId: ctx.id,
				projectId: input.projectId,
				sourceTypeChanged: result.changed.includes("sourceType"),
				instructionsChanged: result.changed.includes("aiInstructions"),
			});
		}

		return {
			contextId: ctx.id,
			sourceType: ctx.sourceType,
			aiInstructions: ctx.aiInstructions,
			metadataUpdatedAt: ctx.metadataUpdatedAt,
			metadataUpdatedByUserId: ctx.metadataUpdatedByUserId,
		};
	});
