/**
 * Backfill: set a PM container for GitLab projects wired to `gitlab-official`
 * that are missing one.
 *
 * Context: a project can end up pointed at the `gitlab-official` MCP server
 * (e.g. from the create-from-repo flow) while `projectManagementContainerId`
 * stays null — for instance when the auto-wire's numeric-id lookup failed on an
 * expired token at connect time. `get-pm-capabilities` returns
 * `capabilities: null` whenever the container is null, which hides the
 * Pull/Push button. This sets the container to the connected repo's
 * `owner/name` path (GitLab REST accepts a URL-encoded path as `project_id`),
 * so the button renders and REST sync works.
 *
 * Unlike `backfill-gitlab-pm.ts`, this does NOT call GitLab or touch
 * credentials, so it works even when stored tokens are expired. Token refresh
 * is handled at use-time by the integration layer.
 *
 * The container is recorded with the repository's GitLab instance
 * (`gitlabOrigin`, see `recordedGitLabPmOrigin`): the path names a project on
 * that instance only. A repository whose address is not an allowed GitLab
 * address is skipped.
 *
 * Idempotent: only fills NULL containers; never overwrites an existing one.
 *
 * Run from the repo root with the target environment's DATABASE_URL loaded:
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-container.ts --dry-run
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-container.ts
 */
import { db, type Prisma } from "@repo/database";
import {
	GITLAB_DEFAULT_ORIGIN,
	parseGitLabOrigin,
	withGitLabPmOrigin,
} from "@repo/integrations/gitlab";

const GITLAB_OFFICIAL_KEY = "gitlab-official";

async function main() {
	const dryRun = process.argv.slice(2).includes("--dry-run");

	const server = await db.mCPServer.findFirst({
		where: { key: GITLAB_OFFICIAL_KEY },
		select: { id: true },
	});
	if (!server) {
		console.log(
			`[backfill-container] no '${GITLAB_OFFICIAL_KEY}' MCPServer row — run the seeds first. Nothing to do.`,
		);
		return;
	}

	const projects = await db.project.findMany({
		where: {
			projectManagementMcpServerId: server.id,
			projectManagementContainerId: null,
		},
		select: {
			id: true,
			name: true,
			projectManagementAdditionalContext: true,
		},
	});

	console.log(
		`[backfill-container] ${projects.length} gitlab-official project(s) with a null container${
			dryRun ? " — DRY RUN" : ""
		}`,
	);

	let updated = 0;
	let skipped = 0;

	for (const project of projects) {
		const repo = await db.projectRepositoryIntegration.findFirst({
			where: { projectId: project.id, provider: "GITLAB" },
			select: {
				repositoryOwner: true,
				repositoryName: true,
				repositoryUrl: true,
			},
			orderBy: { createdAt: "desc" },
		});
		if (!repo) {
			skipped++;
			console.log(
				`[skip] ${project.name} (${project.id}): no GitLab repo integration to derive a container from`,
			);
			continue;
		}

		const containerPath = `${repo.repositoryOwner}/${repo.repositoryName}`;
		// A repository recorded without a URL predates self-hosted GitLab.
		const repositoryOrigin = repo.repositoryUrl
			? parseGitLabOrigin(repo.repositoryUrl)
			: ({ ok: true, origin: GITLAB_DEFAULT_ORIGIN } as const);
		if (!repositoryOrigin.ok) {
			skipped++;
			console.log(
				`[skip] ${project.name} (${project.id}): the repository's GitLab address is not allowed (${repositoryOrigin.reason})`,
			);
			continue;
		}
		if (dryRun) {
			console.log(
				`[dry-run] would set container for ${project.name} -> ${containerPath}`,
			);
			updated++;
			continue;
		}

		await db.project.update({
			where: { id: project.id },
			data: {
				projectManagementContainerId: containerPath,
				projectManagementContainerName: containerPath,
				projectManagementAdditionalContext: withGitLabPmOrigin(
					project.projectManagementAdditionalContext,
					repositoryOrigin.origin,
				) as Prisma.InputJsonValue,
			},
		});
		updated++;
		console.log(`[set] ${project.name} -> ${containerPath}`);
	}

	console.log(
		`[backfill-container] done — updated: ${updated}, skipped: ${skipped}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("[backfill-container] fatal error", err);
		process.exit(1);
	});
