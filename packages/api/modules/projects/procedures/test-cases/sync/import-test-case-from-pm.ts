import { ORPCError } from "@orpc/client";
import { db, getTestCase } from "@repo/database";
import {
	createOrUpdateTestCaseFromPMItem,
	discoverPMToolCapabilities,
	fetchPMItemsByIds,
} from "@repo/temporal/activities";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCaseSyncSupported } from "../../../lib/pm-test-case-sync-capability";
import { resolvePmTarget } from "../../../lib/resolve-pm-target";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";
import { mirrorTestCaseToContext } from "../sync-context";

/**
 * Import a single PM item into a Fabric test case (the synchronous pull
 * counterpart of `importFromPMProcedure`). Fetches the item through the
 * entity-agnostic `fetchPMItemsByIds` (MCP or GitLab REST, decided by
 * `resolvePmTarget`), upserts a `TestCase` via the shared
 * `createOrUpdateTestCaseFromPMItem` activity (which records the `pull`
 * `PmSyncLog{entityType:"TEST_CASE"}` and parses steps back from the body), then
 * mirrors the case into the project RAG store.
 */
export const importTestCaseFromPmProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/import-from-pm",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Import a test case from the PM tool",
		description:
			"Import a specific work item from the configured PM tool by its external ID, upserting it as a Fabric test case.",
	})
	.input(
		z.object({
			projectId: z.string(),
			externalId: z.string().min(1, "External ID is required"),
			overwrite: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) above is the
		// real cross-tenant boundary — it resolves the project's own org and
		// checks the caller's org role / ProjectMember row (FORBIDDEN otherwise),
		// so reaching here means the caller may update this project. Look the
		// project up by id alone, exactly like the sibling `listPmTestCases` /
		// `pmCapabilities` sync procedures; `project.organizationId` below scopes
		// every downstream PM call. (A previous context-derived tenant filter here
		// wrongly 404'd org projects: the tenant context resolves to personal/null
		// on this route, so the filter excluded the org-owned project.)
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings before importing test cases.",
			});
		}

		// Resolve the dispatch target (MCP or GitLab REST) — the same resolver the
		// bulk sync uses, so import works for every connected PM tool with no fork.
		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					project.projectManagementMcpConfigId,
				organizationId: project.organizationId,
			},
			userId: user.id,
			organizationId: project.organizationId,
		});

		if (!target) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Connect a project management tool in Integrations, then select it in Project Settings → Project Management.",
			});
		}

		// Only pull from a tool that holds native test cases — never import a plain
		// issue and pass it off as a test case.
		await assertTestCaseSyncSupported(target, "pull", {
			userId: user.id,
			organizationId: project.organizationId,
		});

		// Find any case linked to this PM item — INCLUDING soft-deleted ones — so
		// "already imported" (a live case, which blocks a non-overwrite import) is
		// distinguished from "imported then removed" (a soft-deleted case, which is
		// resurrected below).
		const existing = await db.testCase.findFirst({
			where: {
				projectId: input.projectId,
				externalId: input.externalId,
			},
			select: { id: true, identifier: true, deletedAt: true },
		});
		if (existing && !existing.deletedAt && !input.overwrite) {
			throw new ORPCError("CONFLICT", {
				message: `Test case with external ID "${input.externalId}" already exists: ${existing.identifier}`,
			});
		}

		const projectOrgId = project.organizationId ?? undefined;

		try {
			// Discover the tool type so ADO uses the project name as the container
			// (the get-by-id path expects it) and the upsert can parse native ADO
			// step XML back. The REST-GitLab path skips MCP discovery.
			let toolKey: string | null = null;
			let containerValue = project.projectManagementContainerId;
			if (target.kind === "mcp") {
				const capabilities = await discoverPMToolCapabilities({
					mcpConfigId: target.mcpConfigId,
					userId: user.id,
					organizationId: projectOrgId,
				});
				toolKey = capabilities?.detectedType ?? null;
				if (capabilities?.detectedType === "azure-devops") {
					containerValue =
						project.projectManagementContainerName ??
						project.projectManagementContainerId;
				}
			} else {
				toolKey = "gitlab";
			}

			const additionalContext =
				(project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null) ?? undefined;

			const fetched = await fetchPMItemsByIds({
				mcpConfigId: target.kind === "mcp" ? target.mcpConfigId : null,
				mcpServerId: project.projectManagementMcpServerId ?? undefined,
				containerId: containerValue,
				externalIds: [input.externalId],
				additionalContext,
				userId: user.id,
				organizationId: projectOrgId,
			});

			const item =
				fetched.items.find((i) => i.id === input.externalId) ??
				fetched.items[0];
			if (!item) {
				// Surface the adapter's real reason (auth, wrong board, MCP tool
				// error) when it has one, instead of a flat "not found" — a
				// mis-scoped fetch is otherwise indistinguishable from a genuinely
				// absent work item.
				const reason = fetched.failedIdErrors?.[input.externalId];
				throw new ORPCError("NOT_FOUND", {
					message: reason
						? `Couldn't import work item "${input.externalId}" from the PM tool: ${reason}`
						: `Work item "${input.externalId}" was not found in the PM tool.`,
				});
			}

			// Resurrect a soft-deleted case IN PLACE before the upsert (only now
			// that the fetch has succeeded, so a failed import never undeletes).
			// The partial unique index `(projectId, externalId) WHERE externalId IS
			// NOT NULL` counts soft-deleted rows, so a fresh create would collide;
			// undeleting lets `createOrUpdateTestCaseFromPMItem` take its UPDATE
			// path and refresh the restored case instead.
			if (existing?.deletedAt) {
				await db.testCase.update({
					where: { id: existing.id },
					data: { deletedAt: null },
				});
			}

			// Upsert the case. The activity records the `pull` PmSyncLog row
			// (entityType "TEST_CASE") and parses steps back from the body.
			const result = await createOrUpdateTestCaseFromPMItem({
				projectId: input.projectId,
				externalId: input.externalId,
				title: item.title ?? `Imported: ${input.externalId}`,
				description: item.description ?? null,
				externalUrl: item.url ?? null,
				externalMcpServerId:
					project.projectManagementMcpServerId ?? null,
				userId: user.id,
				organizationId: projectOrgId,
				toolKey,
			});

			// RAG mirror — load the freshly-upserted detail and embed it.
			const detail = await getTestCase({
				id: result.testCaseId,
				projectId: input.projectId,
			});
			if (detail) {
				await mirrorTestCaseToContext(detail, {
					userId: user.id,
					organizationId: project.organizationId,
				});
			}

			return {
				success: true,
				testCase: detail,
				imported: {
					title: item.title ?? `Imported: ${input.externalId}`,
					externalId: input.externalId,
					externalUrl: item.url ?? null,
					created: result.created,
				},
			};
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to import test case from PM tool",
			});
		}
	});
