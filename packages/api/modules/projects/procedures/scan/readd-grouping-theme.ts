import { ORPCError } from "@orpc/server";
import {
	db,
	ensureFabricSystemUser,
	type GroupingCreatedTheme,
	type GroupingRunResults,
	getScanFindingGrouping,
	hasProjectAccess,
	removeDeclinedGroupingTheme,
	updateScanFindingGrouping,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { createGroupingTicket } from "../../lib/create-grouping-ticket";

/**
 * Re-add a previously declined grouping ticket: create it immediately from the
 * body drafted on the latest run, clear its durable declined state (so it stops
 * re-appearing as declined), and reflect the change in the run's results. PM
 * sync defaults ON when a PM tool is configured (override via `syncToPM`).
 */
export const readdGroupingThemeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/grouping/readd",
		tags: ["Projects", "Security"],
		summary: "Re-add a previously declined grouping ticket",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			groupingId: z.string().min(1),
			themeKey: z.string().min(1),
			syncToPM: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, groupingId, themeKey } = input;
		const organizationId = input.organizationId ?? null;
		const userId = context.user.id;

		const hasAccess = await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const run = await getScanFindingGrouping(groupingId, projectId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Grouping run not found",
			});
		}

		const results = (run.results ?? {}) as GroupingRunResults;
		const declined = results.declinedThemes ?? [];
		const proposal = declined.find((p) => p.themeKey === themeKey);
		if (!proposal) {
			throw new ORPCError("NOT_FOUND", {
				message: "This theme is not available to re-add",
			});
		}

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
			},
		});
		const pmConfigured =
			!!project?.projectManagementMcpConfigId &&
			!!project?.projectManagementContainerId;
		const doSync = (input.syncToPM ?? true) && pmConfigured;

		await ensureFabricSystemUser();
		const { storyId, storyIdentifier } = await createGroupingTicket(
			proposal,
			{
				projectId,
				organizationId,
				userId,
				doSync,
			},
		);

		// Clear the durable declined state + reflect in the run's results (move
		// the theme from declinedThemes into createdThemes).
		await removeDeclinedGroupingTheme(projectId, themeKey);

		const created: GroupingCreatedTheme = {
			category: proposal.category,
			ruleSource: proposal.ruleSource,
			themeKey: proposal.themeKey,
			findingCount: proposal.findingCount,
			storyId,
			storyIdentifier,
		};
		const nextCreated = [...(results.createdThemes ?? []), created];
		const newResults: GroupingRunResults = {
			...results,
			declinedThemes: declined.filter((p) => p.themeKey !== themeKey),
			createdThemes: nextCreated,
		};
		await updateScanFindingGrouping(groupingId, {
			results: newResults,
			createdCount: nextCreated.length,
		});

		return { storyId, storyIdentifier };
	});
