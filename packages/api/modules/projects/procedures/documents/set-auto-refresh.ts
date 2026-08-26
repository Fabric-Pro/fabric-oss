import {
	DEFAULT_DOCUMENT_REFRESH_CADENCE,
	type DocumentRefreshCadence,
	getAutoRefreshSettings,
	upsertAutoRefreshSettings,
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

const cadenceSchema = z.enum([
	"ON_DEPLOY",
	"DAILY",
	"WEEKLY",
	"BIWEEKLY",
	"MONTHLY",
]);

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(DOCUMENT_UPDATE),
 * then `loadDocumentForAutoRefresh` — which runs the TENANT gate before any
 * access check, so a cross-tenant caller gets NOT_FOUND rather than FORBIDDEN
 * (a FORBIDDEN would confirm the document exists). Gated by the feature flag.
 *
 * Enroll a document in scheduled auto-refresh, change its cadence, or unenroll.
 *
 * Enrollment is NOT gated on document type — any document a member may edit can
 * be enrolled.
 *
 * `createdByUserId` is re-homed to the CALLER on every write, deliberately: the
 * scheduled sweep runs with no session and borrows this identity for AI model
 * resolution and usage billing, so the most recent member to touch the setting
 * is the safest actor to run under. (It also un-wedges a document whose original
 * enroller has left the org — the sweep skips a stale actor until someone
 * re-saves.)
 *
 * `lastRefreshedAt` is never written here: disabling and re-enabling a document
 * must not reset its cadence cycle. See `upsertAutoRefreshSettings`.
 */
export const setDocumentAutoRefreshProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{id}/auto-refresh",
		tags: ["Projects", "Documents"],
		summary: "Set document auto-refresh settings",
		description:
			"Enroll or unenroll this document from scheduled auto-refresh, and set its cadence.",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			enabled: z.boolean(),
			/**
			 * Omitted on a plain on/off flip. A new row falls back to the default
			 * cadence; an existing row keeps the cadence it already had, so
			 * unenrolling never silently rewrites the member's choice.
			 */
			cadence: cadenceSchema.optional(),
			/**
			 * Write the refresh straight to the document instead of proposing it
			 * for review. Follows the same omitted-means-unchanged rule as
			 * `cadence`, and a NEW row falls back to `false`: an unattended
			 * whole-document rewrite is opted into explicitly, never inherited
			 * from a plain on/off flip of the enrollment toggle.
			 */
			autoApply: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertLivingDocsRefreshEnabled();

		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const document = await loadDocumentForAutoRefresh({
			documentId: input.id,
			projectId: input.projectId,
			userId: user.id,
			organizationId,
		});

		const existing = await getAutoRefreshSettings(input.id);
		const cadence: DocumentRefreshCadence =
			input.cadence ??
			(existing?.cadence as DocumentRefreshCadence | undefined) ??
			DEFAULT_DOCUMENT_REFRESH_CADENCE;
		// Same precedence as cadence: explicit choice > stored choice > OFF.
		const autoApply = input.autoApply ?? existing?.autoApply ?? false;

		const settings = await upsertAutoRefreshSettings({
			documentId: input.id,
			projectId: input.projectId,
			enabled: input.enabled,
			cadence,
			autoApply,
			createdByUserId: user.id,
			// Tenant columns are copied from the PARENT DOCUMENT, not from the
			// caller's resolved context — the row must stay isolated with the
			// document it belongs to even if the two ever diverge.
			userId: document.userId ?? null,
			organizationId: document.organizationId ?? null,
		});

		return {
			enabled: settings.enabled,
			cadence: settings.cadence as DocumentRefreshCadence,
			autoApply: settings.autoApply,
			lastRefreshedAt: settings.lastRefreshedAt,
			lastRefreshStatus: settings.lastRefreshStatus,
			lastRefreshSummary: settings.lastRefreshSummary,
		};
	});
