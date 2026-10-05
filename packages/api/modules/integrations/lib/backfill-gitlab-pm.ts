import { db } from "@repo/database";
import {
	GITLAB_DEFAULT_ORIGIN,
	parseGitLabOrigin,
	readStoredGitLabConnectionStatus,
} from "@repo/integrations/gitlab";
import { enableGitLabPMForProject } from "./enable-gitlab-pm-for-project";

/**
 * The GitLab PM backfill (`scripts/backfill-gitlab-pm.ts`): for each ACTIVE
 * GitLab repository integration, wire the project's PM pointer through the
 * configuring person's own GitLab connection (`enableGitLabPMForProject`).
 *
 * A dry run changes NOTHING: it reads each connection as stored
 * (`readStoredGitLabConnectionStatus`, which neither classifies nor
 * refreshes) and reports what a real run would try.
 */
export async function backfillGitLabPm(args: {
	dryRun: boolean;
	projectId?: string;
	log?: (line: string) => void;
}): Promise<{ wired: number; skipped: number; failed: number }> {
	const { dryRun, projectId } = args;
	const log = args.log ?? ((line: string) => console.log(line));

	const integrations = await db.projectRepositoryIntegration.findMany({
		where: {
			provider: "GITLAB",
			status: "ACTIVE",
			configuredByUserId: { not: null },
			...(projectId ? { projectId } : {}),
		},
		select: {
			id: true,
			projectId: true,
			repositoryOwner: true,
			repositoryName: true,
			repositoryUrl: true,
			configuredByUserId: true,
		},
	});

	log(
		`[backfill] ${integrations.length} ACTIVE GitLab repo integration(s)${
			projectId ? ` (filtered to project ${projectId})` : ""
		}${dryRun ? " — DRY RUN" : ""}`,
	);

	let wired = 0;
	let skipped = 0;
	let failed = 0;

	for (const integ of integrations) {
		const label = `${integ.repositoryOwner}/${integ.repositoryName} (project ${integ.projectId})`;
		const userId = integ.configuredByUserId;
		if (!userId) {
			skipped++;
			log(`[skip] ${label}: no configuring user`);
			continue;
		}

		const project = await db.project.findUnique({
			where: { id: integ.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			skipped++;
			log(`[skip] ${label}: project not found`);
			continue;
		}

		if (dryRun) {
			const status = await readStoredGitLabConnectionStatus({
				userId,
				organizationId: project.organizationId ?? null,
			});
			// The connection row is the only place a GitLab connection
			// lives: a legacy MCP token copy is neither read nor counted.
			const usable = status.connected && !status.needsReauth;
			const connectionOrigin = status.origin || null;
			const repositoryOrigin = integ.repositoryUrl
				? parseGitLabOrigin(integ.repositoryUrl)
				: ({ ok: true, origin: GITLAB_DEFAULT_ORIGIN } as const);
			if (!usable) {
				skipped++;
				log(
					`[dry-run] ${label}: configuring user has no usable personal GitLab connection`,
				);
			} else if (
				!connectionOrigin ||
				!repositoryOrigin.ok ||
				repositoryOrigin.origin !== connectionOrigin
			) {
				skipped++;
				log(
					`[dry-run] ${label}: the repository is on another GitLab instance than the configuring user's connection`,
				);
			} else {
				wired++;
				log(
					`[dry-run] would try to wire PM for ${label} through the configuring user's GitLab connection`,
				);
			}
			continue;
		}

		try {
			const result = await enableGitLabPMForProject({
				userId,
				organizationId: project.organizationId ?? null,
				projectId: integ.projectId,
				repositoryOwner: integ.repositoryOwner,
				repositoryName: integ.repositoryName,
				repositoryUrl: integ.repositoryUrl,
			});

			if (result.pmWired) {
				wired++;
				log(`[wired] ${label}: PM container ${result.containerId}`);
			} else {
				skipped++;
				log(`[skip] ${label}: ${result.reason}`);
			}
		} catch (err) {
			failed++;
			console.error(`[fail] ${label}:`, err);
		}
	}

	log(
		`[backfill] done — wired: ${wired}, skipped: ${skipped}, failed: ${failed}`,
	);
	return { wired, skipped, failed };
}
