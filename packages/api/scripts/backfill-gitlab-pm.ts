/**
 * Backfill: enable GitLab as the PM tool for projects that were connected
 * repo-only (before the OAuth callback was unified).
 *
 * For each ACTIVE GitLab `ProjectRepositoryIntegration`, asks
 * `enableGitLabPMForProject` to wire the project's PM pointer through the
 * PERSONAL GitLab connection of the person who configured the repository.
 * The repository link's own token is a separate team grant and is never read
 * or copied here; a person without a usable personal connection is reported
 * as skipped (`personal-connection-required`). The clobber guard inside that
 * helper protects projects that already use a different PM tool.
 *
 * Idempotent: re-running re-wires the same pointer; projects already on
 * GitLab PM are unaffected.
 *
 * Run directly with tsx, from the repo root, with the target environment's
 * DATABASE_URL + token-encryption env loaded (e.g. via dotenv-cli):
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts --dry-run
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts --project-id <id>
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-pm.ts   # apply to all
 */
import { backfillGitLabPm } from "../modules/integrations/lib/backfill-gitlab-pm";

function parseArgs() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const idx = args.indexOf("--project-id");
	const projectId = idx >= 0 ? args[idx + 1] : undefined;
	return { dryRun, projectId };
}

backfillGitLabPm(parseArgs())
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("[backfill] fatal error", err);
		process.exit(1);
	});
