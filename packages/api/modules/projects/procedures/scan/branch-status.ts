import { ORPCError } from "@orpc/server";
import { AtlasService } from "@repo/atlas";
import {
	getLatestProjectScan,
	hasProjectAccess,
	listScanCheckpoints,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** The four states the branch-status panel badges per branch. */
export type BranchScanStatusValue =
	| "SCANNED"
	| "NOT_SCANNED"
	| "STALE"
	| "SCANNING";

/**
 * Derive a branch's scan status from its latest scan plus the live remote HEAD
 * vs the stored checkpoint SHA. Pure + exported for unit testing.
 *   - an in-flight scan (PENDING/RUNNING) wins → SCANNING
 *   - no checkpoint row for the branch → NOT_SCANNED
 *   - the branch advanced past the last-scanned commit → STALE
 *   - otherwise → SCANNED
 *
 * A null `headSha` (remote unreachable, or the provider omitted it) NEVER flags
 * STALE: an existing checkpoint reads SCANNED, so a transient listing hiccup
 * can't false-alarm every branch in the panel.
 */
export function deriveBranchScanStatus(args: {
	scanInFlight: boolean;
	headSha: string | null;
	checkpointSha: string | null;
}): BranchScanStatusValue {
	if (args.scanInFlight) {
		return "SCANNING";
	}
	if (!args.checkpointSha) {
		return "NOT_SCANNED";
	}
	if (args.headSha && args.headSha !== args.checkpointSha) {
		return "STALE";
	}
	return "SCANNED";
}

/**
 * Per-branch incremental-scan status for the branch panel: the connected repo's
 * live branches joined with each branch's last scan + checkpoint, so the UI can
 * badge Scanned / Stale / Not scanned / Scanning and show the live HEAD vs the
 * last-scanned commit. Degrades to an empty list (no repo connected, or the
 * remote can't be reached) rather than throwing — the panel then renders its
 * "connect a repository" empty state.
 */
export const listBranchScanStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/branches",
		tags: ["Projects", "Security"],
		summary: "List branches with their incremental-scan status",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, repositoryIntegrationId } = input;

		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Live branches + HEAD SHA, default/pinned first. AtlasService already
		// resolves the repo integration, credentials, and default/pinned set, and
		// returns [] (never throws) with no repo or an unreachable remote; guard the
		// unexpected throw too so the panel simply goes empty instead of erroring.
		const service = new AtlasService({
			userId: context.user.id,
			organizationId: organizationId ?? null,
		});
		let branches: Awaited<ReturnType<typeof service.listBranches>>;
		try {
			branches = await service.listBranches({
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? null,
			});
		} catch {
			return { branches: [] };
		}
		if (branches.length === 0) {
			return { branches: [] };
		}

		// One checkpoint row per scanned branch — its last-scanned commit + when.
		// Wrapped with the branch listing so any resolution error (remote or DB)
		// degrades to an empty panel rather than surfacing a 500.
		try {
			const checkpoints = await listScanCheckpoints(projectId);
			const checkpointByBranch = new Map(
				checkpoints.map((c) => [c.branch, c] as const),
			);

			return {
				// One latest-scan lookup per branch. The branch set is small (default +
				// pinned + the remote listing), so per-branch is fine for v1; run them
				// concurrently rather than in series. A batched "latest scan per branch"
				// helper can replace this if the branch count ever grows.
				branches: await Promise.all(
					branches.map(async (branch) => {
						const headSha = branch.commitSha ?? null;
						const checkpoint =
							checkpointByBranch.get(branch.name) ?? null;
						const scan = await getLatestProjectScan(projectId, {
							branch: branch.name,
						});
						const scanInFlight =
							scan?.status === "PENDING" ||
							scan?.status === "RUNNING";
						return {
							name: branch.name,
							isDefault: branch.isDefault,
							isPinned: branch.isPinned,
							headSha,
							status: deriveBranchScanStatus({
								scanInFlight,
								headSha,
								checkpointSha: checkpoint?.commitSha ?? null,
							}),
							lastScan: scan
								? {
										id: scan.id,
										status: scan.status,
										completedAt: scan.completedAt,
										securityFindingCount:
											scan.securityFindingCount,
										accessibilityFindingCount:
											scan.accessibilityFindingCount,
									}
								: null,
							checkpointSha: checkpoint?.commitSha ?? null,
							lastScannedAt: checkpoint?.lastScannedAt ?? null,
							// Diff-scope telemetry the advancing scan captured — how
							// many files/commits it covered. Powers the panel's "N
							// changed files · M commits" line; null when the checkpoint
							// predates the telemetry or the run didn't record it.
							changedFileCount:
								checkpoint?.changedFileCount ?? null,
							changedCommitCount:
								checkpoint?.changedCommitCount ?? null,
						};
					}),
				),
			};
		} catch {
			return { branches: [] };
		}
	});
