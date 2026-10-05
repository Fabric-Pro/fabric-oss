/**
 * OPTIONAL backfill: bring every personal GitLab connection under the GitLab
 * connection service (`adoptGitLabConnection`) before migration
 * `20261004120000_gitlab_mcp_config_drop_token_copies` applies. That migration
 * nulls the legacy credential copies on the `gitlab` / `gitlab-official`
 * MCPConfig rows (OAuth token columns and API key) and reports how many had no
 * personal GitLab connection row behind them; their owners reconnect GitLab.
 * The connection service no longer adopts a copy when it reads a connection,
 * so this script is the only way a copy becomes a connection without a
 * reconnect. It also marks a connection whose grant is shared with a
 * `gitlab-official` registration as reconnect-required, which nothing can
 * tell once the copies are gone (unmarked, a grant the registration issued
 * may be taken for one the integration app issued; if so its first refresh
 * fails and asks for a reconnect). Run it only against a database
 * whose running release already reads GitLab connections: a release from
 * before the GitLab connection service would misread the rows it writes.
 *
 * For each (user, organization) that has a personal GitLab
 * `WorkflowIntegration` or a `gitlab` / `gitlab-official` MCPConfig, the
 * adoption decides from evidence alone — never by trying a refresh or calling
 * GitLab:
 *   - a connection that lives only on a `gitlab-official` MCPConfig with a
 *     dynamic client registration is adopted with that registration as its
 *     issuer (production's case);
 *   - a personal access token saved as a GitLab MCPConfig's API key, with no
 *     connection behind it, is connected as a PAT on the instance the config
 *     names (not validated against GitLab: a revoked one fails on use, as any
 *     PAT does);
 *   - an existing connection without an issuer is classified (personal
 *     access token, or the integration OAuth app when one is configured);
 *   - a grant shared with a project repository link, or with a
 *     `gitlab-official` copy that has its own registration, is marked
 *     reconnect-required instead of refreshed;
 *   - a connection the user disconnected is left alone.
 * The MCPConfig copies are only read here; the migration removes them.
 *
 * FAILURES. The script exits non-zero (dry run included) when any
 * (user, organization) failed, and lists the failed pairs by id (never a
 * token). A pair fails when adoption threw, or for a reason
 * `adoptionFailureReason` names: its connection row's stored credential
 * could not be decrypted (an issuer-less row left unclassified, whose
 * shared-grant evidence the migration then destroys; and possibly the wrong
 * token-encryption key, which makes every row unreadable), or (real run) a
 * plan that should have written did not, which a rerun settles.
 * Resolve a failure (rerun, or review the pair) before the migration applies,
 * or that person may have to reconnect GitLab. A row already awaiting
 * reconnect, one the person disconnected, and one that already has an issuer
 * are settled, not failures.
 *
 * Idempotent: a second run finds nothing left to do. Once the migration has
 * applied in production, delete this script together with
 * `packages/integrations/src/gitlab/connection-legacy-adoption.ts`.
 *
 * Run from the repo root with the target environment's DATABASE_URL and
 * token-encryption env loaded (e.g. via dotenv-cli), dry run first:
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-connections.ts --dry-run
 *   npx dotenv -c -e .env.local -- npx tsx packages/api/scripts/backfill-gitlab-connections.ts
 */
import { db, GITLAB_PERSONAL_MCP_SERVER_KEYS } from "@repo/database";
import {
	adoptGitLabConnection,
	adoptionFailureReason,
} from "@repo/integrations/gitlab/connection-legacy-adoption";

type Tenant = { userId: string; organizationId: string | null };

async function listTenants(): Promise<Tenant[]> {
	const [integrations, configs] = await Promise.all([
		db.workflowIntegration.findMany({
			where: {
				provider: "GITLAB",
				workflowId: null,
				NOT: { name: "GITLAB_OAUTH_APP" },
			},
			select: { userId: true, organizationId: true },
		}),
		db.mCPConfig.findMany({
			where: {
				userId: { not: null },
				mcpServer: {
					key: { in: [...GITLAB_PERSONAL_MCP_SERVER_KEYS] },
				},
			},
			select: { userId: true, organizationId: true },
		}),
	]);
	const seen = new Map<string, Tenant>();
	for (const row of [...integrations, ...configs]) {
		if (!row.userId) {
			continue;
		}
		const key = `${row.organizationId ?? "-"}:${row.userId}`;
		if (!seen.has(key)) {
			seen.set(key, {
				userId: row.userId,
				organizationId: row.organizationId ?? null,
			});
		}
	}
	return [...seen.values()];
}

async function main() {
	const dryRun = process.argv.slice(2).includes("--dry-run");
	const tenants = await listTenants();
	console.log(
		`[backfill-gitlab] ${tenants.length} (user, organization) pair(s)${dryRun ? " — DRY RUN" : ""}`,
	);

	const counts = new Map<string, number>();
	const failedPairs: string[] = [];
	for (const tenant of tenants) {
		const label = `user ${tenant.userId} / org ${tenant.organizationId ?? "(personal)"}`;
		try {
			const result = await adoptGitLabConnection(tenant, undefined, {
				dryRun,
			});
			const plan = result.plan;
			const key =
				plan.action === "none"
					? `none:${plan.reason}`
					: plan.action === "reconnect-required"
						? `reconnect-required:${plan.reason}`
						: plan.action === "classify"
							? `classify:${plan.issuer.kind}`
							: plan.action;
			counts.set(key, (counts.get(key) ?? 0) + 1);
			if (plan.action !== "none") {
				console.log(
					`[${dryRun ? "dry-run" : result.applied ? "applied" : "skipped"}] ${label}: ${key}`,
				);
			}
			const failure = adoptionFailureReason(result, { dryRun });
			if (failure) {
				failedPairs.push(label);
				console.error(`[fail] ${label}: ${failure}`);
			}
		} catch (error) {
			failedPairs.push(label);
			// The message only: an error object can carry request data.
			console.error(
				`[fail] ${label}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	console.log("[backfill-gitlab] summary:");
	for (const [key, count] of [...counts.entries()].sort()) {
		console.log(`  ${key}: ${count}`);
	}
	console.log(`  failed: ${failedPairs.length}`);
	if (failedPairs.length > 0) {
		console.error(
			`[backfill-gitlab] ${failedPairs.length} pair(s) failed; resolve them before migration 20261004120000_gitlab_mcp_config_drop_token_copies applies, or those people reconnect GitLab:`,
		);
		for (const pair of failedPairs) {
			console.error(`  ${pair}`);
		}
		process.exitCode = 1;
	}
}

main()
	.then(() => process.exit(process.exitCode ?? 0))
	.catch((err) => {
		console.error("[backfill-gitlab] fatal error", err);
		process.exit(1);
	});
