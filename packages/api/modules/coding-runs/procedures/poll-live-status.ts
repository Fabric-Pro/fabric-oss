/**
 * Poll Live Status Procedure
 *
 * Polls the actual execution provider (Fabric Kanban / Vibe Workspace)
 * for real-time session status, bypassing the DB cache.
 * Returns enriched status for local agents that may have progressed
 * since the last Temporal poll cycle.
 */

import { ORPCError } from "@orpc/client";
import { getCodingRun, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const pollLiveStatusInput = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const pollLiveStatusProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs/{id}/live-status",
		tags: ["CodingRuns"],
		summary: "Poll live provider status for a coding run",
	})
	.input(pollLiveStatusInput)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const run = await getCodingRun(
			input.id,
			context.user.id,
			organizationId,
		);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Coding run not found",
			});
		}

		const canViewProject = await hasProjectAccess(
			run.projectId,
			context.user.id,
		);
		if (!canViewProject) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		if (!run.providerSessionId) {
			return {
				id: run.id,
				provider: run.provider,
				liveStatus: null,
				message: "No active provider session",
			};
		}

		try {
			// Dynamically import to avoid bundling Temporal deps in API
			const { getCodingExecutionProvider } = await import(
				"@repo/temporal/coding-execution"
			);

			const provider = getCodingExecutionProvider(run.provider);
			const status = await provider.getSessionStatus(
				run.providerSessionId,
			);

			const localRuntimeArtifact = status.artifacts.find(
				(a) => a.type === "local_runtime",
			);
			const prArtifact = status.artifacts.find(
				(a) => a.type === "pull_request" && a.url,
			);

			let sessionState: string | null = null;
			if (
				localRuntimeArtifact?.metadata &&
				typeof localRuntimeArtifact.metadata === "object"
			) {
				const meta = localRuntimeArtifact.metadata as Record<
					string,
					unknown
				>;
				sessionState =
					typeof meta.sessionState === "string"
						? meta.sessionState
						: null;
			}

			return {
				id: run.id,
				provider: run.provider,
				liveStatus: {
					providerStatus: status.status,
					sessionState,
					branchName: status.branchName,
					error: status.error ?? null,
					hasPullRequest: Boolean(prArtifact?.url),
					pullRequestUrl: prArtifact?.url ?? null,
				},
			};
		} catch (error) {
			return {
				id: run.id,
				provider: run.provider,
				liveStatus: null,
				message:
					error instanceof Error
						? `Provider unreachable: ${error.message}`
						: "Provider unreachable",
			};
		}
	});
