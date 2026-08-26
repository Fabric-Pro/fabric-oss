import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	getCachedMeetings,
	setCachedMeetings,
} from "../../../../lib/meetings-cache";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * List calendar meetings for the backlog updater meeting selector.
 *
 * Calls the Microsoft Graph API to list recent calendar events
 * from the last 30 days that have a joinUrl (Teams online meetings).
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */
export const listCalendarMeetingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/meetings",
		tags: ["Projects", "Backlog"],
		summary: "List calendar meetings",
		description:
			"List recent Teams calendar meetings for the backlog context analysis meeting selector",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** Number of days back to fetch meetings. Defaults to 30. Max 90. */
			daysBack: z.number().int().min(1).max(90).optional().default(30),
			/**
			 * When true, bypass the per-user server cache and fetch fresh from
			 * Microsoft Graph (used by the manual "Refresh" control in the UI).
			 */
			forceRefresh: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
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

		// List calendar meetings from the requested date range (default 30 days)
		const daysBack = input.daysBack ?? 30;

		// Serve from the per-user short-TTL cache unless the caller forces a
		// refresh. The cache transparently no-ops when Redis isn't configured,
		// so behavior is identical to a direct Graph call in that case.
		if (!input.forceRefresh) {
			const cached = await getCachedMeetings(
				user.id,
				organizationId ?? null,
				daysBack,
			);
			if (cached) {
				return { meetings: cached };
			}
		}

		try {
			const now = new Date();
			const rangeStart = new Date(
				now.getTime() - daysBack * 24 * 60 * 60 * 1000,
			);

			const result = (await executeMicrosoftTeamsTool(
				"list_calendar_meetings",
				{
					startDate: rangeStart.toISOString(),
					endDate: now.toISOString(),
				},
				user.id,
				organizationId ?? undefined,
			)) as {
				meetings: Array<{
					id: string;
					subject: string;
					// executeMicrosoftTeamsTool flattens start.dateTime to a string
					start?: string;
					organizer?: { emailAddress?: { name?: string } };
					joinUrl?: string;
					isOnlineMeeting?: boolean;
				}>;
				count: number;
			};

			// Filter to only meetings with joinUrls. Each recurring instance has
			// its own event ID and may have a different transcript, so we keep
			// all instances (no joinUrl dedup).
			// Note: executeMicrosoftTeamsTool already flattens start.dateTime to a string `start` field
			const meetings = (result.meetings ?? [])
				.filter((m) => !!m.joinUrl)
				.map((m) => ({
					id: m.id,
					subject: m.subject || "Untitled Meeting",
					startTime: m.start,
					organizer: m.organizer?.emailAddress?.name || "Unknown",
					joinUrl: m.joinUrl || null,
				}));

			// Write-through: cache the successful result so repeated and cold
			// opens by this user are instant for the next 60s. The error and
			// "not connected" paths below are intentionally left uncached.
			await setCachedMeetings(
				user.id,
				organizationId ?? null,
				daysBack,
				meetings,
			);

			return { meetings };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			if (
				errorMessage.includes("Microsoft not connected") ||
				errorMessage.includes("Please connect your Microsoft account")
			) {
				return {
					meetings: [],
					error: "Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
				};
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to list calendar meetings: ${errorMessage}`,
			});
		}
	});
