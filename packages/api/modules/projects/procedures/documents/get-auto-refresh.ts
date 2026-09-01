import {
	DEFAULT_DOCUMENT_REFRESH_CADENCE,
	type DocumentRefreshCadence,
	getAutoRefreshSettings,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadDocumentForAutoRefresh } from "../../lib/auto-refresh-document-access";
import { assertLivingDocsRefreshEnabled } from "../../lib/living-docs-refresh-feature";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(DOCUMENT_UPDATE),
 * then `loadDocumentForAutoRefresh` — which runs the TENANT gate before any
 * access check, so a cross-tenant caller gets NOT_FOUND rather than FORBIDDEN
 * (a FORBIDDEN would confirm the document exists). Gated by the feature flag.
 *
 * The document's Living-Docs auto-refresh enrollment, for the masthead control.
 *
 * A document with no settings row reports `enabled: false` at the default
 * cadence — enrollment is opt-in, so "no row" and "row with enabled: false" are
 * the same thing to the client.
 *
 * Guarded by DOCUMENT_UPDATE (not a read permission) on purpose: this is the
 * read half of a write control, and it is only ever rendered for members who
 * may flip it.
 */
export const getDocumentAutoRefreshProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{id}/auto-refresh",
		tags: ["Projects", "Documents"],
		summary: "Get document auto-refresh settings",
		description:
			"Whether this document is enrolled in scheduled auto-refresh, and at what cadence.",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertLivingDocsRefreshEnabled();

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		await loadDocumentForAutoRefresh({
			documentId: input.id,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});

		const settings = await getAutoRefreshSettings(input.id);

		// `pendingContent` is the authority for "a proposal is waiting" — the other
		// three columns are written with it and cleared with it, but only this one
		// is the thing that would actually be committed. Collapsed into a single
		// nullable object so the client cannot render a half-populated proposal
		// (a summary with nothing behind it) by checking the wrong field.
		const pending = settings?.pendingContent
			? {
					content: settings.pendingContent,
					summary: settings.pendingSummary,
					proposedAt: settings.pendingProposedAt,
					baselineVersion: settings.pendingBaselineVersion,
				}
			: null;

		return {
			enabled: settings?.enabled ?? false,
			cadence: (settings?.cadence ??
				DEFAULT_DOCUMENT_REFRESH_CADENCE) as DocumentRefreshCadence,
			// Opt-in, like enrollment itself: no row means the AI proposes and a
			// human reviews. Nobody is defaulted into unattended rewrites.
			autoApply: settings?.autoApply ?? false,
			lastRefreshedAt: settings?.lastRefreshedAt ?? null,
			lastRefreshStatus: settings?.lastRefreshStatus ?? null,
			lastRefreshSummary: settings?.lastRefreshSummary ?? null,
			// The only timestamp a FAILED cycle has. `lastRefreshedAt` deliberately
			// does not advance on failure — that is what keeps the document due
			// instead of silent for a fortnight — so without this the UI could say a
			// refresh failed but not when, and "failed" with no time reads as
			// "failing right now, forever".
			lastAttemptAt: settings?.lastAttemptAt ?? null,
			pending,
		};
	});
