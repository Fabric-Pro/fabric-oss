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
 */
import { ORPCError } from "@orpc/client";
import { db, getContextById, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import { emitContextChange } from "../../../../lib/realtime";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Upper bound for a custom source type label. The six presets are far
 * shorter; this only stops an unbounded string reaching prompt headers. */
const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 500;

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
			"Set or clear the user-declared type label and AI instructions on any context source. Takes effect on the next AI invocation — no re-embed needed.",
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

		// Tenant + IDOR guard: fetch the row inside the XOR filter so a
		// personal-context user can't address an org row by id.
		const existing = await getContextById(
			input.contextId,
			input.projectId,
			{
				userId: user.id,
				organizationId: organizationId ?? null,
			},
		);
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found",
			});
		}

		const data: {
			sourceType?: string | null;
			aiInstructions?: string | null;
		} = {};
		if (input.sourceType !== undefined) {
			data.sourceType = input.sourceType;
		}
		if (input.aiInstructions !== undefined) {
			data.aiInstructions = input.aiInstructions;
		}

		const updated =
			Object.keys(data).length > 0
				? await db.projectContext.update({
						where: { id: existing.id },
						data,
						select: {
							id: true,
							sourceType: true,
							aiInstructions: true,
						},
					})
				: null;

		// A no-op save (no fields supplied) must not churn other clients'
		// realtime feeds.
		if (updated) {
			await emitContextChange({
				projectId: input.projectId,
				contextId: updated.id,
				action: "updated",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: existing.type,
				contextName:
					existing.originalFilename ||
					existing.sourceTitle ||
					`${existing.type} context`,
			});

			// Operator trail for metadata changes (#1888 NFR). Field NAMES
			// only — the values are user content and stay out of ops logs.
			console.info("analytics_event", {
				event: "project_context_metadata_updated",
				contextId: updated.id,
				projectId: input.projectId,
				sourceTypeChanged: input.sourceType !== undefined,
				instructionsChanged: input.aiInstructions !== undefined,
			});
		}

		return {
			contextId: updated?.id ?? existing.id,
			sourceType: updated ? updated.sourceType : existing.sourceType,
			aiInstructions: updated
				? updated.aiInstructions
				: existing.aiInstructions,
		};
	});
