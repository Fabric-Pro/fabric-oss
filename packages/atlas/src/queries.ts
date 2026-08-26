/**
 * Database access for the Atlas feature. All reads/writes are
 * tenant-scoped (XOR userId/organizationId) and additionally project-scoped;
 * the calling oRPC procedure has already verified project membership.
 */
import { db, Prisma } from "@repo/database";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { logger } from "@repo/logs";
import type { BusinessGraphDraft } from "./business";
import type { DetectedCrossEdge } from "./cross-repo";
import type { BuiltTechnicalGraph, FileMeta } from "./graph/build";
import type {
	AnalysisRunStatus,
	AnalysisRunSummary,
	AtlasContext,
	AtlasEdgeKind,
	AtlasNodeKind,
	AtlasNodeNeighbor,
	BusinessTour,
	ChatVisibility,
	ConversationDetail,
	ConversationSummary,
	EdgeOverrideHistoryEntry,
	GraphEdge,
	GraphMode,
	GraphNode,
	NodeLayoutPosition,
	NodeOverrideHistoryEntry,
	RepoOption,
	StoredChatMessage,
	TechStackEntry,
} from "./types";

const MAX_NEIGHBORS = 60;
const MAX_MODULE_SAMPLE_FILES = 6;

type TenantWhere =
	| { organizationId: string }
	| { userId: string; organizationId: null };

/** XOR tenant filter — org members share; personal sees only own. */
function tenantWhere(ctx: AtlasContext): TenantWhere {
	return ctx.organizationId
		? { organizationId: ctx.organizationId }
		: { userId: ctx.userId, organizationId: null };
}

function tenantColumns(ctx: AtlasContext): {
	userId: string;
	organizationId: string | null;
} {
	return { userId: ctx.userId, organizationId: ctx.organizationId };
}

/**
 * A row counts as "running" when its SERVED status is in flight (first-ever
 * analysis) OR its background-run marker is in flight (a re-analysis of an
 * already-READY snapshot keeps `status` = READY, so it must be matched via
 * `activeRunStatus`). Both guards and cancel use this so a background re-run is
 * never missed. Annotated so the enum arrays are contextually typed.
 */
const inFlightOr: Pick<Prisma.AtlasAnalysisWhereInput, "OR"> = {
	OR: [
		{ status: { in: ["PENDING", "ANALYZING"] } },
		{ activeRunStatus: { in: ["PENDING", "ANALYZING"] } },
	],
};

// ── Repositories ─────────────────────────────────────────────────────────────

export async function listProjectRepositories(
	ctx: AtlasContext,
	projectId: string,
): Promise<RepoOption[]> {
	const [integrations, project] = await Promise.all([
		db.projectRepositoryIntegration.findMany({
			// Include non-disconnected repos (ACTIVE + TOKEN_EXPIRED + ERROR) so a
			// previously-analysed repo whose credential later lapsed still surfaces
			// here — its stored map stays viewable read-only. DISCONNECTED repos
			// have had their tokens wiped, so they are intentionally dropped.
			where: { projectId, status: { not: "DISCONNECTED" } },
			select: {
				id: true,
				provider: true,
				authMethod: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
				pinnedBranches: true,
				status: true,
			},
			orderBy: { createdAt: "asc" },
		}),
		db.project.findFirst({
			where: { id: projectId, ...tenantWhere(ctx) },
			select: { repositoryUrl: true },
		}),
	]);

	return (
		integrations
			.map((i) => ({
				repositoryIntegrationId: i.id,
				provider: i.provider,
				authMethod: i.authMethod,
				repositoryName: i.repositoryName,
				repositoryUrl: i.repositoryUrl,
				defaultBranch: i.defaultBranch || "main",
				pinnedBranches: i.pinnedBranches ?? [],
				status: i.status,
				isDefault: Boolean(
					project?.repositoryUrl &&
						project.repositoryUrl === i.repositoryUrl,
				),
			}))
			// ACTIVE repos first so single-repo resolution / the default selection
			// prefers an analysable repo over one that needs re-authentication.
			.sort(
				(a, b) =>
					(a.status === "ACTIVE" ? 0 : 1) -
					(b.status === "ACTIVE" ? 0 : 1),
			)
	);
}

export interface ResolvedRepoCredentials {
	provider: string;
	authMethod: string;
	repositoryUrl: string;
	owner: string;
	repo: string;
	branch: string;
	azureOrganization: string | null;
	token: string;
}

const CREDENTIALS_DB_MAX_ATTEMPTS = 3;
const CREDENTIALS_DB_RETRY_BASE_DELAY_MS = 200;

/**
 * A momentary database CONNECTION/AUTH failure — the Prisma driver adapter
 * briefly can't reach the pool (observed live as `DriverAdapterError:
 * Authentication timed out`; also `PrismaClientInitializationError`, a connection
 * reset / `ECONNRESET`, a pool checkout timeout) — is transient and clears on a
 * quick retry. A DETERMINISTIC failure (a known Prisma request error such as a
 * unique-constraint violation, or anything not matched here) is NEVER retried.
 * Matched on the error name + message because the adapter surfaces these without
 * a stable Prisma `code`.
 */
const TRANSIENT_DB_ERROR_PATTERNS = [
	"authentication timed out",
	"can't reach database",
	"cannot reach database",
	"connection terminated",
	"connection reset",
	"connection closed",
	"timed out fetching a new connection",
	"driveradaptererror",
	"prismaclientinitializationerror",
	"econnreset",
	"econnrefused",
	"etimedout",
];

function isTransientDbConnectionError(error: unknown): boolean {
	// A known Prisma request error (e.g. P2002) is a deterministic result, not a
	// transient connection blip — never retry it.
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return false;
	}
	const haystack =
		error instanceof Error
			? `${error.name} ${error.message}`.toLowerCase()
			: String(error).toLowerCase();
	return TRANSIENT_DB_ERROR_PATTERNS.some((p) => haystack.includes(p));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Read the repo integration row, retrying ONLY a transient DB connection/auth
 * blip (see `isTransientDbConnectionError`) a few times with a short escalating
 * backoff. A not-found integration resolves to `null` (not an exception) and is
 * returned as-is — never retried; a deterministic DB error propagates immediately.
 */
async function findRepoIntegrationWithRetry(
	repositoryIntegrationId: string,
	projectId: string,
) {
	for (let attempt = 1; attempt <= CREDENTIALS_DB_MAX_ATTEMPTS; attempt++) {
		try {
			return await db.projectRepositoryIntegration.findFirst({
				where: { id: repositoryIntegrationId, projectId },
			});
		} catch (error) {
			if (
				!isTransientDbConnectionError(error) ||
				attempt >= CREDENTIALS_DB_MAX_ATTEMPTS
			) {
				throw error;
			}
			logger.warn(
				"[atlas] transient DB error resolving repo credentials; retrying",
				{
					repositoryIntegrationId,
					attempt,
					maxAttempts: CREDENTIALS_DB_MAX_ATTEMPTS,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			await sleep(CREDENTIALS_DB_RETRY_BASE_DELAY_MS * attempt);
		}
	}
	// Unreachable: the final attempt above always returns or throws.
	return null;
}

export async function resolveRepoCredentials(
	projectId: string,
	repositoryIntegrationId: string,
	/**
	 * Tenant context. Scopes the OAuth-app client-credential lookup to the org
	 * (then user) record before falling back to the global admin one — without
	 * it every Atlas refresh lands on the unscoped fallback, which contradicts
	 * the documented org-app-preferred ordering.
	 */
	ctx?: { userId?: string | null; organizationId?: string | null },
): Promise<ResolvedRepoCredentials | null> {
	const integration = await findRepoIntegrationWithRetry(
		repositoryIntegrationId,
		projectId,
	);
	if (!integration) {
		return null;
	}

	// Refresh-aware. This used to decrypt the stored token directly, which meant
	// Atlas served a dead credential for GitHub (8h expiry) on any path that did
	// not separately call `ensureFreshRepoCredentials` — `listBranches` and
	// `runStructureAnalysis` never did — and for GitLab (~2h expiry) on EVERY
	// path, because every refresh gate in this package is GITHUB-only. The
	// canonical resolver handles both providers and returns PATs untouched.
	const { token } = await resolveFreshRepoTokenForRow(
		{
			integrationId: integration.id,
			provider: integration.provider,
			authMethod: integration.authMethod,
			encryptedAccessToken: integration.encryptedAccessToken,
			encryptedRefreshToken: integration.encryptedRefreshToken,
			encryptedPat: integration.encryptedPat,
			tokenExpiresAt: integration.tokenExpiresAt,
			updatedAt: integration.updatedAt,
		},
		ctx,
	);
	if (!token) {
		return null;
	}

	return {
		provider: integration.provider,
		authMethod: integration.authMethod,
		repositoryUrl: integration.repositoryUrl,
		owner: integration.repositoryOwner,
		repo: integration.repositoryName,
		branch: integration.defaultBranch || "main",
		azureOrganization: integration.azureOrganization,
		token,
	};
}

/**
 * Set the pinned-branches list for a project's repository integration (T6).
 * Project-bound — returns the persisted list, or null when the integration is
 * not part of the project (caller maps NOT_FOUND).
 */
export async function setPinnedBranches(
	_ctx: AtlasContext,
	args: {
		projectId: string;
		repositoryIntegrationId: string;
		branches: string[];
	},
): Promise<string[] | null> {
	const integration = await db.projectRepositoryIntegration.findFirst({
		where: { id: args.repositoryIntegrationId, projectId: args.projectId },
		select: { id: true },
	});
	if (!integration) {
		return null;
	}
	const updated = await db.projectRepositoryIntegration.update({
		where: { id: integration.id },
		data: { pinnedBranches: args.branches },
		select: { pinnedBranches: true },
	});
	return updated.pinnedBranches;
}

// ── Analysis lifecycle ───────────────────────────────────────────────────────
// Analyses are stored PER BRANCH — (projectId, repositoryIntegrationId, branch)
// is the unique identity — so switching the monitored branch and back restores
// the already-analysed map instead of overwriting it.

export async function findAnalysis(
	ctx: AtlasContext,
	projectId: string,
	repositoryIntegrationId: string | null,
	branch: string,
) {
	return db.atlasAnalysis.findFirst({
		where: {
			projectId,
			repositoryIntegrationId,
			branch,
			...tenantWhere(ctx),
		},
	});
}

/** A single analysis row by id (tenant-scoped) — for run/cancel paths that already hold the id. */
export async function findAnalysisById(ctx: AtlasContext, analysisId: string) {
	return db.atlasAnalysis.findFirst({
		where: { id: analysisId, ...tenantWhere(ctx) },
	});
}

/**
 * Latest analysis for an integration regardless of branch. Lets a repo whose
 * MONITORED branch has never been analysed keep its last analysed map
 * viewable read-only (the status bar shows the re-analyse-to-apply hint while
 * `analysis.branch !== repository.defaultBranch`).
 */
export async function findLatestAnalysisForIntegration(
	ctx: AtlasContext,
	projectId: string,
	repositoryIntegrationId: string | null,
) {
	return db.atlasAnalysis.findFirst({
		where: {
			projectId,
			repositoryIntegrationId,
			...tenantWhere(ctx),
		},
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Latest analysis for a project regardless of which repository integration it
 * was run against. Used as a fallback so a previously-analysed map stays
 * viewable even after its repo integration is removed/disconnected — the graph
 * lives on the analysis row, independent of the live credential.
 */
export async function findLatestAnalysisForProject(
	ctx: AtlasContext,
	projectId: string,
) {
	return db.atlasAnalysis.findFirst({
		where: { projectId, ...tenantWhere(ctx) },
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Normalise a repository URL for identity comparison across re-connects:
 * lowercase, strip protocol + trailing slash + a trailing ".git".
 */
function normalizeRepoUrl(url: string): string {
	return url
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}

/**
 * Find ALL prior analyses for the SAME repository (matched by normalised URL)
 * whose integration is no longer one of the project's live integrations —
 * i.e. the per-branch rows orphaned when their repo was removed/replaced.
 * Ordered so the row matching `preferredBranch` (the re-added integration's
 * current monitored branch) comes first, then newest-first. Powers
 * re-attaching a re-added repo to its existing Atlas maps, per branch.
 */
export async function findAdoptableAnalyses(
	ctx: AtlasContext,
	projectId: string,
	repositoryUrl: string,
	liveIntegrationIds: string[],
	preferredBranch: string,
) {
	const target = normalizeRepoUrl(repositoryUrl);
	const live = new Set(liveIntegrationIds);
	const candidates = await db.atlasAnalysis.findMany({
		where: { projectId, ...tenantWhere(ctx) },
		orderBy: { updatedAt: "desc" },
	});
	return candidates
		.filter(
			(a) =>
				normalizeRepoUrl(a.repositoryUrl) === target &&
				(a.repositoryIntegrationId === null ||
					!live.has(a.repositoryIntegrationId)),
		)
		.sort(
			(a, b) =>
				(a.branch === preferredBranch ? 0 : 1) -
				(b.branch === preferredBranch ? 0 : 1),
		);
}

/**
 * Re-point an orphaned analysis to a (re-added) integration so every
 * read/write path keys on the current id. Returns `null` when the
 * (project, integration, branch) slot is already occupied (P2002 — e.g. a
 * concurrent adoption or a fresh analysis already created for that branch);
 * the caller skips that candidate and keeps adopting the rest.
 */
export async function adoptAnalysis(
	_ctx: AtlasContext,
	analysisId: string,
	integrationId: string,
	repo: { provider: string; repositoryUrl: string; repositoryName: string },
) {
	try {
		return await db.atlasAnalysis.update({
			where: { id: analysisId },
			data: {
				repositoryIntegrationId: integrationId,
				provider: repo.provider,
				repositoryUrl: repo.repositoryUrl,
				repositoryName: repo.repositoryName,
			},
		});
	} catch (error) {
		if ((error as { code?: string } | null)?.code === "P2002") {
			return null;
		}
		throw error;
	}
}

/**
 * Find the current in-flight (PENDING/ANALYZING) analysis to cancel. Tries the
 * exact repo selector first; if that row isn't in flight (or wasn't found),
 * falls back to the most-recently-updated in-flight analysis for the project.
 * This keeps cancel robust even if the UI's repo selector has drifted from the
 * row that's actually running.
 */
export async function findInFlightAnalysis(
	ctx: AtlasContext,
	projectId: string,
	repositoryIntegrationId: string | null,
) {
	if (repositoryIntegrationId !== undefined) {
		const exact = await db.atlasAnalysis.findFirst({
			where: {
				projectId,
				repositoryIntegrationId,
				...inFlightOr,
				...tenantWhere(ctx),
			},
		});
		if (exact) {
			return exact;
		}
	}
	return db.atlasAnalysis.findFirst({
		where: {
			projectId,
			...inFlightOr,
			...tenantWhere(ctx),
		},
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Any in-flight (PENDING/ANALYZING) analysis for THIS integration, regardless
 * of branch — backs the one-run-at-a-time-per-repository guard now that an
 * integration can own multiple per-branch rows.
 */
export async function findInFlightAnalysisForIntegration(
	ctx: AtlasContext,
	projectId: string,
	repositoryIntegrationId: string | null,
) {
	return db.atlasAnalysis.findFirst({
		where: {
			projectId,
			repositoryIntegrationId,
			...inFlightOr,
			...tenantWhere(ctx),
		},
	});
}

export async function getOrCreateAnalysis(
	ctx: AtlasContext,
	input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		provider: string;
		repositoryUrl: string;
		repositoryName: string | null;
		branch: string;
	},
) {
	const existing = await findAnalysis(
		ctx,
		input.projectId,
		input.repositoryIntegrationId,
		input.branch,
	);
	if (existing) {
		return existing;
	}
	try {
		return await db.atlasAnalysis.create({
			data: {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				provider: input.provider,
				repositoryUrl: input.repositoryUrl,
				repositoryName: input.repositoryName,
				branch: input.branch,
				status: "NOT_ANALYZED",
				...tenantColumns(ctx),
			},
		});
	} catch (error) {
		// Concurrent create for the same (project, repo, branch) triple — the
		// loser re-reads the winner's row.
		if ((error as { code?: string } | null)?.code === "P2002") {
			const winner = await findAnalysis(
				ctx,
				input.projectId,
				input.repositoryIntegrationId,
				input.branch,
			);
			if (winner) {
				return winner;
			}
		}
		throw error;
	}
}

/**
 * Set the served status directly (PENDING/ANALYZING/READY/FAILED). Low-level —
 * does NOT touch the non-blocking-re-analysis markers. Kept for paths that want
 * an unconditional served-status write (e.g. the analyze rollback's hard reset).
 */
export async function setAnalysisStatus(
	analysisId: string,
	status: "PENDING" | "ANALYZING" | "READY" | "FAILED",
	extra?: { workflowId?: string; error?: string | null },
) {
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			status,
			...(extra?.workflowId ? { workflowId: extra.workflowId } : {}),
			...(extra && "error" in extra
				? { error: extra.error ?? null }
				: {}),
		},
	});
}

/**
 * Begin a run (R2). Stamps the background-run markers + workflowId and clears
 * any prior error. When `keepServedStatus` is true (re-analysis of an
 * already-READY snapshot), the served `status` is LEFT at READY so the live
 * graph keeps serving; otherwise (first-ever analysis) the served status flips
 * to PENDING so the FE shows the initial build spinner.
 */
export async function beginAnalysisRun(
	analysisId: string,
	input: {
		workflowId: string;
		keepServedStatus: boolean;
		/**
		 * "From fresh" (B5): drop the stored file-manifest so the structure
		 * activity sees no prior and re-describes EVERY module (re-deriving all
		 * descriptions + categories), instead of an empty incremental diff that
		 * would skip the AI on an unchanged repo.
		 */
		clearManifest?: boolean;
	},
): Promise<void> {
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			activeRunStatus: "PENDING",
			activeRunStartedAt: new Date(),
			workflowId: input.workflowId,
			error: null,
			...(input.keepServedStatus ? {} : { status: "PENDING" }),
			...(input.clearManifest ? { fileManifest: Prisma.DbNull } : {}),
		},
	});
}

/**
 * Workflow flipped to ANALYZING. Advances the background-run marker; keeps the
 * served `status` at READY when a good snapshot is already being served (re-run)
 * so the graph never blanks, otherwise flips the served status to ANALYZING.
 */
export async function markAnalysisAnalyzing(analysisId: string): Promise<void> {
	const row = await db.atlasAnalysis.findUnique({
		where: { id: analysisId },
		select: { status: true },
	});
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			activeRunStatus: "ANALYZING",
			...(row?.status === "READY" ? {} : { status: "ANALYZING" }),
		},
	});
}

/**
 * Fail/clear a run WITHOUT blanking a previously-good snapshot (R2). Always
 * clears the background-run markers. The served `status` becomes FAILED ONLY
 * when there is no prior successful snapshot (`analyzedCommitSha` is null); when
 * a snapshot exists the served status stays READY (the last-good graph keeps
 * serving) and the failure is surfaced via `error`.
 */
export async function failAnalysisRun(
	analysisId: string,
	error: string | null,
): Promise<void> {
	const row = await db.atlasAnalysis.findUnique({
		where: { id: analysisId },
		select: { analyzedCommitSha: true },
	});
	const hadSnapshot = Boolean(row?.analyzedCommitSha);
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			activeRunStatus: null,
			activeRunStartedAt: null,
			error: error ?? null,
			...(hadSnapshot ? {} : { status: "FAILED" }),
		},
	});
}

export interface AnalysisTelemetry {
	model?: string | null;
	durationMs?: number | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	totalTokens?: number | null;
	costMicroUsd?: number | null;
	reasoning?: string | null;
	/** false for a "from fresh" run (overrides not applied). */
	appliedUserOverrides?: boolean;
}

export async function finalizeAnalysis(
	analysisId: string,
	input: {
		status: "READY" | "FAILED";
		commitSha?: string | null;
		commitAt?: Date | null;
		fileManifest?: Record<string, string> | null;
		nodeCount?: number;
		edgeCount?: number;
		filesAnalyzed?: number;
		incremental?: boolean;
		error?: string | null;
		telemetry?: AnalysisTelemetry;
	},
) {
	// FAILED: never blank a previously-good snapshot — clear the run markers and
	// only downgrade the served status when there is nothing good to keep.
	if (input.status === "FAILED") {
		await failAnalysisRun(analysisId, input.error ?? null);
		return;
	}

	const now = new Date();
	const t = input.telemetry;
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			status: "READY",
			error: null,
			// Swap the served data + clear the background-run markers in one write.
			activeRunStatus: null,
			activeRunStartedAt: null,
			analyzedAt: now,
			analyzedCommitSha: input.commitSha ?? undefined,
			analyzedCommitAt: input.commitAt ?? undefined,
			fileManifest: input.fileManifest ?? undefined,
			nodeCount: input.nodeCount ?? undefined,
			edgeCount: input.edgeCount ?? undefined,
			filesAnalyzed: input.filesAnalyzed ?? undefined,
			lastFullAnalysisAt: input.incremental ? undefined : now,
			lastIncrementalAt: input.incremental ? now : undefined,
			// Telemetry (T3) — only overwrite when provided so a no-AI run keeps
			// any prior values rather than nulling them.
			...(t
				? {
						...(t.model !== undefined
							? { analysisModel: t.model }
							: {}),
						...(t.durationMs !== undefined
							? { analysisDurationMs: t.durationMs }
							: {}),
						...(t.promptTokens !== undefined
							? { promptTokens: t.promptTokens }
							: {}),
						...(t.completionTokens !== undefined
							? { completionTokens: t.completionTokens }
							: {}),
						...(t.totalTokens !== undefined
							? { totalTokens: t.totalTokens }
							: {}),
						...(t.costMicroUsd !== undefined
							? { costMicroUsd: t.costMicroUsd }
							: {}),
						...(t.reasoning !== undefined
							? { reasoning: t.reasoning }
							: {}),
						...(t.appliedUserOverrides !== undefined
							? { appliedUserOverrides: t.appliedUserOverrides }
							: {}),
					}
				: {}),
		},
	});
}

/** Per-canonical-name model cost rates (USD per 1M tokens) — for T3 cost. */
export async function getModelCostRates(
	canonicalName: string,
): Promise<{ inputCostPer1M: number; outputCostPer1M: number } | null> {
	const model = await db.aiModel.findUnique({
		where: { canonicalName },
		select: { inputCostPer1M: true, outputCostPer1M: true },
	});
	if (!model) {
		return null;
	}
	return {
		inputCostPer1M: model.inputCostPer1M ?? 0,
		outputCostPer1M: model.outputCostPer1M ?? 0,
	};
}

// ── Multi-repo "System map": cross-repo edges + link state ────────────────────

/** The per-project cross-link state row (freshness signature + telemetry), or null. */
export async function getCrossLink(ctx: AtlasContext, projectId: string) {
	return db.atlasCrossLink.findFirst({
		where: { projectId, ...tenantWhere(ctx) },
	});
}

/** Mark a cross-link run RUNNING (upsert; clears any prior error). */
export async function startCrossLink(
	ctx: AtlasContext,
	projectId: string,
): Promise<void> {
	const tenant = tenantColumns(ctx);
	await db.atlasCrossLink.upsert({
		where: { projectId },
		create: {
			projectId,
			status: "RUNNING",
			startedAt: new Date(),
			...tenant,
		},
		update: { status: "RUNNING", startedAt: new Date(), error: null },
	});
}

export interface FinishCrossLinkInput {
	status: "READY" | "FAILED";
	signature: string | null;
	repositoryIntegrationIds: string[];
	edgeCount: number;
	model: string | null;
	totalTokens: number | null;
	costMicroUsd: number | null;
	error: string | null;
	durationMs: number | null;
}

/** Finalise a cross-link run (READY/FAILED) with its signature + telemetry. */
export async function finishCrossLink(
	ctx: AtlasContext,
	projectId: string,
	input: FinishCrossLinkInput,
): Promise<void> {
	const tenant = tenantColumns(ctx);
	const data = {
		status: input.status,
		signature: input.signature,
		repositoryIntegrationIds: input.repositoryIntegrationIds,
		edgeCount: input.edgeCount,
		model: input.model,
		totalTokens: input.totalTokens,
		costMicroUsd: input.costMicroUsd,
		error: input.error,
		completedAt: new Date(),
		durationMs: input.durationMs,
	};
	await db.atlasCrossLink.upsert({
		where: { projectId },
		create: { projectId, ...data, ...tenant },
		update: data,
	});
}

/** Replace ALL of a project's cross-repo edges with a freshly detected set. */
export async function replaceCrossEdges(
	ctx: AtlasContext,
	projectId: string,
	edges: DetectedCrossEdge[],
): Promise<number> {
	const tenant = tenantColumns(ctx);
	const rows = edges.map((e) => ({
		projectId,
		mode: e.mode,
		kind: e.kind,
		detection: e.detection,
		sourceAnalysisId: e.sourceAnalysisId,
		sourceKey: e.sourceKey,
		targetAnalysisId: e.targetAnalysisId,
		targetKey: e.targetKey,
		weight: e.weight,
		description: e.description,
		...tenant,
	}));
	await db.$transaction([
		db.atlasCrossEdge.deleteMany({
			where: { projectId, ...tenantWhere(ctx) },
		}),
		...(rows.length ? [db.atlasCrossEdge.createMany({ data: rows })] : []),
	]);
	return rows.length;
}

export interface CrossEdgeRow {
	mode: GraphMode;
	kind: string;
	detection: string;
	sourceAnalysisId: string;
	sourceKey: string | null;
	targetAnalysisId: string;
	targetKey: string | null;
	weight: number | null;
	description: string | null;
}

/** Cross-repo edges for a lens whose BOTH endpoints are in the given analyses. */
export async function getCrossEdges(
	ctx: AtlasContext,
	projectId: string,
	mode: GraphMode,
	analysisIds: string[],
): Promise<CrossEdgeRow[]> {
	if (analysisIds.length === 0) {
		return [];
	}
	const rows = await db.atlasCrossEdge.findMany({
		where: {
			projectId,
			mode,
			sourceAnalysisId: { in: analysisIds },
			targetAnalysisId: { in: analysisIds },
			...tenantWhere(ctx),
		},
		select: {
			mode: true,
			kind: true,
			detection: true,
			sourceAnalysisId: true,
			sourceKey: true,
			targetAnalysisId: true,
			targetKey: true,
			weight: true,
			description: true,
		},
	});
	return rows as CrossEdgeRow[];
}

/**
 * Persist the detected tech stack (frameworks/libraries) and the repo's own
 * published-package identities onto the analysis row.
 */
export async function updateAnalysisTechStack(
	analysisId: string,
	techStack: TechStackEntry[],
	publishedPackages: string[] = [],
): Promise<void> {
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			techStack: techStack as unknown as Prisma.InputJsonValue,
			publishedPackages:
				publishedPackages as unknown as Prisma.InputJsonValue,
		},
	});
}

/** Persist the AI-narrated business onboarding tour onto the analysis row. */
export async function updateAnalysisBusinessTour(
	analysisId: string,
	tour: BusinessTour | null,
): Promise<void> {
	await db.atlasAnalysis.update({
		where: { id: analysisId },
		data: {
			businessTour:
				tour === null
					? Prisma.DbNull
					: (tour as unknown as Prisma.InputJsonValue),
		},
	});
}

/** The repository name for an analysis (used to title the business tour). */
export async function getAnalysisRepositoryName(
	analysisId: string,
): Promise<string | null> {
	const row = await db.atlasAnalysis.findUnique({
		where: { id: analysisId },
		select: { repositoryName: true },
	});
	return row?.repositoryName ?? null;
}

// ── Graph persistence ────────────────────────────────────────────────────────

export async function persistTechnicalGraph(
	ctx: AtlasContext,
	args: {
		analysisId: string;
		projectId: string;
		graph: BuiltTechnicalGraph;
		changedModuleKeys: Set<string>;
		/** moduleKey → concatenated markdown docs (README etc.) attached to that module. */
		docsByModule?: Map<string, string>;
	},
): Promise<void> {
	const { analysisId, projectId, graph, changedModuleKeys, docsByModule } =
		args;

	// Preserve AI descriptions for unchanged nodes across incremental re-runs.
	const existing = await db.atlasNode.findMany({
		where: { analysisId, mode: "TECHNICAL" },
		select: {
			key: true,
			kind: true,
			contentHash: true,
			technicalDescription: true,
			businessDescription: true,
			category: true,
		},
	});
	const prior = new Map(existing.map((n) => [n.key, n]));
	const tenant = tenantColumns(ctx);

	const nodeRows = graph.nodes.map((n) => {
		const before = prior.get(n.key);
		const unchanged =
			n.kind === "FILE"
				? before?.contentHash === n.contentHash
				: before && !changedModuleKeys.has(n.key);
		const technicalDescription =
			unchanged && before?.technicalDescription
				? before.technicalDescription
				: n.structuralDescription;
		const businessDescription =
			unchanged && before?.businessDescription
				? before.businessDescription
				: null;
		// Category is AI-assigned in the LATER describe step, so it is unknown at
		// structure-persist time. Preserve it for unchanged modules; leave null
		// for changed/new ones (the describe step fills them).
		const category = unchanged ? (before?.category ?? null) : null;
		return {
			analysisId,
			projectId,
			mode: "TECHNICAL" as const,
			kind: n.kind,
			key: n.key,
			label: n.label,
			filePath: n.filePath,
			language: n.language,
			parentKey: n.parentKey,
			technicalDescription,
			businessDescription,
			category,
			documentation:
				n.kind === "MODULE" ? (docsByModule?.get(n.key) ?? null) : null,
			contentPreview: n.contentPreview,
			contentHash: n.contentHash,
			metrics: n.metrics,
			...tenant,
		};
	});

	const edgeRows = graph.edges.map((e) => ({
		analysisId,
		projectId,
		mode: "TECHNICAL" as const,
		kind: e.kind,
		sourceKey: e.source,
		targetKey: e.target,
		weight: e.weight,
		...tenant,
	}));

	await db.$transaction([
		db.atlasEdge.deleteMany({
			where: { analysisId, mode: "TECHNICAL" },
		}),
		db.atlasNode.deleteMany({
			where: { analysisId, mode: "TECHNICAL" },
		}),
		db.atlasNode.createMany({ data: nodeRows }),
		db.atlasEdge.createMany({ data: edgeRows }),
	]);
}

// ── Structure-phase resume checkpoint ───────────────────────────────────────

/**
 * Load the per-file parse metadata already checkpointed for THIS commit, so a
 * retried structure activity can skip re-parsing those files. Also drops any
 * rows captured at a different commit (e.g. the monitored branch moved between
 * attempts) — those would parse to different content, so they must not be reused.
 */
export async function loadParseCheckpoint(
	analysisId: string,
	commitSha: string,
): Promise<Map<string, FileMeta>> {
	await db.atlasParseCheckpoint.deleteMany({
		where: { analysisId, commitSha: { not: commitSha } },
	});
	const rows = await db.atlasParseCheckpoint.findMany({
		where: { analysisId, commitSha },
		select: {
			path: true,
			language: true,
			namespace: true,
			loc: true,
			symbolCount: true,
			contentHash: true,
			contentPreview: true,
			importSpecs: true,
		},
	});
	const map = new Map<string, FileMeta>();
	for (const r of rows) {
		map.set(r.path, {
			path: r.path,
			language: r.language,
			namespace: r.namespace,
			loc: r.loc,
			symbolCount: r.symbolCount,
			contentHash: r.contentHash,
			contentPreview: r.contentPreview,
			importSpecs: r.importSpecs,
		});
	}
	return map;
}

/**
 * Append a batch of freshly-parsed files to the checkpoint. Idempotent
 * (`skipDuplicates` on the `(analysisId, path)` unique), so re-flushing a file
 * after a double-retry is harmless.
 */
export async function appendParseCheckpoint(
	ctx: AtlasContext,
	args: {
		analysisId: string;
		projectId: string;
		commitSha: string;
		files: FileMeta[];
	},
): Promise<void> {
	if (args.files.length === 0) {
		return;
	}
	const tenant = tenantColumns(ctx);
	await db.atlasParseCheckpoint.createMany({
		data: args.files.map((f) => ({
			analysisId: args.analysisId,
			projectId: args.projectId,
			commitSha: args.commitSha,
			path: f.path,
			language: f.language,
			namespace: f.namespace,
			loc: f.loc,
			symbolCount: f.symbolCount,
			contentHash: f.contentHash,
			contentPreview: f.contentPreview,
			importSpecs: f.importSpecs,
			...tenant,
		})),
		skipDuplicates: true,
	});
}

/** Drop an analysis's parse checkpoint — called on success and terminal failure. */
export async function clearParseCheckpoint(analysisId: string): Promise<void> {
	await db.atlasParseCheckpoint.deleteMany({ where: { analysisId } });
}

export async function persistBusinessGraph(
	ctx: AtlasContext,
	args: {
		analysisId: string;
		projectId: string;
		draft: BusinessGraphDraft;
		/** Fingerprint of the inputs that produced this graph; stamped atomically
		 *  with the graph so a later retry with identical inputs skips re-deriving. */
		signature?: string;
	},
): Promise<void> {
	const { analysisId, projectId, draft, signature } = args;
	const tenant = tenantColumns(ctx);

	const nodeRows = draft.capabilities.map((c) => ({
		analysisId,
		projectId,
		mode: "BUSINESS" as const,
		kind: "CAPABILITY" as const,
		key: c.key,
		label: c.label,
		filePath: null,
		language: null,
		parentKey: null,
		technicalDescription: null,
		businessDescription: c.description,
		category: c.category ?? null,
		contentPreview: null,
		contentHash: null,
		metrics: { fileCount: c.moduleKeys.length },
		...tenant,
	}));

	const edgeRows = [
		...draft.capabilities.flatMap((c) =>
			c.moduleKeys.map((moduleKey) => ({
				analysisId,
				projectId,
				mode: "BUSINESS" as const,
				kind: "COVERS" as const,
				sourceKey: c.key,
				targetKey: moduleKey,
				weight: 1,
				...tenant,
			})),
		),
		...draft.relations.map((r) => ({
			analysisId,
			projectId,
			mode: "BUSINESS" as const,
			kind: "RELATES_TO" as const,
			sourceKey: r.sourceKey,
			targetKey: r.targetKey,
			weight: 1,
			...tenant,
		})),
	];

	await db.$transaction([
		db.atlasEdge.deleteMany({
			where: { analysisId, mode: "BUSINESS" },
		}),
		db.atlasNode.deleteMany({
			where: { analysisId, mode: "BUSINESS" },
		}),
		db.atlasNode.createMany({ data: nodeRows }),
		db.atlasEdge.createMany({ data: edgeRows }),
		// Stamp the freshness fingerprint in the SAME transaction as the graph so
		// "graph persisted" ⟺ "signature persisted" — a retry can then trust the
		// stored signature to skip an identical (expensive) AI re-derivation.
		...(signature !== undefined
			? [
					db.atlasAnalysis.update({
						where: { id: analysisId },
						data: { businessSignature: signature },
					}),
				]
			: []),
	]);
}

/** The fingerprint of the inputs that produced the persisted BUSINESS graph, or
 *  null if none was stamped (legacy analyses, or no graph yet). */
export async function getBusinessSignature(
	analysisId: string,
): Promise<string | null> {
	const row = await db.atlasAnalysis.findUnique({
		where: { id: analysisId },
		select: { businessSignature: true },
	});
	return row?.businessSignature ?? null;
}

// ── Describe support ─────────────────────────────────────────────────────────

export async function getModulesForDescribe(
	analysisId: string,
	moduleKeys: string[],
	opts?: { onlyUndescribed?: boolean },
) {
	if (moduleKeys.length === 0) {
		return [];
	}
	const [modules, dependsEdges, files] = await Promise.all([
		db.atlasNode.findMany({
			where: {
				analysisId,
				mode: "TECHNICAL",
				kind: "MODULE",
				key: { in: moduleKeys },
				// Resumability: when re-describing after a disrupted/retried attempt,
				// skip modules already AI-described so we don't re-run (and re-bill)
				// the LLM for them. `businessDescription` is the reliable "AI summary
				// present" signal — `technicalDescription` holds a structural
				// placeholder for every changed module, so it's never null. The
				// on-demand single-node "Regenerate with AI" path omits this flag so
				// it can refresh an already-described module on request.
				...(opts?.onlyUndescribed ? { businessDescription: null } : {}),
			},
			select: {
				key: true,
				label: true,
				filePath: true,
				language: true,
				metrics: true,
			},
		}),
		db.atlasEdge.findMany({
			where: { analysisId, mode: "TECHNICAL", kind: "DEPENDS_ON" },
			select: { sourceKey: true, targetKey: true },
		}),
		db.atlasNode.findMany({
			where: {
				analysisId,
				mode: "TECHNICAL",
				kind: "FILE",
				parentKey: { in: moduleKeys },
			},
			select: {
				key: true,
				label: true,
				parentKey: true,
				contentPreview: true,
			},
		}),
	]);

	const labelByKey = new Map(modules.map((m) => [m.key, m.label]));
	const filesByModule = new Map<string, typeof files>();
	for (const f of files) {
		if (!f.parentKey) {
			continue;
		}
		const arr = filesByModule.get(f.parentKey) ?? [];
		if (arr.length < MAX_MODULE_SAMPLE_FILES) {
			arr.push(f);
		}
		filesByModule.set(f.parentKey, arr);
	}

	return modules.map((m) => {
		const metrics = (m.metrics ?? {}) as {
			fileCount?: number;
			loc?: number;
		};
		const dependsOn = dependsEdges
			.filter((e) => e.sourceKey === m.key)
			.map((e) => labelByKey.get(e.targetKey) ?? e.targetKey);
		const dependedOnBy = dependsEdges
			.filter((e) => e.targetKey === m.key)
			.map((e) => labelByKey.get(e.sourceKey) ?? e.sourceKey);
		return {
			key: m.key,
			label: m.label,
			path: m.filePath,
			language: m.language,
			fileCount: metrics.fileCount ?? 0,
			loc: metrics.loc ?? 0,
			sampleFiles: (filesByModule.get(m.key) ?? []).map((f) => ({
				label: f.label,
				preview: f.contentPreview,
			})),
			dependsOn,
			dependedOnBy,
		};
	});
}

export async function getModuleSummaries(analysisId: string) {
	const modules = await db.atlasNode.findMany({
		where: { analysisId, mode: "TECHNICAL", kind: "MODULE" },
		select: {
			key: true,
			label: true,
			filePath: true,
			businessDescription: true,
			technicalDescription: true,
			documentation: true,
		},
	});
	return modules.map((m) => ({
		key: m.key,
		label: m.label,
		path: m.filePath,
		business: m.businessDescription ?? m.technicalDescription ?? null,
		doc: m.documentation ?? null,
	}));
}

/**
 * MODULE keys still missing an AI description. Unioned into the changed-module
 * set on every run so a structure-only seed (or a prior partial describe) gets
 * its gaps filled — without re-describing modules that already have a summary.
 */
export async function getUndescribedModuleKeys(
	analysisId: string,
): Promise<string[]> {
	const rows = await db.atlasNode.findMany({
		where: {
			analysisId,
			mode: "TECHNICAL",
			kind: "MODULE",
			technicalDescription: null,
		},
		select: { key: true },
	});
	return rows.map((r) => r.key);
}

/**
 * Count of derived business capabilities. Lets an unchanged incremental run skip
 * re-deriving the (unchanged) business graph, while still deriving it the first
 * time / whenever it's missing — so the business view is never left empty.
 */
export async function countBusinessCapabilities(
	analysisId: string,
): Promise<number> {
	return db.atlasNode.count({
		where: { analysisId, mode: "BUSINESS", kind: "CAPABILITY" },
	});
}

export async function updateModuleDescriptions(
	analysisId: string,
	descriptions: {
		key: string;
		technical: string;
		business: string;
		category?: string | null;
	}[],
): Promise<void> {
	await db.$transaction(
		descriptions.map((d) =>
			db.atlasNode.updateMany({
				where: { analysisId, mode: "TECHNICAL", key: d.key },
				data: {
					technicalDescription: d.technical,
					businessDescription: d.business,
					// Only overwrite category when the AI returned one — preserve a
					// prior category if a re-describe yielded none.
					...(d.category != null ? { category: d.category } : {}),
				},
			}),
		),
	);
}

export async function updateNodeDescription(
	ctx: AtlasContext,
	args: {
		analysisId: string;
		mode: GraphMode;
		key: string;
		technical: string;
		business: string;
		category?: string | null;
	},
): Promise<void> {
	await db.atlasNode.updateMany({
		where: {
			analysisId: args.analysisId,
			mode: args.mode,
			key: args.key,
			...tenantWhere(ctx),
		},
		data: {
			technicalDescription: args.technical,
			businessDescription: args.business,
			...(args.category != null ? { category: args.category } : {}),
		},
	});
}

// ── Stable user overrides (survive re-analysis) ──────────────────────────────

export interface NodeOverrideValue {
	userDescription: string | null;
	userCategory: string | null;
}

interface OverrideKeyArgs {
	projectId: string;
	repositoryIntegrationId: string | null;
	branch: string;
	mode: GraphMode;
}

/**
 * All user overrides for a (project, repo, branch, mode), keyed by node key.
 * Used both by the read overlays (T5) and the AI override-feeding (B4).
 */
export async function getNodeOverrides(
	ctx: AtlasContext,
	args: OverrideKeyArgs,
): Promise<Map<string, NodeOverrideValue>> {
	const rows = await db.atlasNodeOverride.findMany({
		where: {
			projectId: args.projectId,
			repositoryIntegrationId: args.repositoryIntegrationId,
			branch: args.branch,
			mode: args.mode,
			...tenantWhere(ctx),
		},
		select: { key: true, userDescription: true, userCategory: true },
	});
	return new Map(
		rows.map((r) => [
			r.key,
			{
				userDescription: r.userDescription,
				userCategory: r.userCategory,
			},
		]),
	);
}

/**
 * Upsert a node override (T6 `updateNode`) and append one history row per
 * CHANGED field (old → new). Tenant-scoped. Returns the resolved override id and
 * its current values. P2002 on a concurrent first-create falls back to update.
 */
export async function upsertNodeOverride(
	ctx: AtlasContext,
	args: OverrideKeyArgs & {
		key: string;
		userDescription?: string | null;
		userCategory?: string | null;
		updatedByUserId: string;
	},
): Promise<{ id: string; value: NodeOverrideValue }> {
	const tenant = tenantColumns(ctx);
	const findExisting = () =>
		db.atlasNodeOverride.findFirst({
			where: {
				projectId: args.projectId,
				repositoryIntegrationId: args.repositoryIntegrationId,
				branch: args.branch,
				mode: args.mode,
				key: args.key,
				...tenantWhere(ctx),
			},
		});

	const existing = await findExisting();

	const changes: {
		field: "description" | "category";
		oldValue: string | null;
		newValue: string | null;
	}[] = [];
	if (
		args.userDescription !== undefined &&
		(existing?.userDescription ?? null) !== (args.userDescription ?? null)
	) {
		changes.push({
			field: "description",
			oldValue: existing?.userDescription ?? null,
			newValue: args.userDescription ?? null,
		});
	}
	if (
		args.userCategory !== undefined &&
		(existing?.userCategory ?? null) !== (args.userCategory ?? null)
	) {
		changes.push({
			field: "category",
			oldValue: existing?.userCategory ?? null,
			newValue: args.userCategory ?? null,
		});
	}

	const writeData = {
		...(args.userDescription !== undefined
			? { userDescription: args.userDescription }
			: {}),
		...(args.userCategory !== undefined
			? { userCategory: args.userCategory }
			: {}),
		updatedByUserId: args.updatedByUserId,
	};

	let overrideId: string;
	let current: NodeOverrideValue;
	if (existing) {
		const updated = await db.atlasNodeOverride.update({
			where: { id: existing.id },
			data: writeData,
			select: { id: true, userDescription: true, userCategory: true },
		});
		overrideId = updated.id;
		current = {
			userDescription: updated.userDescription,
			userCategory: updated.userCategory,
		};
	} else {
		try {
			const created = await db.atlasNodeOverride.create({
				data: {
					projectId: args.projectId,
					repositoryIntegrationId: args.repositoryIntegrationId,
					branch: args.branch,
					mode: args.mode,
					key: args.key,
					userDescription: args.userDescription ?? null,
					userCategory: args.userCategory ?? null,
					updatedByUserId: args.updatedByUserId,
					...tenant,
				},
				select: { id: true, userDescription: true, userCategory: true },
			});
			overrideId = created.id;
			current = {
				userDescription: created.userDescription,
				userCategory: created.userCategory,
			};
		} catch (error) {
			// Concurrent create for the same key — re-find the winner and update it.
			if ((error as { code?: string } | null)?.code !== "P2002") {
				throw error;
			}
			const winner = await findExisting();
			if (!winner) {
				throw error;
			}
			const updated = await db.atlasNodeOverride.update({
				where: { id: winner.id },
				data: writeData,
				select: { id: true, userDescription: true, userCategory: true },
			});
			overrideId = updated.id;
			current = {
				userDescription: updated.userDescription,
				userCategory: updated.userCategory,
			};
		}
	}

	if (changes.length > 0) {
		await db.atlasNodeOverrideHistory.createMany({
			data: changes.map((c) => ({
				overrideId,
				field: c.field,
				oldValue: c.oldValue,
				newValue: c.newValue,
				editedByUserId: args.updatedByUserId,
				...tenant,
			})),
		});
	}
	return { id: overrideId, value: current };
}

/** Override edit history for a node (newest first), with editor names resolved. */
export async function getNodeOverrideHistory(
	ctx: AtlasContext,
	args: OverrideKeyArgs & { key: string; limit?: number },
): Promise<NodeOverrideHistoryEntry[]> {
	const override = await db.atlasNodeOverride.findFirst({
		where: {
			projectId: args.projectId,
			repositoryIntegrationId: args.repositoryIntegrationId,
			branch: args.branch,
			mode: args.mode,
			key: args.key,
			...tenantWhere(ctx),
		},
		select: { id: true },
	});
	if (!override) {
		return [];
	}
	const rows = await db.atlasNodeOverrideHistory.findMany({
		where: { overrideId: override.id, ...tenantWhere(ctx) },
		orderBy: { createdAt: "desc" },
		take: args.limit ?? 50,
		select: {
			id: true,
			field: true,
			oldValue: true,
			newValue: true,
			editedByUserId: true,
			createdAt: true,
		},
	});
	const userIds = [
		...new Set(
			rows
				.map((r) => r.editedByUserId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const users =
		userIds.length > 0
			? await db.user.findMany({
					where: { id: { in: userIds } },
					select: { id: true, name: true, email: true },
				})
			: [];
	const userById = new Map(users.map((u) => [u.id, u]));
	return rows.map((r) => {
		const user = r.editedByUserId
			? userById.get(r.editedByUserId)
			: undefined;
		return {
			id: r.id,
			field: r.field === "category" ? "category" : "description",
			oldValue: r.oldValue,
			newValue: r.newValue,
			editedByUserId: r.editedByUserId,
			editedByName: user?.name ?? user?.email ?? null,
			createdAt: r.createdAt.toISOString(),
		};
	});
}

// ── Read for UI ──────────────────────────────────────────────────────────────

function resolveDescription(
	node: {
		technicalDescription: string | null;
		businessDescription: string | null;
	},
	mode: GraphMode,
): string | null {
	return mode === "TECHNICAL"
		? (node.technicalDescription ?? node.businessDescription)
		: (node.businessDescription ?? node.technicalDescription);
}

const CANVAS_NODE_KIND: Record<GraphMode, AtlasNodeKind[]> = {
	TECHNICAL: ["MODULE"],
	BUSINESS: ["CAPABILITY", "DOMAIN"],
};
const CANVAS_EDGE_KIND: Record<GraphMode, AtlasEdgeKind> = {
	TECHNICAL: "DEPENDS_ON",
	BUSINESS: "RELATES_TO",
};

/**
 * Load the override overlay context for an analysis (T5/B6): the per-key user
 * overrides for the requested mode, plus whether they currently apply. Overrides
 * are keyed by (project, repo, branch, mode) — NOT analysisId — so they are
 * loaded via the analysis's repo+branch and overlaid only when the analysis was
 * built with `appliedUserOverrides` (i.e. not a "from fresh" run).
 */
async function loadOverrideOverlay(
	ctx: AtlasContext,
	analysisId: string,
	mode: GraphMode,
): Promise<{
	applied: boolean;
	overrides: Map<string, NodeOverrideValue>;
}> {
	const analysis = await db.atlasAnalysis.findFirst({
		where: { id: analysisId, ...tenantWhere(ctx) },
		select: {
			projectId: true,
			repositoryIntegrationId: true,
			branch: true,
			appliedUserOverrides: true,
		},
	});
	if (!analysis || !analysis.appliedUserOverrides) {
		return { applied: false, overrides: new Map() };
	}
	const overrides = await getNodeOverrides(ctx, {
		projectId: analysis.projectId,
		repositoryIntegrationId: analysis.repositoryIntegrationId,
		branch: analysis.branch,
		mode,
	});
	return { applied: true, overrides };
}

/**
 * Overlay a node's effective description/category from a user override (when
 * applied). Returns the values the GraphNode contract exposes.
 */
function overlayNode(
	node: {
		technicalDescription: string | null;
		businessDescription: string | null;
		category: string | null;
	},
	mode: GraphMode,
	override: NodeOverrideValue | undefined,
): {
	description: string | null;
	category: string | null;
	isUserCategory: boolean;
} {
	const aiDescription = resolveDescription(node, mode);
	const userDescription = override?.userDescription ?? null;
	const userCategory = override?.userCategory ?? null;
	return {
		description: userDescription ?? aiDescription,
		category: userCategory ?? node.category ?? null,
		isUserCategory: Boolean(userCategory),
	};
}

export async function getGraph(
	ctx: AtlasContext,
	analysisId: string,
	mode: GraphMode,
	options?: { includeDeleted?: boolean },
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
	const includeDeleted = options?.includeDeleted ?? false;
	const [nodes, edges, overlay, analysis] = await Promise.all([
		db.atlasNode.findMany({
			where: {
				analysisId,
				mode,
				kind: { in: CANVAS_NODE_KIND[mode] },
				...tenantWhere(ctx),
			},
		}),
		db.atlasEdge.findMany({
			where: {
				analysisId,
				mode,
				kind: CANVAS_EDGE_KIND[mode],
				...tenantWhere(ctx),
			},
			select: {
				sourceKey: true,
				targetKey: true,
				kind: true,
				weight: true,
			},
		}),
		loadOverrideOverlay(ctx, analysisId, mode),
		db.atlasAnalysis.findFirst({
			where: { id: analysisId, ...tenantWhere(ctx) },
			select: {
				projectId: true,
				repositoryIntegrationId: true,
				branch: true,
			},
		}),
	]);

	const nodeKeys = new Set(nodes.map((n) => n.key));

	// Edge overrides are keyed by ENDPOINTS (repo integration + node key). For a
	// solo graph BOTH endpoints live in this analysis's repo, so the map keys on
	// (sourceKey → targetKey). Active overrides attach a user description / drop a
	// soft-deleted edge / add a manual edge; mirrors the node-override overlay.
	const repoId = analysis?.repositoryIntegrationId ?? null;
	const edgeOverrides = analysis
		? await loadEdgeOverrides(
				ctx,
				analysis.projectId,
				analysis.branch,
				mode,
			)
		: [];
	// Only overrides whose BOTH endpoints are intra-repo (this analysis's repo)
	// belong to the solo graph; cross-repo manual overrides live on the System map.
	const soloOverrides = edgeOverrides.filter(
		(o) =>
			o.sourceRepositoryIntegrationId === repoId &&
			o.targetRepositoryIntegrationId === repoId,
	);
	const overrideByEndpoints = new Map<string, EdgeOverrideRow>();
	for (const o of soloOverrides) {
		overrideByEndpoints.set(`${o.sourceKey}\u0000${o.targetKey}`, o);
	}

	const structuralEdges: GraphEdge[] = [];
	for (const e of edges) {
		if (!nodeKeys.has(e.sourceKey) || !nodeKeys.has(e.targetKey)) {
			continue;
		}
		const override = overrideByEndpoints.get(
			`${e.sourceKey}\u0000${e.targetKey}`,
		);
		const deleted = Boolean(override?.deletedAt);
		if (deleted && !includeDeleted) {
			continue;
		}
		structuralEdges.push({
			source: e.sourceKey,
			target: e.targetKey,
			// A user-RE-TYPED connection (`isUserKind`) shows the chosen kind over
			// the detected one; otherwise the structural kind stands.
			kind:
				override?.isUserKind && override.kind
					? (override.kind as GraphEdge["kind"])
					: e.kind,
			weight: e.weight,
			description: override?.userDescription ?? null,
			isManual: false,
			isUserDescription: Boolean(override?.userDescription),
			deleted,
			overrideId: override?.id ?? null,
		});
	}

	// Manual overrides (user-created edges) whose endpoints both exist as nodes,
	// added as new edges with their kind + description. Soft-deleted manual edges
	// are dropped unless includeDeleted.
	const structuralPairs = new Set(
		edges.map((e) => `${e.sourceKey}\u0000${e.targetKey}`),
	);
	const manualEdges: GraphEdge[] = [];
	for (const o of soloOverrides) {
		if (!o.isManual) {
			continue;
		}
		if (!nodeKeys.has(o.sourceKey) || !nodeKeys.has(o.targetKey)) {
			continue;
		}
		// A manual override that happens to coincide with a structural edge is
		// already represented above — skip to avoid a duplicate edge.
		if (structuralPairs.has(`${o.sourceKey}\u0000${o.targetKey}`)) {
			continue;
		}
		const deleted = Boolean(o.deletedAt);
		if (deleted && !includeDeleted) {
			continue;
		}
		manualEdges.push({
			source: o.sourceKey,
			target: o.targetKey,
			kind: CANVAS_EDGE_KIND[mode],
			weight: null,
			description: o.userDescription ?? null,
			isManual: true,
			isUserDescription: Boolean(o.userDescription),
			deleted,
			overrideId: o.id,
		});
	}

	return {
		nodes: nodes.map((n) => {
			const eff = overlayNode(n, mode, overlay.overrides.get(n.key));
			return {
				key: n.key,
				kind: n.kind,
				label: n.label,
				filePath: n.filePath,
				language: n.language,
				parentKey: n.parentKey,
				description: eff.description,
				category: eff.category,
				isUserCategory: eff.isUserCategory,
				metrics: (n.metrics as GraphNode["metrics"]) ?? null,
				layout: (n.layout as GraphNode["layout"]) ?? null,
			};
		}),
		edges: [...structuralEdges, ...manualEdges],
	};
}

/**
 * The capability→module COVERS mapping (the business↔code bridge): which
 * technical modules implement each business capability. Lets the chat answer
 * "what code powers this capability?" and the reverse. Returns source
 * (capability) + target (module) node keys; the caller resolves labels.
 */
export async function getCapabilityCoverage(
	ctx: AtlasContext,
	analysisId: string,
): Promise<{ capabilityKey: string; moduleKey: string }[]> {
	const edges = await db.atlasEdge.findMany({
		where: {
			analysisId,
			mode: "BUSINESS",
			kind: "COVERS",
			...tenantWhere(ctx),
		},
		select: { sourceKey: true, targetKey: true },
	});
	return edges.map((e) => ({
		capabilityKey: e.sourceKey,
		moduleKey: e.targetKey,
	}));
}

export async function getNodeDetail(
	ctx: AtlasContext,
	args: { analysisId: string; mode: GraphMode; key: string },
) {
	const node = await db.atlasNode.findFirst({
		where: {
			analysisId: args.analysisId,
			mode: args.mode,
			key: args.key,
			...tenantWhere(ctx),
		},
	});
	if (!node) {
		return null;
	}

	// Effective overlay (T5): the user override wins when overrides are applied.
	const overlay = await loadOverrideOverlay(ctx, args.analysisId, args.mode);
	const override = overlay.overrides.get(args.key);
	const eff = overlayNode(node, args.mode, override);

	// Neighbours: edges touching this node (deps + containment + covers), capped.
	const edges = await db.atlasEdge.findMany({
		where: {
			analysisId: args.analysisId,
			mode: args.mode,
			OR: [{ sourceKey: args.key }, { targetKey: args.key }],
		},
		select: { sourceKey: true, targetKey: true, kind: true },
		take: MAX_NEIGHBORS * 2,
	});
	const neighborKeys = new Set<string>();
	for (const e of edges) {
		neighborKeys.add(e.sourceKey === args.key ? e.targetKey : e.sourceKey);
	}
	const neighborNodes = await db.atlasNode.findMany({
		where: { analysisId: args.analysisId, key: { in: [...neighborKeys] } },
		select: { key: true, label: true, kind: true, mode: true },
	});
	const nodeByKey = new Map(neighborNodes.map((n) => [n.key, n]));

	const neighbors: AtlasNodeNeighbor[] = [];
	for (const e of edges) {
		const isOut = e.sourceKey === args.key;
		const otherKey = isOut ? e.targetKey : e.sourceKey;
		const other = nodeByKey.get(otherKey);
		if (!other) {
			continue;
		}
		neighbors.push({
			key: otherKey,
			label: other.label,
			kind: other.kind as AtlasNodeNeighbor["kind"],
			edgeKind: e.kind as AtlasNodeNeighbor["edgeKind"],
			direction: isOut ? "out" : "in",
		});
		if (neighbors.length >= MAX_NEIGHBORS) {
			break;
		}
	}

	return {
		key: node.key,
		kind: node.kind as GraphNode["kind"],
		label: node.label,
		filePath: node.filePath,
		language: node.language,
		parentKey: node.parentKey,
		// Effective values (override wins when applied).
		description: eff.description,
		category: eff.category,
		isUserCategory: eff.isUserCategory,
		technicalDescription: node.technicalDescription,
		businessDescription: node.businessDescription,
		// Raw override values (independent of the viewed mode / of application).
		userDescription: override?.userDescription ?? null,
		userCategory: override?.userCategory ?? null,
		isUserDescription: Boolean(override?.userDescription),
		editable: true,
		documentation: node.documentation,
		contentPreview: node.contentPreview,
		metrics: (node.metrics as GraphNode["metrics"]) ?? null,
		layout: (node.layout as GraphNode["layout"]) ?? null,
		neighbors,
	};
}

// ── Analysis history (who / when / commit) ───────────────────────────────────

/** Open a RUNNING history row for an analysis (one per kicked-off run). */
export async function createAnalysisRun(
	ctx: AtlasContext,
	input: {
		analysisId: string;
		projectId: string;
		mode: "full" | "incremental" | "remap" | "remap_fresh";
		branch?: string | null;
	},
): Promise<{ id: string }> {
	const run = await db.atlasAnalysisRun.create({
		data: {
			analysisId: input.analysisId,
			projectId: input.projectId,
			mode: input.mode,
			branch: input.branch ?? null,
			status: "RUNNING",
			triggeredByUserId: ctx.userId,
			...tenantColumns(ctx),
		},
		select: { id: true },
	});
	return run;
}

/**
 * Close out the most recent RUNNING run for an analysis — sets it READY/FAILED
 * with `completedAt` and a derived `durationMs` (now − startedAt) plus the run's
 * AI telemetry. No-op if no RUNNING run exists (defensive; the run is always
 * opened in `requestAnalysis`). Returns the derived `durationMs` so the caller
 * can mirror it onto the analysis row (T3) — `null` when there was no open run.
 */
export async function completeLatestRun(
	ctx: AtlasContext,
	input: {
		analysisId: string;
		status: "READY" | "FAILED";
		commitSha?: string | null;
		commitAt?: Date | null;
		branch?: string | null;
		nodeCount?: number;
		edgeCount?: number;
		filesAnalyzed?: number;
		modulesDescribed?: number;
		telemetry?: AnalysisTelemetry;
		error?: string | null;
	},
): Promise<{ durationMs: number | null }> {
	const run = await db.atlasAnalysisRun.findFirst({
		where: {
			analysisId: input.analysisId,
			status: "RUNNING",
			...tenantWhere(ctx),
		},
		orderBy: { startedAt: "desc" },
		select: { id: true, startedAt: true },
	});
	if (!run) {
		return { durationMs: null };
	}
	const completedAt = new Date();
	const durationMs = completedAt.getTime() - run.startedAt.getTime();
	const t = input.telemetry;
	await db.atlasAnalysisRun.update({
		where: { id: run.id },
		data: {
			status: input.status,
			completedAt,
			durationMs,
			commitSha: input.commitSha ?? undefined,
			commitAt: input.commitAt ?? undefined,
			branch: input.branch ?? undefined,
			nodeCount: input.nodeCount ?? undefined,
			edgeCount: input.edgeCount ?? undefined,
			filesAnalyzed: input.filesAnalyzed ?? undefined,
			modulesDescribed: input.modulesDescribed ?? undefined,
			...(t?.model !== undefined ? { model: t.model } : {}),
			...(t?.promptTokens !== undefined
				? { promptTokens: t.promptTokens }
				: {}),
			...(t?.completionTokens !== undefined
				? { completionTokens: t.completionTokens }
				: {}),
			...(t?.totalTokens !== undefined
				? { totalTokens: t.totalTokens }
				: {}),
			...(t?.costMicroUsd !== undefined
				? { costMicroUsd: t.costMicroUsd }
				: {}),
			error: input.error ?? null,
		},
	});
	return { durationMs };
}

/** Total number of analysis runs for an analysis (drives the history total). */
export function countAnalysisRuns(
	ctx: AtlasContext,
	analysisId: string,
): Promise<number> {
	return db.atlasAnalysisRun.count({
		where: { analysisId, ...tenantWhere(ctx) },
	});
}

/** Recent runs for an analysis, with the triggering user's name/email resolved. */
export async function getHistory(
	ctx: AtlasContext,
	analysisId: string,
	limit = 20,
	offset = 0,
): Promise<AnalysisRunSummary[]> {
	const runs = await db.atlasAnalysisRun.findMany({
		where: { analysisId, ...tenantWhere(ctx) },
		orderBy: { startedAt: "desc" },
		skip: offset,
		take: limit,
		select: {
			id: true,
			mode: true,
			status: true,
			branch: true,
			commitSha: true,
			commitAt: true,
			nodeCount: true,
			edgeCount: true,
			filesAnalyzed: true,
			modulesDescribed: true,
			model: true,
			promptTokens: true,
			completionTokens: true,
			totalTokens: true,
			costMicroUsd: true,
			error: true,
			startedAt: true,
			completedAt: true,
			durationMs: true,
			triggeredByUserId: true,
		},
	});

	const userIds = [
		...new Set(
			runs
				.map((r) => r.triggeredByUserId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const users =
		userIds.length > 0
			? await db.user.findMany({
					where: { id: { in: userIds } },
					select: { id: true, name: true, email: true },
				})
			: [];
	const userById = new Map(users.map((u) => [u.id, u]));

	return runs.map((r) => {
		const user = r.triggeredByUserId
			? userById.get(r.triggeredByUserId)
			: undefined;
		return {
			id: r.id,
			mode:
				r.mode === "incremental" ||
				r.mode === "remap" ||
				r.mode === "remap_fresh"
					? r.mode
					: "full",
			status: r.status,
			branch: r.branch,
			commitSha: r.commitSha,
			commitShortSha: r.commitSha?.slice(0, 7) ?? null,
			commitAt: r.commitAt?.toISOString() ?? null,
			nodeCount: r.nodeCount,
			edgeCount: r.edgeCount,
			filesAnalyzed: r.filesAnalyzed,
			modulesDescribed: r.modulesDescribed,
			model: r.model,
			promptTokens: r.promptTokens,
			completionTokens: r.completionTokens,
			totalTokens: r.totalTokens,
			costMicroUsd: r.costMicroUsd,
			error: r.error,
			startedAt: r.startedAt.toISOString(),
			completedAt: r.completedAt?.toISOString() ?? null,
			durationMs: r.durationMs,
			triggeredByUserId: r.triggeredByUserId,
			triggeredByName: user?.name ?? null,
			triggeredByEmail: user?.email ?? null,
		};
	});
}

// ── Shared node positions (draggable layout) ─────────────────────────────────

/**
 * Persist dragged node positions onto the node rows (shared by construction —
 * the layout lives on the row, so every member sees the same arrangement).
 * One `updateMany` per node, scoped by (analysisId, mode, key) + tenant.
 */
export async function saveNodeLayout(
	ctx: AtlasContext,
	analysisId: string,
	mode: GraphMode,
	positions: NodeLayoutPosition[],
): Promise<{ updated: number }> {
	if (positions.length === 0) {
		return { updated: 0 };
	}
	const results = await db.$transaction(
		positions.map((p) =>
			db.atlasNode.updateMany({
				where: { analysisId, mode, key: p.key, ...tenantWhere(ctx) },
				data: { layout: { x: p.x, y: p.y } },
			}),
		),
	);
	return { updated: results.reduce((sum, r) => sum + r.count, 0) };
}

// ── System-map shared node positions (multi-repo draggable layout) ───────────
// Positions live in their own table (keyed by the System-map RF node id) rather
// than on the per-analysis node row, because System-map ids are namespaced
// (`repo::…` containers + `${analysisId}::${key}` cards) and the repo-group
// container nodes are synthetic (have no row of their own). Project-level +
// last-write-wins — shared by construction, like the single-repo node layout.

/**
 * Upsert dragged System-map node positions for a (project, mode). One upsert per
 * node id, keyed by the unique (projectId, mode, nodeId), in a single
 * transaction. Tenant columns are written on create only (the row is shared).
 */
export async function saveSystemNodeLayout(
	ctx: AtlasContext,
	projectId: string,
	mode: GraphMode,
	positions: { id: string; x: number; y: number }[],
): Promise<{ updated: number }> {
	if (positions.length === 0) {
		return { updated: 0 };
	}
	const tenant = tenantColumns(ctx);
	await db.$transaction(
		positions.map((p) =>
			db.atlasSystemLayout.upsert({
				where: {
					projectId_mode_nodeId: { projectId, mode, nodeId: p.id },
				},
				create: {
					projectId,
					mode,
					nodeId: p.id,
					x: p.x,
					y: p.y,
					...tenant,
				},
				update: { x: p.x, y: p.y },
			}),
		),
	);
	return { updated: positions.length };
}

/** Saved System-map positions for a (project, mode), keyed by RF node id. */
export async function getSystemNodeLayout(
	ctx: AtlasContext,
	projectId: string,
	mode: GraphMode,
): Promise<Record<string, { x: number; y: number }>> {
	const rows = await db.atlasSystemLayout.findMany({
		where: { projectId, mode, ...tenantWhere(ctx) },
		select: { nodeId: true, x: true, y: true },
	});
	const out: Record<string, { x: number; y: number }> = {};
	for (const r of rows) {
		out[r.nodeId] = { x: r.x, y: r.y };
	}
	return out;
}

// ── Stable edge overrides (editable / manual / soft-deletable connections) ───
// Keyed by ENDPOINTS — (repo integration + node key) for each side — NOT by
// analysisId, so an override SURVIVES re-analysis (overlaid onto whichever
// analysis currently serves the branch). Works for BOTH solo intra-repo edges
// (both endpoints share the analysis's repo) and System-map cross-repo edges.

interface EdgeEndpointKey {
	repositoryIntegrationId: string | null;
	key: string;
}

interface EdgeOverrideKeyArgs {
	projectId: string;
	branch: string;
	mode: GraphMode;
	source: EdgeEndpointKey;
	target: EdgeEndpointKey;
}

export interface EdgeOverrideRow {
	id: string;
	branch: string;
	mode: GraphMode;
	sourceRepositoryIntegrationId: string | null;
	sourceKey: string;
	targetRepositoryIntegrationId: string | null;
	targetKey: string;
	kind: string;
	userDescription: string | null;
	isManual: boolean;
	isCrossRepo: boolean;
	isAiGenerated: boolean;
	isUserKind: boolean;
	deletedAt: Date | null;
}

const EDGE_OVERRIDE_SELECT = {
	id: true,
	branch: true,
	mode: true,
	sourceRepositoryIntegrationId: true,
	sourceKey: true,
	targetRepositoryIntegrationId: true,
	targetKey: true,
	kind: true,
	userDescription: true,
	isManual: true,
	isCrossRepo: true,
	isAiGenerated: true,
	isUserKind: true,
	deletedAt: true,
} as const;

/** A single edge override (active or deleted) for these endpoints, or null. */
export async function findEdgeOverride(
	ctx: AtlasContext,
	args: EdgeOverrideKeyArgs,
): Promise<EdgeOverrideRow | null> {
	const row = await db.atlasEdgeOverride.findFirst({
		where: {
			projectId: args.projectId,
			branch: args.branch,
			mode: args.mode,
			sourceRepositoryIntegrationId: args.source.repositoryIntegrationId,
			sourceKey: args.source.key,
			targetRepositoryIntegrationId: args.target.repositoryIntegrationId,
			targetKey: args.target.key,
			...tenantWhere(ctx),
		},
		select: EDGE_OVERRIDE_SELECT,
	});
	return (row as EdgeOverrideRow | null) ?? null;
}

/**
 * All edge overrides for a (project, branch, mode) scope — active AND deleted —
 * so the read path can overlay onto structural edges and add manual ones. The
 * service maps these by endpoint key.
 */
export async function loadEdgeOverrides(
	ctx: AtlasContext,
	projectId: string,
	branch: string,
	mode: GraphMode,
): Promise<EdgeOverrideRow[]> {
	const rows = await db.atlasEdgeOverride.findMany({
		where: { projectId, branch, mode, ...tenantWhere(ctx) },
		select: EDGE_OVERRIDE_SELECT,
	});
	return rows as EdgeOverrideRow[];
}

/**
 * Upsert an edge override and append history. On CREATE: writes a `created`
 * history row (newValue = description). On a description CHANGE: writes a
 * `description` row (old → new). Tenant-scoped. P2002 on a concurrent first
 * create falls back to an update. Returns the resolved override row.
 */
export async function upsertEdgeOverride(
	ctx: AtlasContext,
	args: EdgeOverrideKeyArgs & {
		kind?: string;
		userDescription?: string | null;
		isManual?: boolean;
		isCrossRepo?: boolean;
		isAiGenerated?: boolean;
		isUserKind?: boolean;
		updatedByUserId: string;
	},
): Promise<EdgeOverrideRow> {
	const tenant = tenantColumns(ctx);
	const existing = await findEdgeOverride(ctx, args);

	// Description-change detection (only when a value was supplied).
	const descriptionChanged =
		!!existing &&
		args.userDescription !== undefined &&
		(existing.userDescription ?? null) !== (args.userDescription ?? null);

	const writeUpdate = {
		...(args.kind !== undefined ? { kind: args.kind } : {}),
		...(args.userDescription !== undefined
			? { userDescription: args.userDescription }
			: {}),
		...(args.isManual !== undefined ? { isManual: args.isManual } : {}),
		...(args.isCrossRepo !== undefined
			? { isCrossRepo: args.isCrossRepo }
			: {}),
		...(args.isAiGenerated !== undefined
			? { isAiGenerated: args.isAiGenerated }
			: {}),
		...(args.isUserKind !== undefined
			? { isUserKind: args.isUserKind }
			: {}),
		updatedByUserId: args.updatedByUserId,
	};

	let row: EdgeOverrideRow;
	if (existing) {
		row = (await db.atlasEdgeOverride.update({
			where: { id: existing.id },
			data: writeUpdate,
			select: EDGE_OVERRIDE_SELECT,
		})) as EdgeOverrideRow;
	} else {
		try {
			row = (await db.atlasEdgeOverride.create({
				data: {
					projectId: args.projectId,
					branch: args.branch,
					mode: args.mode,
					sourceRepositoryIntegrationId:
						args.source.repositoryIntegrationId,
					sourceKey: args.source.key,
					targetRepositoryIntegrationId:
						args.target.repositoryIntegrationId,
					targetKey: args.target.key,
					kind: args.kind ?? "RELATES_TO",
					userDescription: args.userDescription ?? null,
					isManual: args.isManual ?? false,
					isCrossRepo: args.isCrossRepo ?? false,
					isAiGenerated: args.isAiGenerated ?? false,
					isUserKind: args.isUserKind ?? false,
					updatedByUserId: args.updatedByUserId,
					...tenant,
				},
				select: EDGE_OVERRIDE_SELECT,
			})) as EdgeOverrideRow;
		} catch (error) {
			if ((error as { code?: string } | null)?.code !== "P2002") {
				throw error;
			}
			const winner = await findEdgeOverride(ctx, args);
			if (!winner) {
				throw error;
			}
			row = (await db.atlasEdgeOverride.update({
				where: { id: winner.id },
				data: writeUpdate,
				select: EDGE_OVERRIDE_SELECT,
			})) as EdgeOverrideRow;
		}
	}

	if (!existing) {
		await db.atlasEdgeOverrideHistory.create({
			data: {
				overrideId: row.id,
				action: "created",
				oldValue: null,
				newValue: args.userDescription ?? null,
				editedByUserId: args.updatedByUserId,
				...tenant,
			},
		});
	} else if (descriptionChanged) {
		await db.atlasEdgeOverrideHistory.create({
			data: {
				overrideId: row.id,
				action: "description",
				oldValue: existing.userDescription ?? null,
				newValue: args.userDescription ?? null,
				editedByUserId: args.updatedByUserId,
				...tenant,
			},
		});
	}

	return row;
}

/** Soft-delete an edge override (set deletedAt + `deleted` history). A user
 * deletion also DEMOTES an AI-generated reference to a user-owned edit
 * (`isAiGenerated=false`) so a later "keep my edits" re-map respects the deletion
 * instead of regenerating the link. */
export async function softDeleteEdgeOverride(
	ctx: AtlasContext,
	id: string,
	editorId: string,
): Promise<EdgeOverrideRow> {
	const tenant = tenantColumns(ctx);
	const row = (await db.atlasEdgeOverride.update({
		where: { id },
		data: {
			deletedAt: new Date(),
			isAiGenerated: false,
			updatedByUserId: editorId,
		},
		select: EDGE_OVERRIDE_SELECT,
	})) as EdgeOverrideRow;
	await db.atlasEdgeOverrideHistory.create({
		data: {
			overrideId: id,
			action: "deleted",
			oldValue: null,
			newValue: null,
			editedByUserId: editorId,
			...tenant,
		},
	});
	return row;
}

/** Restore a soft-deleted edge override (clear deletedAt + `restored` history). */
export async function restoreEdgeOverride(
	ctx: AtlasContext,
	id: string,
	editorId: string,
): Promise<EdgeOverrideRow> {
	const tenant = tenantColumns(ctx);
	const row = (await db.atlasEdgeOverride.update({
		where: { id },
		data: { deletedAt: null, updatedByUserId: editorId },
		select: EDGE_OVERRIDE_SELECT,
	})) as EdgeOverrideRow;
	await db.atlasEdgeOverrideHistory.create({
		data: {
			overrideId: id,
			action: "restored",
			oldValue: null,
			newValue: null,
			editedByUserId: editorId,
			...tenant,
		},
	});
	return row;
}

/**
 * Hard-delete a project's CROSS-REPO edge overrides (both lenses) — the "fresh"
 * System-map re-map wipes the user's cross-repo edits so the recompute starts from
 * a clean slate. History rows cascade with the override. Returns the count removed.
 */
export async function deleteCrossRepoEdgeOverrides(
	ctx: AtlasContext,
	projectId: string,
): Promise<number> {
	const result = await db.atlasEdgeOverride.deleteMany({
		where: { projectId, isCrossRepo: true, ...tenantWhere(ctx) },
	});
	return result.count;
}

/**
 * Hard-delete a repo's SOLO (intra-repo) edge overrides for BOTH lenses.
 * `onlyAiGenerated` (the "keep my edits" re-map) removes just the regeneratable
 * AI references; without it (the "fresh" re-map) ALL of this repo's edge edits are
 * wiped. History rows cascade with the override. Returns the count removed.
 */
export async function deleteSoloEdgeOverrides(
	ctx: AtlasContext,
	args: {
		projectId: string;
		repositoryIntegrationId: string | null;
		branch: string;
		onlyAiGenerated?: boolean;
	},
): Promise<number> {
	const result = await db.atlasEdgeOverride.deleteMany({
		where: {
			projectId: args.projectId,
			branch: args.branch,
			isCrossRepo: false,
			sourceRepositoryIntegrationId: args.repositoryIntegrationId,
			targetRepositoryIntegrationId: args.repositoryIntegrationId,
			...(args.onlyAiGenerated ? { isAiGenerated: true } : {}),
			...tenantWhere(ctx),
		},
	});
	return result.count;
}

/**
 * Endpoint pairs (per lens) that already carry a user override for this repo's
 * solo graph — the set a "keep my edits" re-map must NOT regenerate over (a
 * user-edited description, a manual edge, or a user deletion all win). Keyed
 * `${mode}\u0000${sourceKey}\u0000${targetKey}`, undirected (both orders added).
 */
export async function getSoloOverrideEndpointPairs(
	ctx: AtlasContext,
	args: {
		projectId: string;
		repositoryIntegrationId: string | null;
		branch: string;
	},
): Promise<Set<string>> {
	const rows = await db.atlasEdgeOverride.findMany({
		where: {
			projectId: args.projectId,
			branch: args.branch,
			isCrossRepo: false,
			sourceRepositoryIntegrationId: args.repositoryIntegrationId,
			targetRepositoryIntegrationId: args.repositoryIntegrationId,
			...tenantWhere(ctx),
		},
		select: { mode: true, sourceKey: true, targetKey: true },
	});
	const set = new Set<string>();
	for (const r of rows) {
		set.add(`${r.mode}\u0000${r.sourceKey}\u0000${r.targetKey}`);
		set.add(`${r.mode}\u0000${r.targetKey}\u0000${r.sourceKey}`);
	}
	return set;
}

// ── Cross-link recompute (re-map) history ────────────────────────────────────

export interface CrossLinkRunSummary {
	id: string;
	trigger: "auto" | "remap" | "remap_fresh";
	status: AnalysisRunStatus;
	repositoryIntegrationIds: string[];
	edgeCount: number;
	model: string | null;
	totalTokens: number | null;
	costMicroUsd: number | null;
	error: string | null;
	startedAt: string; // ISO
	completedAt: string | null; // ISO
	durationMs: number | null;
	triggeredByUserId: string | null;
	triggeredByName: string | null;
	triggeredByEmail: string | null;
}

/** Record ONE cross-link recompute run (System-map relationship history). */
export async function recordCrossLinkRun(
	ctx: AtlasContext,
	input: {
		projectId: string;
		triggeredByUserId: string | null;
		trigger: "auto" | "remap" | "remap_fresh";
		status: "READY" | "FAILED";
		repositoryIntegrationIds: string[];
		edgeCount: number;
		model: string | null;
		totalTokens: number | null;
		costMicroUsd: number | null;
		error: string | null;
		startedAt: Date;
		durationMs: number | null;
	},
): Promise<void> {
	const completedAt = new Date();
	await db.atlasCrossLinkRun.create({
		data: {
			projectId: input.projectId,
			triggeredByUserId: input.triggeredByUserId,
			trigger: input.trigger,
			status: input.status,
			repositoryIntegrationIds: input.repositoryIntegrationIds,
			edgeCount: input.edgeCount,
			model: input.model,
			totalTokens: input.totalTokens,
			costMicroUsd: input.costMicroUsd,
			error: input.error,
			startedAt: input.startedAt,
			completedAt,
			durationMs: input.durationMs,
			...tenantColumns(ctx),
		},
	});
}

/** Total cross-link runs for a project (drives the history total). */
export function countCrossLinkRuns(
	ctx: AtlasContext,
	projectId: string,
): Promise<number> {
	return db.atlasCrossLinkRun.count({
		where: { projectId, ...tenantWhere(ctx) },
	});
}

/** Recent cross-link recompute runs for a project (newest-first). */
export async function getCrossLinkRuns(
	ctx: AtlasContext,
	projectId: string,
	limit = 20,
	offset = 0,
): Promise<CrossLinkRunSummary[]> {
	const runs = await db.atlasCrossLinkRun.findMany({
		where: { projectId, ...tenantWhere(ctx) },
		orderBy: { startedAt: "desc" },
		skip: offset,
		take: limit,
	});
	const userIds = [
		...new Set(
			runs
				.map((r) => r.triggeredByUserId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const users =
		userIds.length > 0
			? await db.user.findMany({
					where: { id: { in: userIds } },
					select: { id: true, name: true, email: true },
				})
			: [];
	const userById = new Map(users.map((u) => [u.id, u]));
	const normalizeTrigger = (t: string): CrossLinkRunSummary["trigger"] =>
		t === "remap" || t === "remap_fresh" ? t : "auto";
	return runs.map((r) => {
		const user = r.triggeredByUserId
			? userById.get(r.triggeredByUserId)
			: undefined;
		return {
			id: r.id,
			trigger: normalizeTrigger(r.trigger),
			status: r.status as AnalysisRunStatus,
			repositoryIntegrationIds: r.repositoryIntegrationIds,
			edgeCount: r.edgeCount,
			model: r.model,
			totalTokens: r.totalTokens,
			costMicroUsd: r.costMicroUsd,
			error: r.error,
			startedAt: r.startedAt.toISOString(),
			completedAt: r.completedAt?.toISOString() ?? null,
			durationMs: r.durationMs,
			triggeredByUserId: r.triggeredByUserId,
			triggeredByName: user?.name ?? null,
			triggeredByEmail: user?.email ?? null,
		};
	});
}

/** Edit history for an edge override (newest-first), with editor names resolved. */
export async function getEdgeOverrideHistory(
	ctx: AtlasContext,
	overrideId: string,
	limit = 50,
): Promise<EdgeOverrideHistoryEntry[]> {
	const rows = await db.atlasEdgeOverrideHistory.findMany({
		where: { overrideId, ...tenantWhere(ctx) },
		orderBy: { createdAt: "desc" },
		take: limit,
		select: {
			id: true,
			action: true,
			oldValue: true,
			newValue: true,
			editedByUserId: true,
			createdAt: true,
		},
	});
	const userIds = [
		...new Set(
			rows
				.map((r) => r.editedByUserId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const users =
		userIds.length > 0
			? await db.user.findMany({
					where: { id: { in: userIds } },
					select: { id: true, name: true, email: true },
				})
			: [];
	const userById = new Map(users.map((u) => [u.id, u]));
	const normalizeAction = (a: string): EdgeOverrideHistoryEntry["action"] =>
		a === "created" || a === "deleted" || a === "restored"
			? a
			: "description";
	return rows.map((r) => {
		const user = r.editedByUserId
			? userById.get(r.editedByUserId)
			: undefined;
		return {
			id: r.id,
			action: normalizeAction(r.action),
			oldValue: r.oldValue,
			newValue: r.newValue,
			editedByUserId: r.editedByUserId,
			editedByName: user?.name ?? user?.email ?? null,
			createdAt: r.createdAt.toISOString(),
		};
	});
}

// ── Persistent chat conversations (shared & private) ─────────────────────────

function asStoredMessages(value: Prisma.JsonValue | null): StoredChatMessage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: StoredChatMessage[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const msg = raw as Record<string, unknown>;
		const role = msg.role;
		const content = msg.content;
		if (
			(role === "user" || role === "assistant" || role === "system") &&
			typeof content === "string"
		) {
			out.push({
				role,
				content,
				createdAt:
					typeof msg.createdAt === "string"
						? msg.createdAt
						: undefined,
				// Server-set marker for a partially-streamed reply. Whitelisted
				// (only the literal `true` survives); rows without it — every
				// pre-existing message — are untouched.
				...(msg.interrupted === true
					? { interrupted: true as const }
					: {}),
			});
		}
	}
	return out;
}

/**
 * Conversations visible to the caller within a project+repo: their own
 * (any visibility) OR any SHARED conversation in the tenant. Newest first and
 * WITHOUT the heavy `messages` blob — the History list only needs the header.
 * Deliberately NOT filtered by graph mode: there is one assistant and one
 * shared history, so legacy BUSINESS and TECHNICAL rows all stay visible.
 */
/**
 * Total conversations the caller may see (own + SHARED) for a project's repo —
 * the same visibility/tenant filter as `listConversations`, used to drive the
 * "X conversations" total and the "Show more" affordance.
 */
export function countConversations(
	ctx: AtlasContext,
	input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		isSystemScope?: boolean;
	},
): Promise<number> {
	return db.atlasConversation.count({
		where: {
			projectId: input.projectId,
			...(input.isSystemScope
				? { isSystemScope: true }
				: {
						repositoryIntegrationId: input.repositoryIntegrationId,
						isSystemScope: false,
					}),
			...tenantWhere(ctx),
			OR: [{ userId: ctx.userId }, { visibility: "SHARED" }],
		},
	});
}

export async function listConversations(
	ctx: AtlasContext,
	input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		/** Page size. Omit to return every visible conversation (legacy). */
		limit?: number;
		/** Rows to skip for offset-based pagination (newest first). */
		offset?: number;
		/** true = System-map (project-wide) conversations; else per-repo. */
		isSystemScope?: boolean;
	},
): Promise<ConversationSummary[]> {
	const rows = await db.atlasConversation.findMany({
		where: {
			projectId: input.projectId,
			...(input.isSystemScope
				? { isSystemScope: true }
				: {
						repositoryIntegrationId: input.repositoryIntegrationId,
						isSystemScope: false,
					}),
			...tenantWhere(ctx),
			OR: [{ userId: ctx.userId }, { visibility: "SHARED" }],
		},
		orderBy: { updatedAt: "desc" },
		...(input.offset ? { skip: input.offset } : {}),
		...(input.limit !== undefined ? { take: input.limit } : {}),
		select: {
			id: true,
			mode: true,
			title: true,
			visibility: true,
			userId: true,
			updatedAt: true,
		},
	});

	const ownerIds = [...new Set(rows.map((r) => r.userId))];
	const owners =
		ownerIds.length > 0
			? await db.user.findMany({
					where: { id: { in: ownerIds } },
					select: { id: true, name: true, email: true },
				})
			: [];
	const ownerById = new Map(owners.map((u) => [u.id, u]));

	return rows.map((r) => {
		const owner = ownerById.get(r.userId);
		return {
			id: r.id,
			mode: r.mode,
			title: r.title,
			visibility: r.visibility,
			userId: r.userId,
			ownerName: owner?.name ?? owner?.email ?? null,
			isOwner: r.userId === ctx.userId,
			updatedAt: r.updatedAt.toISOString(),
		};
	});
}

/**
 * A single conversation including its messages, enforcing visibility AND
 * project binding (the id must belong to the permission-checked project).
 */
export async function getConversation(
	ctx: AtlasContext,
	input: { conversationId: string; projectId: string },
): Promise<ConversationDetail | null> {
	// `projectId` is REQUIRED in the WHERE: the caller's project permission was
	// checked against the projectId in the request, so the conversation must be
	// bound to that same project — otherwise a member authorized on project A
	// could read a SHARED conversation of project B in the same tenant.
	const row = await db.atlasConversation.findFirst({
		where: {
			id: input.conversationId,
			projectId: input.projectId,
			...tenantWhere(ctx),
		},
	});
	if (!row) {
		return null;
	}
	// Visibility floor: owner sees their own; everyone in the tenant sees SHARED.
	if (row.userId !== ctx.userId && row.visibility !== "SHARED") {
		return null;
	}
	return {
		id: row.id,
		mode: row.mode,
		projectId: row.projectId,
		repositoryIntegrationId: row.repositoryIntegrationId,
		title: row.title,
		visibility: row.visibility,
		userId: row.userId,
		isOwner: row.userId === ctx.userId,
		messages: asStoredMessages(row.messages),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function createConversation(
	ctx: AtlasContext,
	input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		title?: string;
		visibility?: ChatVisibility;
		messages?: StoredChatMessage[];
		/** Create a System-map (multi-repo, project-wide) conversation. */
		isSystemScope?: boolean;
	},
): Promise<ConversationDetail> {
	const row = await db.atlasConversation.create({
		data: {
			projectId: input.projectId,
			// System-map conversations are project-wide → no single repo.
			repositoryIntegrationId: input.isSystemScope
				? null
				: input.repositoryIntegrationId,
			isSystemScope: input.isSystemScope ?? false,
			// Conversations are mode-independent; new rows write the canonical
			// value (the column stays for legacy rows — no migration).
			mode: "TECHNICAL",
			...(input.title ? { title: input.title } : {}),
			...(input.visibility ? { visibility: input.visibility } : {}),
			messages: (input.messages ??
				[]) as unknown as Prisma.InputJsonValue,
			...tenantColumns(ctx),
		},
	});
	return {
		id: row.id,
		mode: row.mode,
		projectId: row.projectId,
		repositoryIntegrationId: row.repositoryIntegrationId,
		title: row.title,
		visibility: row.visibility,
		userId: row.userId,
		isOwner: true,
		messages: asStoredMessages(row.messages),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Append messages to a conversation (and optionally promote its title) as a
 * SINGLE atomic jsonb-concat UPDATE — read-modify-write would let two
 * concurrent appends (two tabs, finish racing abort) lose one. `"updatedAt"`
 * is set explicitly because raw SQL bypasses Prisma's `@updatedAt`.
 *
 * Returns the number of rows updated: callers persisting the PRE-STREAM user
 * turn treat 0 (conversation gone) as a hard failure, while the post-stream
 * assistant append keeps the historical silent-return semantics.
 *
 * No tenant filter here because the caller (facade) has already loaded +
 * access-checked the conversation by id; the write targets that exact row.
 */
export async function appendMessages(
	conversationId: string,
	messages: StoredChatMessage[],
	title?: string,
): Promise<number> {
	const payload = JSON.stringify(messages);
	return db.$executeRaw`
		UPDATE atlas_conversation
		SET messages = COALESCE(messages, '[]'::jsonb) || ${payload}::jsonb,
			title = COALESCE(${title ?? null}, title),
			"updatedAt" = now()
		WHERE id = ${conversationId}
	`;
}

/** Rename / re-scope a conversation — owner only. Returns false if not owner. */
export async function updateConversation(
	ctx: AtlasContext,
	input: {
		conversationId: string;
		title?: string;
		visibility?: ChatVisibility;
	},
): Promise<boolean> {
	const result = await db.atlasConversation.updateMany({
		where: {
			id: input.conversationId,
			userId: ctx.userId,
			...tenantWhere(ctx),
		},
		data: {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.visibility !== undefined
				? { visibility: input.visibility }
				: {}),
		},
	});
	return result.count > 0;
}

/** Delete a conversation — owner only. Returns false if not owner / not found. */
export async function deleteConversation(
	ctx: AtlasContext,
	conversationId: string,
): Promise<boolean> {
	const result = await db.atlasConversation.deleteMany({
		where: { id: conversationId, userId: ctx.userId, ...tenantWhere(ctx) },
	});
	return result.count > 0;
}
