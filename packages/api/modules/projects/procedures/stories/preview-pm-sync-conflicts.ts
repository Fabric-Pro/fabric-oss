import { ORPCError } from "@orpc/client";
import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const PmSyncItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

const PmSyncConflictItemSchema = z.object({
	id: z.string(),
	itemType: PmSyncItemTypeSchema,
	hasConflict: z.boolean(),
	pmCurrent: z
		.object({
			title: z.string(),
			description: z.string(),
			lastChangedBy: z.string().nullable(),
			lastChangedAt: z.string().nullable(),
		})
		.optional(),
	pmUrl: z.string().optional(),
	// Project-level PM tool key (e.g. "azure-devops"), derived in the handler
	// from the project's MCP server — NOT from the preview activity. `null`
	// when no PM tool is linked. Mirrors Chunk A's review-center derivation.
	pmTool: z.string().nullable(),
	// Why the PM side could not be loaded (credentials missing/expired, etc).
	// When set, `pmCurrent` is absent and the UI shows an actionable error
	// instead of a blank diff. Kept in sync with `PmSyncErrorKind` in
	// packages/temporal/.../preview-pm-sync-conflict.ts.
	pmError: z
		.object({
			kind: z.enum([
				"MISSING",
				"EXPIRED",
				"INVALID",
				"DISABLED",
				"NO_ACCESS",
				"TRANSIENT",
				"NOT_CONFIGURED",
			]),
			code: z.string().optional(),
		})
		.optional(),
});

const InputItemSchema = z.object({
	id: z.string().cuid(),
	itemType: PmSyncItemTypeSchema,
});

/**
 * Read-only check of PM-side drift for synced hierarchy items (stories,
 * bugs, features, epics). Used by the AI Update proposal to flag conflicts
 * before approve.
 */
export const checkPmSyncConflictsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/check-pm-sync-conflicts",
		tags: ["Projects", "Stories"],
		summary: "Check PM sync conflicts for a batch of hierarchy items",
		description:
			"Read-only check of PM-side drift for synced hierarchy items. Items must include `itemType` so the right baseline column is loaded.",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			items: z.array(InputItemSchema).max(200),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			results: z.array(PmSyncConflictItemSchema),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (input.items.length === 0) {
			return { results: [] };
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpConfigId: true,
				projectManagementMcpServerId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Derive the project-level PM tool key once (e.g. "azure-devops") from
		// the project's MCP server → MCPServer.key. The subtitle needs "in
		// {PM tool}"; the preview activity does not surface a tool name, so we
		// resolve it here (mirrors review-center's resolveProjectPmTool).
		//
		// `projectManagementMcpServerId` may carry a `key:` sentinel (PR #1205 —
		// catalog row missing, key stored inline) instead of a real id. The
		// sentinel-reading helper handles both shapes so GitLab REST projects
		// resolve correctly (`key:gitlab-official` → `"gitlab-official"`).
		let pmTool: string | null = null;
		if (project.projectManagementMcpServerId) {
			if (isPmServerIdKeySentinel(project.projectManagementMcpServerId)) {
				pmTool = readPmServerIdKeySentinel(
					project.projectManagementMcpServerId,
				);
			} else {
				const server = await db.mCPServer.findUnique({
					where: { id: project.projectManagementMcpServerId },
					select: { key: true },
				});
				pmTool = server?.key ?? null;
			}
		}

		// GitLab REST fallback path: the project has NO `mcpConfigId` but is
		// configured as GitLab (`mcpServerId === "key:gitlab-official"` or a
		// catalog row with `key = "gitlab-official"`). We DON'T short-circuit
		// here — the preview activity has a REST branch that resolves the
		// source and fetches via `callPmToolWithFallback`. Without this, the
		// conflict resolve modal opened with empty TITLE / DESCRIPTION on the
		// PM side for GitLab REST projects.
		const isGitLabRestProject =
			!project.projectManagementMcpConfigId &&
			pmTool === "gitlab-official";

		if (!project.projectManagementContainerId) {
			return {
				results: input.items.map((item) => ({
					id: item.id,
					itemType: item.itemType,
					hasConflict: false,
					pmTool,
				})),
			};
		}

		if (!project.projectManagementMcpConfigId && !isGitLabRestProject) {
			return {
				results: input.items.map((item) => ({
					id: item.id,
					itemType: item.itemType,
					hasConflict: false,
					pmTool,
				})),
			};
		}

		// Tenant-validate each item + filter to rows that have an externalId
		// (otherwise the preview workflow would short-circuit anyway). Stories
		// are the only work-item rows — legacy `epic`/`feature` item types
		// can't resolve a row (the folder tables were dropped), so they are
		// filtered out here.
		const storyIds = input.items
			.filter((i) => i.itemType === "story" || i.itemType === "bug")
			.map((i) => i.id);

		const ownedStories =
			storyIds.length > 0
				? await db.userStory.findMany({
						where: {
							id: { in: storyIds },
							projectId: input.projectId,
							externalId: { not: null },
						},
						select: { id: true },
					})
				: ([] as Array<{ id: string }>);

		const ownedStoryIds = new Set(ownedStories.map((s) => s.id));

		const filteredItems = input.items.filter(
			(item) =>
				(item.itemType === "story" || item.itemType === "bug") &&
				ownedStoryIds.has(item.id),
		);

		if (filteredItems.length === 0) {
			return {
				results: input.items.map((item) => ({
					id: item.id,
					itemType: item.itemType,
					hasConflict: false,
					pmTool,
				})),
			};
		}

		const additionalContext =
			(project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null) ?? undefined;

		const client = await getTemporalClient();
		const workflowId = `pm-sync-preview-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"pmSyncPreviewConflictsWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				args: [
					{
						items: filteredItems.map((i) => ({
							id: i.id,
							itemType: i.itemType,
						})),
						projectId: input.projectId,
						// `null` on the GitLab REST fallback path so the activity
						// routes through `resolvePmSource` + `callPmToolWithFallback`
						// instead of the MCP pipeline.
						mcpConfigId: project.projectManagementMcpConfigId,
						mcpServerId:
							project.projectManagementMcpServerId ?? undefined,
						containerId: project.projectManagementContainerId,
						containerName:
							project.projectManagementContainerName ?? undefined,
						additionalContext,
						userId: user.id,
						organizationId:
							organizationId ??
							project.organizationId ??
							undefined,
					},
				],
			}),
		);

		const output = (await handle.result()) as {
			results: Array<{
				id: string;
				itemType: "epic" | "feature" | "story" | "bug";
				hasConflict: boolean;
				pmCurrent?: {
					title: string;
					description: string;
					lastChangedBy: string | null;
					lastChangedAt: string | null;
				};
				pmUrl?: string;
				pmError?: {
					kind:
						| "MISSING"
						| "EXPIRED"
						| "INVALID"
						| "DISABLED"
						| "NO_ACCESS"
						| "TRANSIENT"
						| "NOT_CONFIGURED";
					code?: string;
				};
			}>;
		};

		const byKey = new Map(
			output.results.map((r) => [`${r.itemType}:${r.id}`, r]),
		);

		return {
			results: input.items.map((item) => {
				const found = byKey.get(`${item.itemType}:${item.id}`);
				return found
					? { ...found, pmTool }
					: {
							id: item.id,
							itemType: item.itemType,
							hasConflict: false,
							pmTool,
						};
			}),
		};
	});
