/**
 * Code indexing trigger — the single place that starts (and cancels) Phase 2
 * code-indexing workflows for a project's connected repositories.
 *
 * The index is per-repo: one Temporal workflow (and one ProjectCodeIndex row)
 * per ACTIVE ProjectRepositoryIntegration, so connecting multiple repos indexes
 * each independently and switching/removing one repo never disturbs another's
 * index. A project with no integration row but a legacy `Project.repositoryUrl`
 * still indexes via the user's personal OAuth as a single null-integration row.
 *
 * Gated by FEATURE_CODE_INDEXING (env) and the project's `codeSearchEnabled`
 * RAG setting. Best-effort: a repo with no usable token is skipped, not fatal.
 */

import {
	createBackgroundJob,
	db,
	failBackgroundJob,
	getProjectCodeIndexes,
	getProjectReposForCodeSearch,
	parseRepoUrl,
	seedSteps,
} from "@repo/database";
import { getGitHubAccessToken } from "@repo/integrations/github";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { decryptApiKey } from "@repo/utils";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

type RepoProvider = "GITHUB" | "AZURE_DEVOPS" | "GITLAB";

/**
 * Ordered subtasks of a code-indexing run, mirroring
 * `JOB_STEPS.codeIndexing` in `@repo/temporal`. Seeded here so the Job Hub can
 * render the full pipeline the moment the user connects a repo — before the
 * worker has picked the workflow up.
 */
const CODE_INDEXING_STEPS = [
	"clone",
	"secretScan",
	"walk",
	"symbols",
	"embed",
	"summaries",
	"finalize",
];

// Started by string name — not part of the typed Temporal client registry.
// biome-ignore lint/suspicious/noExplicitAny: untyped workflow start by name
const CODE_INDEXING_WORKFLOW = "codeIndexingWorkflow" as any;

/**
 * Stable Temporal workflow id for one repo's index run — one per
 * (project, repository integration). Reused by every trigger + the webhook so a
 * new run supersedes (TERMINATE_EXISTING) any in-flight run for the same repo.
 */
export function codeIndexWorkflowId(
	projectId: string,
	repositoryIntegrationId: string | null,
): string {
	return `code-index-${projectId}-${repositoryIntegrationId ?? "legacy"}`;
}

export interface StartCodeIndexingOptions {
	projectId: string;
	userId: string;
	/**
	 * Advisory only — the authoritative tenant is derived from the project
	 * itself, never from the caller (so a repo's index/vectors are always
	 * stamped with the project's real org).
	 */
	organizationId?: string | null;
	/**
	 * Restrict to one repository integration (manual re-index, push webhook).
	 * Omit to index every ACTIVE integration (repo linked / connected).
	 */
	repositoryIntegrationId?: string | null;
	/** Incremental: re-embed only these changed paths (push webhook). */
	incremental?: boolean;
	changedFiles?: string[];
}

export interface StartCodeIndexingResult {
	started: number;
	/** Repos skipped for want of a usable token, keyed by integration id. */
	skipped: Array<{ repositoryIntegrationId: string | null; reason: string }>;
	disabledReason?: "feature-flag" | "code-search-disabled";
}

/**
 * Start code indexing for a project's repositories. Returns a summary; never
 * throws for a per-repo credential miss (those land in `skipped`).
 */
export async function startCodeIndexingForProject(
	opts: StartCodeIndexingOptions,
): Promise<StartCodeIndexingResult> {
	const { projectId, userId } = opts;
	const skipped: StartCodeIndexingResult["skipped"] = [];

	if (process.env.FEATURE_CODE_INDEXING !== "true") {
		return { started: 0, skipped, disabledReason: "feature-flag" };
	}

	// Derive the tenant from the project itself — never trust the caller's
	// organizationId for collection routing / row stamping (the project is the
	// source of truth for which org owns its index + vectors).
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project) {
		return { started: 0, skipped };
	}
	const organizationId = project.organizationId;

	const ragSettings = await db.projectRagSettings.findUnique({
		where: { projectId },
		select: { codeSearchEnabled: true },
	});
	if (!ragSettings?.codeSearchEnabled) {
		return { started: 0, skipped, disabledReason: "code-search-disabled" };
	}

	const allRepos = await getProjectReposForCodeSearch(projectId);
	const repos =
		opts.repositoryIntegrationId != null
			? allRepos.filter(
					(r) => r.integrationId === opts.repositoryIntegrationId,
				)
			: allRepos;

	// No project-level integration → fall back to the legacy single-repo path
	// (project.repositoryUrl + the user's personal OAuth), unless the caller
	// targeted a specific integration that no longer exists.
	if (repos.length === 0) {
		if (opts.repositoryIntegrationId != null) {
			return { started: 0, skipped };
		}
		const started = await startLegacyOAuthIndexing({
			projectId,
			userId,
			organizationId,
			incremental: opts.incremental,
			changedFiles: opts.changedFiles,
		});
		return { started, skipped };
	}

	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	let started = 0;
	for (const repo of repos) {
		const { token } = await resolveFreshRepoTokenForRow(repo, {
			userId,
			organizationId,
		});
		if (!token) {
			skipped.push({
				repositoryIntegrationId: repo.integrationId,
				reason: "no-token",
			});
			continue;
		}
		const workflowId = codeIndexWorkflowId(projectId, repo.integrationId);
		const repoName = `${repo.owner}/${repo.repo}`;

		const handle = await client.workflow.start(
			CODE_INDEXING_WORKFLOW,
			withCorrelationMemo({
				taskQueue: "code-indexing",
				// Stable per-repo id + TERMINATE_EXISTING: at most one live index
				// run per repo, so a re-index / push supersedes an in-flight run
				// instead of racing it (no duplicate rows, no stale FAILED over a
				// concurrent READY, cancel always targets the live run).
				workflowId,
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [
					{
						projectId,
						userId,
						organizationId,
						repositoryUrl: repo.repositoryUrl,
						branch: repo.branch ?? "main",
						token,
						provider: repo.provider as RepoProvider,
						integrationId: repo.integrationId,
						repoName,
						incremental: opts.incremental,
						changedFiles: opts.changedFiles,
					},
				],
				workflowExecutionTimeout: "12h", // large monorepos: full symbol+embed+summary grind can exceed 2h; continueAsNew keeps per-run history bounded
			}),
		);

		// Job Hub row is created AFTER the start, not before. The workflow id is
		// stable per repo and started with TERMINATE_EXISTING, so creating first
		// would open the new run's row while the superseded run's activities are
		// still executing — Temporal stops accepting their results but does not
		// stop them — and their writes would land on (and could prematurely
		// close) the incoming run's row. Starting first also means a failed
		// start leaves no row to clean up.
		await createBackgroundJob({
			kind: "CODE_INDEXING",
			title: repoName,
			projectId,
			userId,
			organizationId,
			workflowId,
			runId: handle?.firstExecutionRunId ?? null,
			sourceType: "repositoryIntegration",
			sourceId: repo.integrationId,
			steps: seedSteps(CODE_INDEXING_STEPS),
		});
		started++;
	}
	return { started, skipped };
}

/**
 * Legacy path: index `Project.repositoryUrl` using the user's personal OAuth
 * WorkflowIntegration, as a single null-integration ProjectCodeIndex row. Kept
 * so projects that linked a repo before the multi-repo integration flow still
 * index. Returns the number of workflows started (0 or 1).
 */
async function startLegacyOAuthIndexing(opts: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	incremental?: boolean;
	changedFiles?: string[];
}): Promise<number> {
	const { projectId, userId, organizationId } = opts;

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { repositoryUrl: true },
	});
	if (!project?.repositoryUrl) {
		return 0;
	}

	const parsed = parseRepoUrl(project.repositoryUrl);
	if (!parsed) {
		return 0;
	}

	// Refresh-aware. This token is handed to a workflow whose execution timeout
	// is 12 HOURS and which carries `...input` forward across every
	// continueAsNew — so a raw decrypt here shipped a credential that a GitHub
	// App expires after 8h into a run that can outlive it, with no
	// integrationId to drive the clone path's self-heal. Resolving through the
	// refresh-aware getter at least guarantees a fresh token at start.
	let token: string | null = null;
	if (parsed.provider === "GITHUB") {
		token = await getGitHubAccessToken(userId, organizationId ?? undefined);
	} else {
		const integration = await db.workflowIntegration.findFirst({
			where: {
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
				// biome-ignore lint/suspicious/noExplicitAny: provider enum from parseRepoUrl
				provider: parsed.provider as any,
				isActive: true,
			},
			select: { credentials: true },
			orderBy: { updatedAt: "desc" },
		});
		if (!integration?.credentials) {
			return 0;
		}
		try {
			const credString =
				typeof integration.credentials === "string"
					? integration.credentials
					: JSON.stringify(integration.credentials);
			const creds = JSON.parse(decryptApiKey(credString));
			token = creds.access_token || creds.token || null;
		} catch {
			return 0;
		}
	}
	if (!token) {
		return 0;
	}

	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	const workflowId = codeIndexWorkflowId(projectId, null);
	const repoName = `${parsed.owner}/${parsed.name}`;

	const handle = await client.workflow.start(
		CODE_INDEXING_WORKFLOW,
		withCorrelationMemo({
			taskQueue: "code-indexing",
			workflowId,
			workflowIdConflictPolicy: "TERMINATE_EXISTING",
			args: [
				{
					projectId,
					userId,
					organizationId,
					repositoryUrl: project.repositoryUrl,
					branch: "main",
					token,
					provider: parsed.provider as RepoProvider,
					repoName,
					incremental: opts.incremental,
					changedFiles: opts.changedFiles,
				},
			],
			workflowExecutionTimeout: "12h", // large monorepos: full symbol+embed+summary grind can exceed 2h; continueAsNew keeps per-run history bounded
		}),
	);

	// Job Hub row for the legacy path too — a project indexing via the owner's
	// personal OAuth is no less deserving of visible progress. Created after the
	// start for the same reason as the per-repo path above.
	await createBackgroundJob({
		kind: "CODE_INDEXING",
		title: repoName,
		projectId,
		userId,
		organizationId,
		workflowId,
		runId: handle?.firstExecutionRunId ?? null,
		sourceType: "repositoryIntegration",
		sourceId: null,
		steps: seedSteps(CODE_INDEXING_STEPS),
	});
	return 1;
}

/**
 * Best-effort cancel of the in-flight indexing workflow for one repo, read from
 * its ProjectCodeIndex row (branch-agnostic — one repo has one index row). Safe
 * when the workflow already finished or the worker is unreachable. Awaits the
 * workflow's termination so callers can safely finalize the row afterwards.
 * Does not delete the row (callers decide).
 */
export async function cancelCodeIndexingForRepo(params: {
	projectId: string;
	repositoryIntegrationId: string | null;
}): Promise<void> {
	// Close the Job Hub row first, keyed on the deterministic workflow id rather
	// than on the ProjectCodeIndex row below. The two are not created together:
	// the API opens the job row the moment `workflow.start` returns, while
	// INDEXING is written later by `initCodeIndexActivity` on the worker.
	// Cancelling in that window — or after the stats write already flipped the
	// row to READY — hits the early return below, and the job would then sit
	// RUNNING until the watchdog stamped "Timed out — no progress reported":
	// the exact misreport this is here to prevent.
	//
	// The workflow cannot do it itself, because its failure activities run
	// inside the cancelled scope and Temporal refuses them. Compare-and-set on
	// RUNNING makes this a no-op when there is nothing open.
	await failBackgroundJob(
		{
			workflowId: codeIndexWorkflowId(
				params.projectId,
				params.repositoryIntegrationId,
			),
			sourceId: params.repositoryIntegrationId ?? null,
		},
		{
			error: "Cancelled before indexing finished.",
			errorClass: "Cancelled",
		},
	);

	const rows = await getProjectCodeIndexes(params.projectId);
	const row = rows.find(
		(r) =>
			r.repositoryIntegrationId === params.repositoryIntegrationId &&
			r.status === "INDEXING",
	);
	if (!row?.workflowId) {
		return;
	}
	try {
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(row.workflowId);
		await handle.cancel();
		await handle.result().catch(() => {});
	} catch {
		// Workflow may already be closed / not found — best-effort.
	}
}
