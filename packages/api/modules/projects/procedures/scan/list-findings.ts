import { ORPCError } from "@orpc/server";
import {
	getLatestProjectScan,
	hasProjectAccess,
	listScanFindings,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listFindingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/findings",
		tags: ["Projects", "Security"],
		summary: "List scan findings",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			category: z.enum(["SECURITY", "ACCESSIBILITY"]).optional(),
			severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
			status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
			storyId: z.string().optional(),
			scanId: z.string().optional(),
			// Branch-aware results: when set, the default view scopes to the
			// latest COMPLETED scan that ran against this branch (an explicit
			// `scanId` still wins). Omitted ⇒ latest completed regardless of
			// branch (current behavior).
			branch: z.string().max(255).optional(),
			// Engine/scan-type filter (G12) — translated to ruleSource/category
			// where-clauses by the query layer. AI_SECURITY / AI_ACCESSIBILITY are
			// the LLM reviewers; SEMGREP / GIT_HISTORY are the repo engines.
			scanner: z
				.enum([
					"AI_SECURITY",
					"AI_ACCESSIBILITY",
					"SEMGREP",
					"GIT_HISTORY",
				])
				.optional(),
			// Sort key (G1). Defaults to recency when omitted; "severity" orders
			// CRITICAL→LOW, "confidence" orders most-confident first.
			sort: z.enum(["severity", "confidence"]).optional(),
			// Confidence-band filter for the deterministic default view.
			// `minConfidence` keeps the shown set (at/above the floor, plus legacy
			// null rows); `maxConfidence` keeps the collapsed low-confidence bucket
			// (strictly below the floor). Zero-LLM-cost — holds even with the AI
			// review off.
			minConfidence: z.number().min(0).max(1).optional(),
			maxConfidence: z.number().min(0).max(1).optional(),
			limit: z.number().min(1).max(500).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// `branch` scopes the default latest-scan lookup only (it is NOT a
		// ScanFinding column); pull it out so it never reaches listScanFindings.
		const { projectId, organizationId, branch, ...filters } = input;
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

		// Default the view to the most recent COMPLETED scan so re-running a
		// scan replaces the displayed findings instead of stacking the new run
		// on top of every previous run's. An explicit `scanId` (e.g. a future
		// run-history view) still wins, and scoping to the latest *completed*
		// run keeps prior results visible while a new scan is in flight.
		const resolvedFilters = { ...filters };
		if (!resolvedFilters.scanId) {
			const latestCompleted = await getLatestProjectScan(projectId, {
				storyId: resolvedFilters.storyId ?? null,
				status: "COMPLETED",
				// Only scope by branch when the caller asked for it, so the
				// default (no branch) keeps the current cross-branch behavior.
				...(branch !== undefined ? { branch } : {}),
			});
			if (!latestCompleted) {
				return { findings: [] };
			}
			resolvedFilters.scanId = latestCompleted.id;
		}

		const findings = await listScanFindings(projectId, resolvedFilters);
		return { findings };
	});
