import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { classifyTestCaseSyncSupport } from "./pm-test-case-sync-capability";
import { resolvePmTarget } from "./resolve-pm-target";

export interface EnqueueTestCaseAutoSyncInput {
	projectId: string;
	testCaseId: string;
	userId: string;
}

export interface EnqueueTestCaseAutoSyncResult {
	enqueued: boolean;
	reason?:
		| "not-linked"
		| "auto-sync-off"
		| "case-not-found"
		| "no-pm-config"
		| "no-target"
		| "unsupported"
		| "temporal-error";
	workflowId?: string;
}

/**
 * Fire-and-forget push of a SINGLE edited test case to its linked PM work item,
 * driven by the case's `pmAutoSyncEnabled` toggle. The test-case counterpart of
 * the stories' `enqueuePmSync` — but it starts `testCaseSyncWorkflow`
 * (`direction: "push"`, `testCaseIds: [id]`, `unsyncedOnly: false`) rather than
 * `pmSyncSingleStoryWorkflow`, because test cases have their own sync engine.
 *
 * Only pushes a case that is ALREADY LINKED (`externalId` set) with auto-sync
 * ON: an unlinked case has nowhere to push and the initial link is created by an
 * explicit "Sync now". It still verifies the connected tool holds native test
 * cases before enqueuing — a project can switch PM tools after a case was linked,
 * and a case must never auto-push into a tool that has no test-case concept.
 *
 * Callers MUST NOT await this for the edit's success — a sync failure must never
 * fail the edit that triggered it.
 */
export async function enqueueTestCaseAutoSync(
	input: EnqueueTestCaseAutoSyncInput,
): Promise<EnqueueTestCaseAutoSyncResult> {
	try {
		const testCase = await db.testCase.findFirst({
			where: {
				id: input.testCaseId,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: { id: true, externalId: true, pmAutoSyncEnabled: true },
		});
		if (!testCase) {
			return { enqueued: false, reason: "case-not-found" };
		}
		if (!testCase.externalId) {
			return { enqueued: false, reason: "not-linked" };
		}
		if (!testCase.pmAutoSyncEnabled) {
			return { enqueued: false, reason: "auto-sync-off" };
		}

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
		if (!project?.projectManagementContainerId) {
			return { enqueued: false, reason: "no-pm-config" };
		}

		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					project.projectManagementMcpConfigId,
				organizationId: project.organizationId,
			},
			userId: input.userId,
			organizationId: project.organizationId,
		});
		if (!target) {
			return { enqueued: false, reason: "no-target" };
		}

		// Gate on native test-case support — the tool-switch edge: a case linked
		// while the project used ADO must not silently auto-push once it points at a
		// tool with no test-case concept. SKIP only on a DEFINITIVE `unsupported`; a
		// can't-confirm probe (`unknown`, e.g. the MCP transiently down) must NOT
		// drop the auto-sync — the case was linked by a prior successful push, so
		// let the workflow re-check rather than skipping on a blip.
		const { support } = await classifyTestCaseSyncSupport(target, "push", {
			userId: input.userId,
			organizationId: project.organizationId,
		});
		if (support === "unsupported") {
			return { enqueued: false, reason: "unsupported" };
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const additionalContext =
			(project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null) ?? undefined;

		// Stable per-case workflow id so rapid successive edits de-duplicate
		// (USE_EXISTING) instead of racing parallel pushes; a completed run lets
		// the next edit start a fresh push (ALLOW_DUPLICATE).
		const workflowId = `test-case-autosync-${input.projectId}-${input.testCaseId}`;
		const handle = await client.workflow.start(
			"testCaseSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [
					{
						projectId: input.projectId,
						// biome-ignore lint/style/noNonNullAssertion: resolvePmTarget only returns non-null when a server id is present.
						mcpServerId: project.projectManagementMcpServerId!,
						mcpConfigId:
							target.kind === "mcp" ? target.mcpConfigId : null,
						containerId: project.projectManagementContainerId,
						containerName:
							project.projectManagementContainerName ?? undefined,
						additionalContext,
						userId: input.userId,
						organizationId: project.organizationId || undefined,
						testCaseIds: [input.testCaseId],
						unsyncedOnly: false,
						direction: "push" as const,
					},
				],
			}),
		);
		return { enqueued: true, workflowId: handle.workflowId };
	} catch (error) {
		logger.warn("enqueueTestCaseAutoSync failed to start", {
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			message: error instanceof Error ? error.message : String(error),
		});
		return { enqueued: false, reason: "temporal-error" };
	}
}
