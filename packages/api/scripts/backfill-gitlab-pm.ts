/**
 * Backfill: enable GitLab as the PM tool for projects that were connected
 * repo-only (before the OAuth callback was unified).
 *
 * For each ACTIVE GitLab `ProjectRepositoryIntegration`, re-uses the stored
 * repo token to populate the per-user `WorkflowIntegration` + `MCPConfig` and
 * auto-wire the project's PM pointer (via `enableGitLabPMForProject`). The
 * clobber guard inside that helper protects projects that already use a
 * different PM tool.
 *
 * Idempotent: re-running upserts the stores and re-wires the pointer; projects
 * already on GitLab PM are unaffected.
 *
 * Run directly with tsx, from the repo root, with the target environment's
 * DATABASE_URL + token-encryption env loaded (e.g. via dotenv-cli):
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts --dry-run
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts --project-id <id>
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts   # apply to all
 */
import { db } from "@repo/database";
import { gitlabFetch } from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";
import { enableGitLabPMForProject } from "../modules/integrations/lib/enable-gitlab-pm-for-project";

type GitLabUser = {
	id: number;
	username: string;
	name: string | null;
	avatar_url: string | null;
};

function parseArgs() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const idx = args.indexOf("--project-id");
	const projectId = idx >= 0 ? args[idx + 1] : undefined;
	return { dryRun, projectId };
}

async function main() {
	const { dryRun, projectId } = parseArgs();

	const integrations = await db.projectRepositoryIntegration.findMany({
		where: {
			provider: "GITLAB",
			status: "ACTIVE",
			encryptedAccessToken: { not: null },
			configuredByUserId: { not: null },
			...(projectId ? { projectId } : {}),
		},
		select: {
			id: true,
			projectId: true,
			repositoryOwner: true,
			repositoryName: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			tokenScopes: true,
			configuredByUserId: true,
		},
	});

	console.log(
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
		const enc = integ.encryptedAccessToken;
		if (!userId || !enc) {
			skipped++;
			console.log(`[skip] ${label}: missing user or token`);
			continue;
		}

		const project = await db.project.findUnique({
			where: { id: integ.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			skipped++;
			console.log(`[skip] ${label}: project not found`);
			continue;
		}

		let accessToken: string;
		try {
			accessToken = decryptApiKey(enc);
		} catch (err) {
			failed++;
			console.error(`[fail] ${label}: could not decrypt token`, err);
			continue;
		}

		// Validate the token and read the GitLab identity (numeric id needed
		// by persistGitLabToken's settings payload).
		let gitlabUser: GitLabUser;
		try {
			gitlabUser = (await gitlabFetch(
				accessToken,
				"/user",
			)) as GitLabUser;
			if (!gitlabUser?.id || !gitlabUser?.username) {
				throw new Error("GitLab /user returned no id/username");
			}
		} catch (err) {
			skipped++;
			console.log(
				`[skip] ${label}: token invalid/expired — user must reconnect (${
					err instanceof Error ? err.message : String(err)
				})`,
			);
			continue;
		}

		if (dryRun) {
			console.log(
				`[dry-run] would wire PM for ${label} as ${gitlabUser.username}`,
			);
			wired++;
			continue;
		}

		try {
			const result = await enableGitLabPMForProject({
				userId,
				organizationId: project.organizationId ?? null,
				projectId: integ.projectId,
				repositoryOwner: integ.repositoryOwner,
				repositoryName: integ.repositoryName,
				token: {
					accessToken,
					refreshToken: integ.encryptedRefreshToken
						? decryptApiKey(integ.encryptedRefreshToken)
						: null,
					expiresAt: integ.tokenExpiresAt,
					scopes:
						integ.tokenScopes.length > 0
							? integ.tokenScopes
							: ["api", "read_user"],
				},
				gitlabUser: {
					id: gitlabUser.id,
					username: gitlabUser.username,
					name: gitlabUser.name ?? gitlabUser.username,
					avatarUrl: gitlabUser.avatar_url ?? null,
				},
			});

			if (result.pmWired) {
				wired++;
				console.log(
					`[wired] ${label}: PM container ${result.containerId}`,
				);
			} else {
				skipped++;
				console.log(`[skip] ${label}: ${result.reason}`);
			}
		} catch (err) {
			failed++;
			console.error(`[fail] ${label}:`, err);
		}
	}

	console.log(
		`[backfill] done — wired: ${wired}, skipped: ${skipped}, failed: ${failed}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("[backfill] fatal error", err);
		process.exit(1);
	});
