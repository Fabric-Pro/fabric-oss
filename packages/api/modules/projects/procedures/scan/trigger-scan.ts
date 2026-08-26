import { ORPCError } from "@orpc/server";
import {
	deleteOpenProjectScanFindings,
	getProjectScanConfig,
	hasActiveScan,
	hasProjectAccess,
	recordScanActivity,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { startProjectScan } from "./lib/start-scan";

export const triggerScanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/trigger",
		tags: ["Projects", "Security"],
		summary: "Trigger a security & accessibility scan",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// When set, scans a single feature; otherwise scans the project.
			storyId: z.string().optional(),
			// FULL re-scans everything; INCREMENTAL only items changed since the
			// last completed scan (carrying unchanged findings forward).
			mode: z.enum(["FULL", "INCREMENTAL"]).optional(),
			// Purge re-scan (G10): DELETE the project's current OPEN findings, then
			// run a FULL scan that re-grades severity fresh. RESOLVED/DISMISSED
			// findings are preserved (the delete is OPEN-only). PROJECT-scope only
			// — ignored for a feature-scoped scan.
			purgeUnresolved: z.boolean().optional(),
			// Branch-targeted triggering. `branch` scans a single ref; `branches`
			// fans out one scan per ref (bulk); absent ⇒ the configured/default
			// branch (current behavior). `forceFull` skips the incremental diff so
			// the code scanners re-read the whole tree even when a checkpoint exists.
			branch: z.string().max(255).optional(),
			branches: z.array(z.string().max(255)).max(50).optional(),
			forceFull: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			projectId,
			organizationId,
			storyId,
			mode,
			purgeUnresolved,
			branch,
			branches,
			forceFull,
		} = input;
		const user = context.user;

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const config = await getProjectScanConfig(projectId);
		// Repo-based scanners (Semgrep SAST + git-history secrets) only run on a
		// project-wide scan; a feature-scoped scan reviews planning text, so it
		// needs an AI reviewer enabled. Mirror the same scope rule as
		// `startProjectScan`.
		const projectScope = !storyId;
		const codeScannersEnabled =
			projectScope && (config.semgrepEnabled || config.gitHistoryEnabled);
		if (
			!config.securityEnabled &&
			!config.accessibilityEnabled &&
			!codeScannersEnabled
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Enable at least one scanner before running a scan.",
			});
		}

		// Purge re-scan (G10) — PROJECT-scope only. Delete the current OPEN
		// findings first (tenant-scoped), record the page-history entry, then force
		// a FULL scan threaded with `purge: true` so persist re-grades severity
		// fresh. RESOLVED/DISMISSED rows are preserved (the delete is OPEN-only).
		const purge = purgeUnresolved === true && !storyId;
		if (purge) {
			const deleted = await deleteOpenProjectScanFindings(projectId, {
				userId: user.id,
				organizationId: organizationId ?? null,
			});
			await recordScanActivity({
				projectId,
				type: "FINDINGS_PURGED",
				userId: user.id,
				organizationId: organizationId ?? null,
				summary: `Deleted ${deleted} unresolved finding${
					deleted === 1 ? "" : "s"
				} and re-scanned`,
			}).catch(() => {});
		}

		// Which branch(es) to scan. A bulk `branches` set fans out one scan per
		// ref; a single `branch` scans just that ref; the default (undefined) lets
		// start-scan resolve the configured/default branch (current behavior). A
		// purge is PROJECT-scope only — it ignores branch targeting and runs once.
		const targets: Array<string | undefined> = purge
			? [undefined]
			: (branches ?? (branch ? [branch] : [undefined]));

		const started: Array<{
			branch: string | undefined;
			scanId: string;
			workflowId: string;
		}> = [];
		const skipped: Array<{
			branch: string | undefined;
			reason: "already-scanning";
		}> = [];

		// No client-side "nothing changed" no-op guard: an INCREMENTAL scan on an
		// up-to-date branch already fast-paths to ~zero token cost in the workflow
		// (zero changed files → Semgrep early-returns; zero new commits → gitleaks
		// DIFF is empty; zero changed planning items → the AI scanners skip), and
		// carry-forward preserves the prior findings — so FR4's "no re-processing /
		// no tokens" holds without a redundant, stale-REST-prone HEAD pre-check here.
		for (const target of targets) {
			// Dedupe: a branch already mid-scan is skipped rather than doubled up.
			if (await hasActiveScan(projectId, { branch: target })) {
				skipped.push({ branch: target, reason: "already-scanning" });
				continue;
			}

			const result = await startProjectScan({
				projectId,
				storyId: storyId ?? null,
				targetType: storyId ? "FEATURE" : "PROJECT",
				trigger: "MANUAL",
				// A purge always re-scans everything fresh.
				mode: purge ? "FULL" : (mode ?? "FULL"),
				userId: user.id,
				organizationId: organizationId ?? null,
				securityEnabled: config.securityEnabled,
				accessibilityEnabled: config.accessibilityEnabled,
				semgrepEnabled: config.semgrepEnabled,
				gitHistoryEnabled: config.gitHistoryEnabled,
				purge,
				branch: target,
				forceFull,
			});
			if (!result) {
				throw new ORPCError("BAD_REQUEST", {
					message: "No scanner is enabled for this project.",
				});
			}
			started.push({
				branch: target,
				scanId: result.scanId,
				workflowId: result.workflowId,
			});
		}

		return { started, skipped };
	});
