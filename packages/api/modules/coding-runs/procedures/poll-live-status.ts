/**
 * Poll Live Status Procedure
 *
 * Polls the actual execution provider (Fabric Kanban / Vibe Workspace)
 * for real-time session status, bypassing the DB cache.
 * Returns enriched status for local agents that may have progressed
 * since the last Temporal poll cycle.
 */

import { ORPCError } from "@orpc/client";
import { getCodingRun } from "@repo/database";
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

		// Only local providers benefit from live polling
		if (run.provider !== "KANBAN_LOCAL") {
			return {
				id: run.id,
				provider: run.provider,
				liveStatus: null,
				message: "Live polling only available for local providers",
			};
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
					hasPullRequest: status.artifacts.some(
						(a) => a.type === "pull_request" && a.url,
					),
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
