import { ORPCError } from "@orpc/server";
import { hasProjectAccess, isFeatureEnabled } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Fetch a personal meeting's transcript on demand.
 *
 * PRIVACY CONTRACT: the transcript body exists only for the lifetime of this
 * request and the browser tab that receives it. It is never written to the
 * database, never cached in Redis, never embedded, and never passed to a
 * Temporal workflow (whose event history would persist it).
 *
 * Modelled on documents/fetch-meeting-notes.ts, with two deliberate
 * differences: no 15k truncation (a human reads and downloads this, so
 * truncating is data loss — the cap there exists because those notes feed an
 * LLM prompt), and the transcript-permission 403 is surfaced as a distinct
 * reason so the UI can say "ask your IT admin" instead of "failed".
 */

/**
 * Transcript selection, formatting, and the Graph chain now live in
 * personal-transcript-fetch.ts so getPersonalInsights can share the exact same
 * privacy-critical read. Re-exported here because these are part of this
 * module's tested surface.
 */
export {
	formatTranscript,
	selectTranscriptId,
} from "./personal-transcript-fetch";

import { fetchPersonalTranscriptContent } from "./personal-transcript-fetch";

export const getPersonalTranscriptProcedure = tenantProtectedProcedure
	// requireInputOrgPermission verifies membership of the org the CALLER
	// supplied. requireProjectPermission does not close this: it resolves on
	// (projectId, userId) and never reads the org, and hasProjectAccess ignores
	// its third argument outright. Without this a caller could pair a project
	// they legitimately reach with an organization they do not belong to — the
	// exact shape that shipped a cross-tenant read in open-decisions (#1899
	// ratchet, SOC 2 CC6.1/CC6.3).
	.use(requireInputOrgPermission(Permissions.PROJECT_READ))
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/personal/transcript",
		tags: ["Projects", "Meeting Digest"],
		summary: "Fetch a personal meeting transcript on demand",
		description:
			"Fetch the authenticated user's own meeting transcript live from Microsoft Graph. Never persisted.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			joinUrl: z.string(),
			startTime: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PERSONAL_MEETINGS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Personal meetings are not enabled.",
			});
		}

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

		const callGraph = (methodName: string, args: Record<string, unknown>) =>
			executeMicrosoftTeamsTool(
				methodName,
				args,
				user.id,
				organizationId ?? undefined,
			);

		try {
			const result = await fetchPersonalTranscriptContent({
				callGraph,
				joinUrl: input.joinUrl,
				startTime: input.startTime,
			});

			// Project the Graph ids back out (#2170). The shared fetcher now
			// reports them so the import procedure can key its duplicate check
			// on the exact occurrence, but this read is the one the browser
			// receives: widening its response would hand the page identifiers it
			// has no use for, and every field this endpoint returns is a field
			// somebody can come to depend on.
			return result.content === null
				? { content: null, reason: result.reason }
				: { content: result.content };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to fetch personal transcript: ${message}`,
			});
		}
	});
