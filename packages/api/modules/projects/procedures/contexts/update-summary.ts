import { ORPCError } from "@orpc/client";
import {
	type ContextSourceReference,
	createManualEditSummary,
	hasProjectAccess,
	validateContextSources,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";
import { mapSummaryContent } from "./summary-mappers";

/** Inline `[S#]` markers a body cites (mirrors the reader's marker pattern). */
const MARKER_PATTERN = /\[(S\d+)\](?!\()/g;

/**
 * Manually edit the project's current summary. Admin-only (`PROJECT_SETTINGS_EDIT`).
 * Creates a NEW current version (superseding the edited one — a history entry) with
 * the user's content. References are PRESERVED and validated: only references whose
 * `[S#]` marker still appears in the content AND whose source really exists in the
 * project + tenant are kept (a hand-typed / stale marker is dropped, never trusted).
 * The user can add new references (via the picker) the same way. No LLM spend.
 */
export const updateContextSummaryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/summary/update",
		tags: ["Projects", "Contexts"],
		summary: "Edit context summary",
		description:
			"Manually edit the current context summary, preserving/adding validated source references.",
	})
	.input(
		z.object({
			projectId: z.string(),
			summaryId: z.string(),
			content: z.string().min(1).max(200_000),
			references: z
				.array(
					z.object({
						marker: z.string(),
						sourceType: z.string(),
						sourceId: z.string(),
						sourceTimestamp: z.string().optional(),
						label: z.string().optional(),
					}),
				)
				.max(500),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertContextSummarizationEnabled();
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		const tenancy = {
			userId: organizationId ? null : user.id,
			organizationId: organizationId ?? null,
		};

		// Keep only references whose marker still appears in the edited content
		// (dedupe by marker — first wins), then re-verify each source exists in the
		// project + tenant. Anything else is dropped, so a stale or hand-typed marker
		// can never point at a bogus / cross-tenant source.
		const citedMarkers = new Set<string>();
		for (const match of input.content.matchAll(MARKER_PATTERN)) {
			citedMarkers.add(match[1]);
		}
		const seen = new Set<string>();
		const candidates: ContextSourceReference[] = [];
		for (const ref of input.references) {
			if (!citedMarkers.has(ref.marker) || seen.has(ref.marker)) {
				continue;
			}
			seen.add(ref.marker);
			candidates.push({
				marker: ref.marker,
				sourceType: ref.sourceType,
				sourceId: ref.sourceId,
				sourceTimestamp: ref.sourceTimestamp ?? "",
				label: ref.label,
			});
		}
		const { valid } = await validateContextSources({
			projectId: input.projectId,
			tenancy,
			references: candidates,
		});

		const updated = await createManualEditSummary({
			projectId: input.projectId,
			tenancy,
			editedByUserId: user.id,
			baseSummaryId: input.summaryId,
			content: input.content,
			references: valid,
		});
		if (!updated) {
			throw new ORPCError("NOT_FOUND", {
				message: "Summary not found or no longer current",
			});
		}

		return { summary: mapSummaryContent(updated) };
	});
