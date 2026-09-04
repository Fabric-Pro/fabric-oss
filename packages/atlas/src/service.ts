/**
 * AtlasService — THE facade for the Atlas feature.
 *
 * Every consumer routes through this class:
 *  - oRPC procedures call the read/orchestration methods (listRepositories,
 *    getStatus, getGraph, getNode, requestAnalysis, describeNodeOnDemand, chat).
 *  - Temporal activities call the producer methods (runStructureAnalysis,
 *    describeChangedModules, deriveBusiness, finalize, markStatus).
 * So `findReferences(AtlasService)` enumerates the whole feature.
 *
 * Repository acquisition (clone + walk + redact) is implemented here (own
 * implementation, modelled on — not importing — the code-indexing pipeline).
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAIModelWithMetadata, streamText } from "@repo/ai";
import { listRepositoryBranches } from "@repo/connectors";
import { recordAudit } from "@repo/database";
import {
	buildAuthCloneUrl,
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
} from "@repo/integrations";
import { logger } from "@repo/logs";
import simpleGit, { type SimpleGitOptions } from "simple-git";
import { deriveBusinessGraph } from "./business";
import {
	buildSystemChatPrompt,
	buildSystemPrompt,
	type ChatCrossRef,
} from "./chat";
import { countCommitsSince } from "./commits";
import {
	addTokenTotals,
	computeCostMicroUsd,
	concatReasoning,
	EMPTY_TOKEN_TOTALS,
	type TokenTotals,
} from "./cost";
import { ensureFreshRepoCredentials } from "./credentials";
import {
	computeSignature,
	type DetectedCrossEdge,
	detectAiEdges,
	detectStructuralEdges,
	fnv1a,
	type RepoAnalysisData,
	type RepoNodeLite,
} from "./cross-repo";
import { describeFile, describeModules } from "./describe";
import { AtlasError } from "./errors";
import { buildTechnicalGraphStreaming } from "./graph/build";
import { diffManifests, type FileManifest } from "./graph/incremental";
import {
	isAnalyzableSource,
	isInSkippedDir,
	MAX_ANALYZED_FILE_BYTES,
	normalizePath,
} from "./graph/languages";
import {
	isManifestPath,
	type ManifestFile,
	parsePublishedPackages,
	parseTechStack,
} from "./graph/manifest";
import { redactSecrets } from "./graph/secrets";
import { detectIntraRepoReferences } from "./intra-repo";
import * as queries from "./queries";
import { generateBusinessTour } from "./tour";
import type {
	AnalysisRunSummary,
	AtlasContext,
	AtlasGraph,
	AtlasNodeDetail,
	AtlasStatus,
	BusinessTour,
	ChatVisibility,
	ConversationDetail,
	ConversationSummary,
	CrossEdgeDetection,
	CrossLinkState,
	CrossLinkStatus,
	EdgeEndpoint,
	EdgeOverrideHistoryEntry,
	EffectiveEdgeOverride,
	GraphMode,
	GraphNode,
	NodeLayoutPosition,
	NodeOverrideHistoryEntry,
	OverlaidCrossEdge,
	RepoBranch,
	RepoGroupInfo,
	RepoOption,
	StoredChatMessage,
	SystemCrossEdgeKind,
	SystemGraph,
	SystemGraphEdge,
	SystemGraphNode,
	SystemLayoutPosition,
	TechStackEntry,
	UnavailableRepo,
} from "./types";
import { recordAtlasUsage } from "./usage";
import {
	ATLAS_TASK_QUEUE,
	ATLAS_WORKFLOW,
	type StartAnalysisPlan,
} from "./workflow";

const MAX_FILES = 20000;
/** Markdown docs we collect alongside source (attached to nodes + fed to business). */
const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i;
const MAX_DOC_FILE_BYTES = 200_000;
/** Cap on concatenated documentation stored per module node. */
const MAX_MODULE_DOC_CHARS = 4000;
/**
 * A run still flagged in-flight after this long is treated as orphaned and
 * self-healed to FAILED on the next `getStatus` read. It sits just past the
 * workflow-execution cap in `analyze.ts` (5h) plus a buffer, so it only trips
 * for genuinely interrupted runs (worker death, deploy, or an uncatchable
 * Temporal execution-timeout — none of which run the workflow's
 * `catch → finalize(FAILED)`), never for a long-but-healthy analysis.
 */
const STALE_IN_FLIGHT_MS = 320 * 60 * 1000; // 5h20m

/** Mirrors the Prisma column default on `AtlasConversation.title`. */
const DEFAULT_CONVERSATION_TITLE = "New conversation";
const CONVERSATION_TITLE_MAX_CHARS = 60;

/** Derive a conversation title from the first user message (single line, capped). */
function deriveConversationTitle(firstUserMessage: string): string {
	const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
	if (!cleaned) {
		return DEFAULT_CONVERSATION_TITLE;
	}
	return cleaned.length > CONVERSATION_TITLE_MAX_CHARS
		? `${cleaned.slice(0, CONVERSATION_TITLE_MAX_CHARS).trimEnd()}…`
		: cleaned;
}

/** User-facing message for an unrecoverable repo auth failure during analysis. */
const REPO_REAUTH_MESSAGE =
	"Repository authentication failed. Reconnect the repository in Settings, then re-run the analysis.";

/**
 * Whether a git error is a TRANSIENT promisor back-fill failure — the kind a
 * blobless (`--filter=blob:none`) clone hits when the sparse-checkout lazily
 * fetches the wanted blobs from the remote, and which usually clears on a quick
 * retry (`fetch-pack: invalid index-pack output`, `fatal: early EOF`,
 * `could not fetch <sha> from promisor remote`, `RPC failed`, `remote end hung
 * up`). Matched on the message text simple-git surfaces from the underlying `git`
 * process. Used ONLY to retry the back-fill `checkout` a few times before falling
 * back to a (larger) full checkout — it deliberately does NOT match auth wording,
 * since an authentication failure is terminal and must never be retried here.
 */
function isTransientBackfillError(error: unknown): boolean {
	const message = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return (
		message.includes("invalid index-pack output") ||
		message.includes("early eof") ||
		message.includes("promisor remote") ||
		message.includes("rpc failed") ||
		message.includes("remote end hung up") ||
		message.includes("fetch-pack")
	);
}

/**
 * Bounded IN-ACTIVITY retry for the repo clone. A large fetch can die with a
 * transient network failure (`fatal: early EOF`, `fetch-pack: invalid index-pack
 * output`, `RPC failed`) that clears on a quick retry. Retrying a few times here —
 * each into a FRESH directory — recovers in seconds, rather than failing the whole
 * 90-minute activity and waiting out Temporal's (heavier) activity-level retry.
 * Auth failures and user cancellations are terminal and are NEVER retried
 * (see `acquireRepoForAnalysis`).
 */
const CLONE_MAX_ATTEMPTS = 3;
const CLONE_RETRY_BASE_DELAY_MS = 1500;

/**
 * Bounded retry for the blobless promisor back-fill — the `git checkout` after
 * `sparse-checkout set` that lazily fetches the wanted blobs from the remote. A
 * transient network blip surfaces THERE (not at clone time), so a quick retry
 * usually recovers at the SMALL (blobless) on-disk footprint, before the (larger)
 * full-checkout fallback is reached. Short backoff: this is one local checkout
 * re-driving a partial fetch, not a fresh full clone.
 */
const SPARSE_CHECKOUT_MAX_ATTEMPTS = 3;
const SPARSE_CHECKOUT_RETRY_BASE_DELAY_MS = 1000;

/**
 * Redact any `scheme://user:secret@host` credentials embedded in a string before
 * it is persisted or surfaced — defence in depth so a token carried in a remote
 * URL can never leak into a stored analysis error or a log line.
 */
function redactUrlCredentials(text: string): string {
	return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
}

/**
 * A message that is UNAMBIGUOUSLY a git-remote authentication failure — it names
 * the remote URL (`Authentication failed for 'https://…'`) or uses git-only
 * credential-prompt wording. Deliberately TIGHTER than `isGitAuthError`:
 * `humanizeAnalysisError` runs over EVERY failed-analysis message (including the
 * AI describe/business steps), so a bare "authentication failed" from a non-git
 * source (e.g. an AI provider) must NOT be relabelled as a repo-reconnect error.
 */
function isRepoCloneAuthFailure(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		/authentication failed for ['"]?[a-z][a-z0-9+.-]*:\/\//i.test(
			message,
		) ||
		lower.includes("could not read username") ||
		lower.includes("could not read password") ||
		lower.includes("terminal prompts disabled") ||
		lower.includes("invalid username or token") ||
		lower.includes("invalid username or password")
	);
}

/**
 * Make a stored analysis-failure message safe + actionable for the UI. A
 * git-remote authentication failure (which also embeds the repo in a remote URL)
 * becomes the clean reconnect guidance; everything else passes through with any
 * credentials embedded in a remote URL stripped. The analysis path already
 * converts a clone auth failure into `REPO_REAUTH_MESSAGE` before finalize, so
 * the relabel here is defence in depth for any raw git error that reaches it.
 * Idempotent, and a null/empty error is preserved.
 */
function humanizeAnalysisError(
	error: string | null | undefined,
): string | null {
	if (!error) {
		return error ?? null;
	}
	if (
		isRepoCloneAuthFailure(error) ||
		error.includes("REPOSITORY_REAUTH_REQUIRED")
	) {
		return REPO_REAUTH_MESSAGE;
	}
	return redactUrlCredentials(error);
}

/** A collected markdown doc (path + redacted content) attached to nodes. */
interface DocFile {
	path: string;
	content: string;
}

/**
 * Escape gitignore/sparse-checkout glob metacharacters so a non-cone pattern
 * matches a path LITERALLY. Patterns are gitignore-syntax, where `*`, `?`, `[`,
 * `]` are wildcards and `\` escapes the next char; a rare source path containing
 * one of these would otherwise over-match. (Leading `#`/`!` are not a concern
 * here because every pattern is prefixed with an anchoring `/`.)
 */
function escapeSparsePattern(p: string): string {
	return p.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`);
}

const ROOT_MODULE = "(root)";
function moduleKeyAtDepth(filePath: string, depth: number): string {
	const dirSegs = filePath.split("/").slice(0, -1);
	if (dirSegs.length === 0) {
		return ROOT_MODULE;
	}
	return dirSegs.slice(0, depth).join("/");
}

export class AtlasService {
	constructor(private readonly ctx: AtlasContext) {}

	// ── Reads / orchestration (oRPC procedures) ────────────────────────────────

	listRepositories(input: { projectId: string }): Promise<RepoOption[]> {
		return queries.listProjectRepositories(this.ctx, input.projectId);
	}

	private async resolveRepoOption(
		projectId: string,
		repositoryIntegrationId: string | null,
	): Promise<RepoOption | null> {
		const repos = await queries.listProjectRepositories(
			this.ctx,
			projectId,
		);
		if (repos.length === 0) {
			return null;
		}
		if (repositoryIntegrationId) {
			return (
				repos.find(
					(r) =>
						r.repositoryIntegrationId === repositoryIntegrationId,
				) ?? null
			);
		}
		return repos.find((r) => r.isDefault) ?? repos[0];
	}

	/**
	 * Resolve the analysis to surface for a (possibly null) repo. Analyses are
	 * stored per branch, so the order is: (a) the exact row for the repo's
	 * monitored branch, (b) the integration's latest row on any branch (a
	 * never-analysed monitored branch keeps the last map viewable), (c) the
	 * orphan re-attach for a removed + re-added repo (delete + re-add yields a
	 * NEW integration id), keyed on the repository URL so it works for any
	 * provider. With no live repo at all (disconnected after analysis), falls
	 * back to the project's latest analysis.
	 */
	private async resolveAnalysis(projectId: string, repo: RepoOption | null) {
		if (!repo) {
			return queries.findLatestAnalysisForProject(this.ctx, projectId);
		}
		// (a) The exact per-branch row for the currently monitored branch —
		// switching back to a previously analysed branch restores its map.
		const exact = await queries.findAnalysis(
			this.ctx,
			projectId,
			repo.repositoryIntegrationId,
			repo.defaultBranch,
		);
		if (exact) {
			return exact;
		}
		// (b) Any branch's latest row for this integration: a never-analysed
		// monitored branch keeps the last map viewable read-only (the status
		// bar shows the re-analyse-to-apply hint because `analysis.branch !==
		// repository.defaultBranch`).
		const latestForIntegration =
			await queries.findLatestAnalysisForIntegration(
				this.ctx,
				projectId,
				repo.repositoryIntegrationId,
			);
		if (latestForIntegration) {
			return latestForIntegration;
		}
		// (c) Orphan re-attach (removed + re-added repo), per branch.
		return this.adoptOrphanedAnalysis(projectId, repo);
	}

	/**
	 * Re-attach the analyses orphaned by a removed/replaced repo to the current
	 * (re-added) integration, matched on the repository URL. Adopts only rows
	 * whose integration is no longer live, so it never steals from a sibling
	 * repo that is still connected. Adoption is per branch: every orphaned
	 * branch row is re-pointed where its (project, integration, branch) slot is
	 * free (P2002 conflicts are skipped), and the row matching the
	 * integration's current monitored branch is preferred as the result.
	 */
	private async adoptOrphanedAnalysis(projectId: string, repo: RepoOption) {
		if (!repo.repositoryIntegrationId) {
			return null;
		}
		const repos = await queries.listProjectRepositories(
			this.ctx,
			projectId,
		);
		const liveIds = repos
			.map((r) => r.repositoryIntegrationId)
			.filter((id): id is string => Boolean(id));
		const orphans = await queries.findAdoptableAnalyses(
			this.ctx,
			projectId,
			repo.repositoryUrl,
			liveIds,
			repo.defaultBranch,
		);
		// Candidates arrive preferred-branch-first, so the first successful
		// adoption is the best row to surface.
		let adopted: Awaited<ReturnType<typeof queries.adoptAnalysis>> | null =
			null;
		for (const orphan of orphans) {
			const result = await queries.adoptAnalysis(
				this.ctx,
				orphan.id,
				repo.repositoryIntegrationId,
				{
					provider: repo.provider,
					repositoryUrl: repo.repositoryUrl,
					repositoryName: repo.repositoryName,
				},
			);
			if (result && !adopted) {
				adopted = result;
			}
		}
		return adopted;
	}

	async getStatus(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
	}): Promise<AtlasStatus> {
		let repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);

		// Lazy self-heal: a GitHub OAuth integration whose token lapsed between
		// scheduled health checks refreshes here (cooldown-throttled, in-process
		// locked) so the commits-behind indicator and the Re-analyse gate come
		// back without user action. The helper never throws, but this read must
		// never fail or slow because of a refresh, so it is belt-and-braces
		// wrapped; on any failure the current (non-ACTIVE) state is returned.
		let canAutoRefreshCredentials = false;
		if (
			repo?.repositoryIntegrationId &&
			repo.provider === "GITHUB" &&
			repo.authMethod === "OAUTH"
		) {
			try {
				const refreshed = await ensureFreshRepoCredentials({
					integrationId: repo.repositoryIntegrationId,
					userId: this.ctx.userId,
					organizationId: this.ctx.organizationId,
					force: false,
				});
				canAutoRefreshCredentials = refreshed.canAutoRefresh;
				// "ERROR" doubles as the helper's never-throw sentinel for a
				// failed integration READ — not a state observed on the row. A
				// transient read hiccup must not repaint a healthy repo as
				// reconnect-needed for a poll, so keep the list-read status; a
				// genuinely ERROR'd row already carries that status from the
				// list read itself.
				if (
					refreshed.status !== "ERROR" &&
					refreshed.status !== repo.status
				) {
					repo = { ...repo, status: refreshed.status };
				}
			} catch (error) {
				logger.warn("[atlas] credential refresh failed", {
					integrationId: repo.repositoryIntegrationId,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Resolve the analysis (direct → adopt-orphaned-repo → project-latest);
		// see `resolveAnalysis`. Kept as `let` so the stale-run reconciliation
		// below can replace it with a FAILED copy.
		let analysis = await this.resolveAnalysis(input.projectId, repo);

		// Stuck-run safety net. A workflow that is interrupted (worker death,
		// deploy, or an uncatchable Temporal execution-timeout) never runs its
		// `catch → finalize(FAILED)`, leaving the run stuck in flight so the UI
		// spins forever. This now covers BOTH the served-status in-flight (a
		// first-ever analysis) AND the background-run marker (a re-analysis of an
		// already-READY snapshot keeps `status` = READY, so staleness is judged on
		// `activeRunStartedAt`). `failAnalysisRun` — invoked via finalize(FAILED)
		// below — never blanks a previously-good snapshot. Best-effort: never let
		// reconciliation throw out of a status read.
		const servedInFlight =
			analysis?.status === "ANALYZING" || analysis?.status === "PENDING";
		const runMarkerInFlight =
			analysis?.activeRunStatus === "ANALYZING" ||
			analysis?.activeRunStatus === "PENDING";
		const inFlightStart =
			analysis?.activeRunStartedAt ??
			(servedInFlight ? (analysis?.updatedAt ?? null) : null);
		if (
			analysis &&
			(servedInFlight || runMarkerInFlight) &&
			inFlightStart &&
			Date.now() - inFlightStart.getTime() > STALE_IN_FLIGHT_MS
		) {
			const staleError =
				"Analysis did not finish in time and was interrupted. Please retry.";
			try {
				await queries.finalizeAnalysis(analysis.id, {
					status: "FAILED",
					error: staleError,
				});
				await queries.completeLatestRun(this.ctx, {
					analysisId: analysis.id,
					status: "FAILED",
					error: "Interrupted (exceeded maximum run time).",
				});
				recordAudit({
					action: "atlas.analysis.failed",
					severity: "error",
					outcome: "failure",
					actor: { type: "user", userId: this.ctx.userId },
					organizationId: this.ctx.organizationId ?? null,
					projectId: input.projectId,
					resource: { type: "atlas_analysis", id: analysis.id },
					metadata: { error: "stale-in-flight-reconciled" },
				});
				// Re-read so the served state reflects the keep-READY-if-snapshot
				// rule (a stale RE-run keeps its last-good READY graph).
				analysis =
					(await queries.findAnalysisById(this.ctx, analysis.id)) ??
					analysis;
			} catch (error) {
				logger.warn("[atlas] stale-run reconciliation failed", {
					analysisId: analysis.id,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		let newCommitCount: number | null = null;
		let behindCommitCount: number | null = null;
		let commitsComparable = false;
		let headSha: string | null = null;

		if (
			analysis?.status === "READY" &&
			analysis.analyzedCommitSha &&
			repo &&
			// Don't probe the provider with a lapsed credential — it would 401.
			repo.status === "ACTIVE"
		) {
			const creds = await queries.resolveRepoCredentials(
				input.projectId,
				repo.repositoryIntegrationId as string,
				{
					userId: this.ctx.userId,
					organizationId: this.ctx.organizationId,
				},
			);
			if (creds) {
				const result = await countCommitsSince({
					provider: creds.provider,
					token: creds.token,
					repositoryUrl: creds.repositoryUrl,
					owner: creds.owner,
					repo: creds.repo,
					branch: analysis.branch || creds.branch,
					baseSha: analysis.analyzedCommitSha,
				});
				newCommitCount = result.aheadBy;
				behindCommitCount = result.behindBy;
				commitsComparable = result.comparable;
				headSha = result.headSha;
			}
		}

		return {
			analysisId: analysis?.id ?? null,
			status: analysis?.status ?? "NOT_ANALYZED",
			repository: repo,
			hasRepository: Boolean(repo),
			repositoryStatus:
				repo?.status ?? (analysis ? "DISCONNECTED" : null),
			canReanalyze: repo?.status === "ACTIVE",
			canAutoRefreshCredentials,
			analyzedCommitSha: analysis?.analyzedCommitSha ?? null,
			analyzedShortSha: analysis?.analyzedCommitSha?.slice(0, 7) ?? null,
			analyzedAt: analysis?.analyzedAt?.toISOString() ?? null,
			analyzedCommitAt: analysis?.analyzedCommitAt?.toISOString() ?? null,
			branch: analysis?.branch ?? repo?.defaultBranch ?? null,
			newCommitCount,
			behindCommitCount,
			commitsComparable,
			headSha,
			nodeCount: analysis?.nodeCount ?? 0,
			edgeCount: analysis?.edgeCount ?? 0,
			filesAnalyzed: analysis?.filesAnalyzed ?? 0,
			techStack: (analysis?.techStack as TechStackEntry[] | null) ?? null,
			businessTour:
				(analysis?.businessTour as BusinessTour | null) ?? null,
			error: analysis?.error ?? null,
			inFlightSince: this.computeInFlightSince(analysis),
			activeRun: this.computeActiveRun(analysis),
			analysisModel: analysis?.analysisModel ?? null,
			analysisTotalTokens: analysis?.totalTokens ?? null,
			analysisCostMicroUsd: analysis?.costMicroUsd ?? null,
			analysisDurationMs: analysis?.analysisDurationMs ?? null,
		};
	}

	/**
	 * The ISO start time of the in-flight run (background-run marker first, then a
	 * served-status in-flight first-run), or null when nothing is running.
	 */
	private computeInFlightSince(
		analysis: {
			status: string;
			activeRunStatus: string | null;
			activeRunStartedAt: Date | null;
			updatedAt: Date;
		} | null,
	): string | null {
		if (!analysis) {
			return null;
		}
		const runMarkerInFlight =
			analysis.activeRunStatus === "ANALYZING" ||
			analysis.activeRunStatus === "PENDING";
		const servedInFlight =
			analysis.status === "ANALYZING" || analysis.status === "PENDING";
		if (!runMarkerInFlight && !servedInFlight) {
			return null;
		}
		return (
			analysis.activeRunStartedAt ?? analysis.updatedAt
		).toISOString();
	}

	/**
	 * Non-blocking re-analysis indicator (R2). Reports the in-flight run phase +
	 * start time regardless of whether the served `status` is the last-good READY
	 * snapshot (re-run) or the in-flight status itself (first-ever analysis).
	 */
	private computeActiveRun(
		analysis: {
			status: string;
			activeRunStatus: string | null;
			activeRunStartedAt: Date | null;
			updatedAt: Date;
		} | null,
	): AtlasStatus["activeRun"] {
		if (!analysis) {
			return null;
		}
		const runMarkerInFlight =
			analysis.activeRunStatus === "ANALYZING" ||
			analysis.activeRunStatus === "PENDING";
		const servedInFlight =
			analysis.status === "ANALYZING" || analysis.status === "PENDING";
		if (!runMarkerInFlight && !servedInFlight) {
			return null;
		}
		const status: "PENDING" | "ANALYZING" =
			analysis.activeRunStatus === "ANALYZING" ||
			analysis.status === "ANALYZING"
				? "ANALYZING"
				: "PENDING";
		return {
			status,
			startedAt: (
				analysis.activeRunStartedAt ?? analysis.updatedAt
			).toISOString(),
		};
	}

	async getGraph(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		mode: GraphMode;
		/** Include soft-deleted edges (for an "edited connections" review surface). */
		includeDeleted?: boolean;
	}): Promise<AtlasGraph> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		const analysis = await this.resolveAnalysis(input.projectId, repo);
		if (!analysis || analysis.status !== "READY") {
			return {
				mode: input.mode,
				analysisId: analysis?.id ?? null,
				nodes: [],
				edges: [],
			};
		}
		const { nodes, edges } = await queries.getGraph(
			this.ctx,
			analysis.id,
			input.mode,
			{ includeDeleted: input.includeDeleted ?? false },
		);
		return { mode: input.mode, analysisId: analysis.id, nodes, edges };
	}

	async getNode(input: {
		projectId: string;
		analysisId: string;
		mode: GraphMode;
		key: string;
	}): Promise<AtlasNodeDetail> {
		// TENANT ISOLATION (SOC 2 CC6.1): bind the analysis to the
		// permission-checked project. The oRPC layer authorizes input.projectId
		// (requireProjectPermission), but analysisId is a separate input —
		// without this, a caller could read another project's/tenant's node
		// detail (source preview, file paths, neighbors) via a foreign
		// analysisId. resolveOverrideKey throws NOT_FOUND when
		// analysis.projectId !== projectId.
		await this.resolveOverrideKey(input.projectId, input.analysisId);
		const detail = await queries.getNodeDetail(this.ctx, {
			analysisId: input.analysisId,
			mode: input.mode,
			key: input.key,
		});
		if (!detail) {
			throw new AtlasError("NOT_FOUND", "Node not found");
		}
		return detail;
	}

	/**
	 * On-demand AI description for a single node (the "Describe with AI" button),
	 * with optional live `instructions` the user typed. Handles FILE nodes
	 * directly from their content preview, and MODULE nodes by stitching their
	 * child file previews into a combined context (mirroring how the batch
	 * `describeChangedModules` path samples a module's files).
	 */
	async describeNodeOnDemand(input: {
		projectId: string;
		analysisId: string;
		mode: GraphMode;
		key: string;
		instructions?: string;
	}): Promise<AtlasNodeDetail> {
		// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): bind the analysis to the
		// permission-checked project before reading node content AND overwriting
		// its descriptions. Without this, a caller could read another
		// project's/tenant's node source preview and overwrite its
		// technical/business descriptions via a foreign analysisId.
		await this.resolveOverrideKey(input.projectId, input.analysisId);
		const node = await queries.getNodeDetail(this.ctx, {
			analysisId: input.analysisId,
			mode: input.mode,
			key: input.key,
		});
		if (!node) {
			throw new AtlasError("NOT_FOUND", "Node not found");
		}

		const preview =
			node.kind === "MODULE"
				? await this.buildModulePreview(input.analysisId, input.key)
				: node.contentPreview;

		const described = await describeFile(
			{
				label: node.label,
				path: node.filePath ?? node.key,
				language: node.language,
				preview,
			},
			this.ctx,
			input.projectId,
			input.instructions,
		);
		if (!described) {
			throw new AtlasError(
				"NO_AI_PROVIDER",
				"No AI provider is configured. Add one in Settings → AI Providers.",
			);
		}
		await queries.updateNodeDescription(this.ctx, {
			analysisId: input.analysisId,
			mode: "TECHNICAL",
			key: input.key,
			technical: described.technical,
			business: described.business,
			category: described.category,
		});

		// Audit: per-node AI regeneration ("Regenerate with AI").
		recordAudit({
			action: "atlas.node.regenerated",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_node", id: input.key, name: node.label },
			metadata: {
				analysisId: input.analysisId,
				mode: input.mode,
				hasInstructions: Boolean(input.instructions),
			},
		});

		return {
			...node,
			technicalDescription: described.technical,
			businessDescription: described.business,
			// A user category override still wins; otherwise reflect the new AI one.
			category: node.isUserCategory
				? node.category
				: (described.category ?? node.category),
			description:
				input.mode === "BUSINESS"
					? described.business
					: described.technical,
		};
	}

	/** Stitch a module's sampled child-file previews into one grounding blob. */
	private async buildModulePreview(
		analysisId: string,
		moduleKey: string,
	): Promise<string | null> {
		const [moduleInfo] = await queries.getModulesForDescribe(analysisId, [
			moduleKey,
		]);
		if (!moduleInfo) {
			return null;
		}
		const parts: string[] = [];
		if (moduleInfo.dependsOn.length) {
			parts.push(
				`Depends on: ${moduleInfo.dependsOn.slice(0, 12).join(", ")}`,
			);
		}
		if (moduleInfo.dependedOnBy.length) {
			parts.push(
				`Used by: ${moduleInfo.dependedOnBy.slice(0, 12).join(", ")}`,
			);
		}
		for (const file of moduleInfo.sampleFiles) {
			parts.push(`// ${file.label}`);
			if (file.preview) {
				parts.push(file.preview);
			}
		}
		const joined = parts.join("\n");
		return joined.length > 0 ? joined : null;
	}

	// ── Node overrides + branch switcher (T6) ──────────────────────────────────

	/** Resolve the (project, repo, branch) override key from an analysis id. */
	private async resolveOverrideKey(
		projectId: string,
		analysisId: string,
	): Promise<{
		projectId: string;
		repositoryIntegrationId: string | null;
		branch: string;
	}> {
		const analysis = await queries.findAnalysisById(this.ctx, analysisId);
		if (!analysis || analysis.projectId !== projectId) {
			throw new AtlasError("NOT_FOUND", "Analysis not found");
		}
		return {
			projectId: analysis.projectId,
			repositoryIntegrationId: analysis.repositoryIntegrationId,
			branch: analysis.branch,
		};
	}

	/**
	 * Save a node's stable user override (T6 `updateNode`). Upserts the override
	 * (keyed by project/repo/branch/mode/node-key so it survives re-analysis),
	 * records an edit-history row per changed field, audits, and returns the
	 * updated EFFECTIVE node detail.
	 */
	async updateNode(input: {
		projectId: string;
		analysisId: string;
		mode: GraphMode;
		key: string;
		userDescription?: string | null;
		userCategory?: string | null;
	}): Promise<AtlasNodeDetail> {
		const overrideKey = await this.resolveOverrideKey(
			input.projectId,
			input.analysisId,
		);
		// Confirm the node exists in the served analysis before persisting a note.
		const node = await queries.getNodeDetail(this.ctx, {
			analysisId: input.analysisId,
			mode: input.mode,
			key: input.key,
		});
		if (!node) {
			throw new AtlasError("NOT_FOUND", "Node not found");
		}

		const normalizedCategory =
			input.userCategory === undefined
				? undefined
				: input.userCategory === null
					? null
					: input.userCategory.trim().toLowerCase() || null;

		await queries.upsertNodeOverride(this.ctx, {
			...overrideKey,
			mode: input.mode,
			key: input.key,
			userDescription: input.userDescription,
			userCategory: normalizedCategory,
			updatedByUserId: this.ctx.userId,
		});

		recordAudit({
			action: "atlas.node.edited",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_node", id: input.key, name: node.label },
			metadata: {
				analysisId: input.analysisId,
				mode: input.mode,
				changedDescription: input.userDescription !== undefined,
				changedCategory: input.userCategory !== undefined,
			},
		});

		// Return the freshly-overlaid node detail (override now applied at read).
		const updated = await queries.getNodeDetail(this.ctx, {
			analysisId: input.analysisId,
			mode: input.mode,
			key: input.key,
		});
		if (!updated) {
			throw new AtlasError("NOT_FOUND", "Node not found");
		}
		return updated;
	}

	/** Override edit history for a node (T6 `getNodeHistory`). */
	async getNodeHistory(input: {
		projectId: string;
		analysisId: string;
		mode: GraphMode;
		key: string;
	}): Promise<NodeOverrideHistoryEntry[]> {
		const overrideKey = await this.resolveOverrideKey(
			input.projectId,
			input.analysisId,
		);
		return queries.getNodeOverrideHistory(this.ctx, {
			...overrideKey,
			mode: input.mode,
			key: input.key,
		});
	}

	// ── Edge overrides (editable / manual / soft-deletable connections) ─────────

	/**
	 * Resolve the override `branch` for an edge from its SOURCE endpoint's repo.
	 * Edge overrides survive re-analysis by keying on (repo integration + branch +
	 * node key) — the branch is the source repo's currently-served analysis branch
	 * (default "main"). Returns the resolved branch + whether the edge is
	 * cross-repo (source repo ≠ target repo).
	 */
	private async resolveEdgeBranch(
		projectId: string,
		source: EdgeEndpoint,
		target: EdgeEndpoint,
	): Promise<{ branch: string; isCrossRepo: boolean }> {
		const repo = await this.resolveRepoOption(
			projectId,
			source.repositoryIntegrationId,
		);
		const analysis = await this.resolveAnalysis(projectId, repo);
		const branch = analysis?.branch ?? repo?.defaultBranch ?? "main";
		return {
			branch,
			isCrossRepo:
				source.repositoryIntegrationId !==
				target.repositoryIntegrationId,
		};
	}

	/** The effective return shape for an edge mutation (the override row's state). */
	private toEffectiveEdge(row: {
		id: string;
		userDescription: string | null;
		isManual: boolean;
		deletedAt: Date | null;
		kind: string;
	}): EffectiveEdgeOverride {
		return {
			id: row.id,
			userDescription: row.userDescription,
			isManual: row.isManual,
			deletedAt: row.deletedAt?.toISOString() ?? null,
			kind: row.kind,
		};
	}

	/**
	 * Edit an edge's stable user description override (solo OR cross-repo). Upserts
	 * the override (keyed by endpoints so it survives re-analysis), audits, and
	 * returns the effective override.
	 */
	async updateEdge(input: {
		projectId: string;
		mode: GraphMode;
		source: EdgeEndpoint;
		target: EdgeEndpoint;
		kind?: string;
		userDescription?: string | null;
		/** true = the user explicitly RE-TYPED the connection (the kind selector),
		 * so the read overlay should apply `kind` over the detected one. */
		isUserKind?: boolean;
	}): Promise<EffectiveEdgeOverride> {
		const { branch, isCrossRepo } = await this.resolveEdgeBranch(
			input.projectId,
			input.source,
			input.target,
		);
		const row = await queries.upsertEdgeOverride(this.ctx, {
			projectId: input.projectId,
			branch,
			mode: input.mode,
			source: {
				repositoryIntegrationId: input.source.repositoryIntegrationId,
				key: input.source.key,
			},
			target: {
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				key: input.target.key,
			},
			kind: input.kind,
			userDescription: input.userDescription,
			isCrossRepo,
			// A user edit takes ownership of the reference: a later "keep my edits"
			// re-map must preserve this description instead of regenerating it.
			isAiGenerated: false,
			...(input.isUserKind !== undefined
				? { isUserKind: input.isUserKind }
				: {}),
			updatedByUserId: this.ctx.userId,
		});
		recordAudit({
			action: "atlas.edge.edited",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_edge", id: row.id },
			metadata: {
				mode: input.mode,
				crossRepo: isCrossRepo,
				changedDescription: input.userDescription !== undefined,
			},
		});
		return this.toEffectiveEdge(row);
	}

	/**
	 * Create a MANUAL edge (user-drawn, no underlying AI/structural edge). If a
	 * soft-deleted override already exists for these endpoints it is RESTORED
	 * (deletedAt cleared, prior description kept unless a new one is supplied);
	 * otherwise a fresh manual override is created. Cross-repo is derived from the
	 * endpoints.
	 */
	async createEdge(input: {
		projectId: string;
		mode: GraphMode;
		source: EdgeEndpoint;
		target: EdgeEndpoint;
		kind?: string;
		userDescription?: string | null;
	}): Promise<EffectiveEdgeOverride> {
		const { branch, isCrossRepo } = await this.resolveEdgeBranch(
			input.projectId,
			input.source,
			input.target,
		);
		const endpoints = {
			projectId: input.projectId,
			branch,
			mode: input.mode,
			source: {
				repositoryIntegrationId: input.source.repositoryIntegrationId,
				key: input.source.key,
			},
			target: {
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				key: input.target.key,
			},
		};

		const existing = await queries.findEdgeOverride(this.ctx, endpoints);
		// Re-creating a previously-deleted edge restores it (keeps the audit trail
		// rather than orphaning a deleted row + creating a duplicate).
		if (existing?.deletedAt) {
			const restored = await queries.restoreEdgeOverride(
				this.ctx,
				existing.id,
				this.ctx.userId,
			);
			// A new description supplied on re-create updates it (records a
			// `description` history row only when it actually changed).
			let effective = restored;
			if (
				input.userDescription !== undefined &&
				(restored.userDescription ?? null) !==
					(input.userDescription ?? null)
			) {
				effective = await queries.upsertEdgeOverride(this.ctx, {
					...endpoints,
					userDescription: input.userDescription,
					updatedByUserId: this.ctx.userId,
				});
			}
			recordAudit({
				action: "atlas.edge.created",
				actor: { type: "user", userId: this.ctx.userId },
				organizationId: this.ctx.organizationId ?? null,
				projectId: input.projectId,
				resource: { type: "atlas_edge", id: effective.id },
				metadata: {
					mode: input.mode,
					crossRepo: isCrossRepo,
					restored: true,
				},
			});
			return this.toEffectiveEdge(effective);
		}

		const row = await queries.upsertEdgeOverride(this.ctx, {
			...endpoints,
			kind: input.kind ?? "RELATES_TO",
			userDescription: input.userDescription,
			isManual: true,
			isCrossRepo,
			updatedByUserId: this.ctx.userId,
		});
		recordAudit({
			action: "atlas.edge.created",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_edge", id: row.id },
			metadata: {
				mode: input.mode,
				crossRepo: isCrossRepo,
				restored: false,
			},
		});
		return this.toEffectiveEdge(row);
	}

	/**
	 * Soft-delete an edge. For an AI/structural edge with no override yet, a
	 * tracking override is created first (isManual=false, no description) so the
	 * deletion is recorded; then `deletedAt` is set. Idempotent for an
	 * already-deleted edge.
	 */
	async deleteEdge(input: {
		projectId: string;
		mode: GraphMode;
		source: EdgeEndpoint;
		target: EdgeEndpoint;
	}): Promise<EffectiveEdgeOverride> {
		const { branch, isCrossRepo } = await this.resolveEdgeBranch(
			input.projectId,
			input.source,
			input.target,
		);
		const endpoints = {
			projectId: input.projectId,
			branch,
			mode: input.mode,
			source: {
				repositoryIntegrationId: input.source.repositoryIntegrationId,
				key: input.source.key,
			},
			target: {
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				key: input.target.key,
			},
		};

		let existing = await queries.findEdgeOverride(this.ctx, endpoints);
		// Deleting an AI/structural edge that has no override yet: create a
		// non-manual tracking override so the soft-delete + history are recorded.
		if (!existing) {
			existing = await queries.upsertEdgeOverride(this.ctx, {
				...endpoints,
				isManual: false,
				isCrossRepo,
				updatedByUserId: this.ctx.userId,
			});
		}
		const row = existing.deletedAt
			? existing
			: await queries.softDeleteEdgeOverride(
					this.ctx,
					existing.id,
					this.ctx.userId,
				);
		recordAudit({
			action: "atlas.edge.deleted",
			severity: "warning",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_edge", id: row.id },
			metadata: { mode: input.mode, crossRepo: isCrossRepo },
		});
		return this.toEffectiveEdge(row);
	}

	/** Restore a soft-deleted edge (clear deletedAt + history). NOT_FOUND if absent. */
	async restoreEdge(input: {
		projectId: string;
		mode: GraphMode;
		source: EdgeEndpoint;
		target: EdgeEndpoint;
	}): Promise<EffectiveEdgeOverride> {
		const { branch, isCrossRepo } = await this.resolveEdgeBranch(
			input.projectId,
			input.source,
			input.target,
		);
		const existing = await queries.findEdgeOverride(this.ctx, {
			projectId: input.projectId,
			branch,
			mode: input.mode,
			source: {
				repositoryIntegrationId: input.source.repositoryIntegrationId,
				key: input.source.key,
			},
			target: {
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				key: input.target.key,
			},
		});
		if (!existing) {
			throw new AtlasError(
				"NOT_FOUND",
				"No override exists for this edge.",
			);
		}
		const row = existing.deletedAt
			? await queries.restoreEdgeOverride(
					this.ctx,
					existing.id,
					this.ctx.userId,
				)
			: existing;
		recordAudit({
			action: "atlas.edge.restored",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_edge", id: row.id },
			metadata: { mode: input.mode, crossRepo: isCrossRepo },
		});
		return this.toEffectiveEdge(row);
	}

	/** Edit history for an edge override (newest-first). Empty when none exists. */
	async getEdgeHistory(input: {
		projectId: string;
		mode: GraphMode;
		source: EdgeEndpoint;
		target: EdgeEndpoint;
	}): Promise<EdgeOverrideHistoryEntry[]> {
		const { branch } = await this.resolveEdgeBranch(
			input.projectId,
			input.source,
			input.target,
		);
		const existing = await queries.findEdgeOverride(this.ctx, {
			projectId: input.projectId,
			branch,
			mode: input.mode,
			source: {
				repositoryIntegrationId: input.source.repositoryIntegrationId,
				key: input.source.key,
			},
			target: {
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				key: input.target.key,
			},
		});
		if (!existing) {
			return [];
		}
		return queries.getEdgeOverrideHistory(this.ctx, existing.id);
	}

	/**
	 * List the connected repository's branches (T6 `listBranches`), with the
	 * default/monitored branch and any pinned branches surfaced first. Returns an
	 * empty list (never throws) when the repo is unresolved or the remote can't be
	 * reached — the FE falls back to a free-text branch entry.
	 */
	async listBranches(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
	}): Promise<RepoBranch[]> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		if (!repo || !repo.repositoryIntegrationId) {
			return [];
		}
		const creds = await queries.resolveRepoCredentials(
			input.projectId,
			repo.repositoryIntegrationId,
			{
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId,
			},
		);
		if (!creds) {
			return [];
		}
		const result = await listRepositoryBranches({
			provider: creds.provider as "GITHUB" | "GITLAB" | "AZURE_DEVOPS",
			token: creds.token,
			repositoryUrl: creds.repositoryUrl,
			owner: creds.owner,
			repo: creds.repo,
			azureOrganization: creds.azureOrganization,
			// GitLab PATs authenticate with PRIVATE-TOKEN, not Bearer — the
			// wrong header made every GitLab-PAT branch listing come back
			// empty and silently fall back to free-text entry.
			...(creds.provider === "GITLAB" && creds.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
		});
		const remote = result.ok ? result.branches : [];
		// Live HEAD SHA per remote branch — lets a caller detect a stale scan by
		// comparing against a stored checkpoint. The default/pinned branches added
		// below carry no SHA (null) unless the remote listing also returned them.
		const shaByName = new Map<string, string | null>(
			remote.map((b): [string, string | null] => [b.name, b.commitSha]),
		);
		// Always include the default + pinned branches even if the remote listing
		// missed them (e.g. truncated), de-duplicated.
		const pinned = new Set(repo.pinnedBranches);
		const seen = new Set<string>();
		const ordered: string[] = [];
		for (const name of [
			repo.defaultBranch,
			...repo.pinnedBranches,
			...remote.map((b) => b.name),
		]) {
			if (name && !seen.has(name)) {
				seen.add(name);
				ordered.push(name);
			}
		}
		return ordered.map((name) => ({
			name,
			isDefault: name === repo.defaultBranch,
			isPinned: pinned.has(name),
			commitSha: shaByName.get(name) ?? null,
		}));
	}

	/** Replace the pinned-branches set for a repo (T6 `setPinnedBranches`). */
	async setPinnedBranches(input: {
		projectId: string;
		repositoryIntegrationId: string;
		branches: string[];
	}): Promise<{ pinnedBranches: string[] }> {
		// De-dupe while preserving order.
		const unique = [...new Set(input.branches.map((b) => b.trim()))].filter(
			Boolean,
		);
		const saved = await queries.setPinnedBranches(this.ctx, {
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			branches: unique,
		});
		if (saved === null) {
			throw new AtlasError(
				"NOT_FOUND",
				"Repository integration not found for this project.",
			);
		}
		recordAudit({
			action: "atlas.branches.pinned",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: input.repositoryIntegrationId,
			},
			metadata: { pinnedBranches: saved },
		});
		return { pinnedBranches: saved };
	}

	async requestAnalysis(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		/** "From fresh" (B5) — re-derive without applying user overrides. */
		fresh?: boolean;
	}): Promise<StartAnalysisPlan> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		if (!repo || !repo.repositoryIntegrationId) {
			throw new AtlasError(
				"NO_REPOSITORY",
				"Connect a repository in Settings before analysing.",
			);
		}
		// Self-heal a lapsed GitHub OAuth credential before gating on status:
		// user-initiated, so the cooldown is bypassed (`force`). On success the
		// analysis proceeds with no observable difference; on failure (or for
		// providers without a refresh path) the reauth error below is unchanged.
		// A No-access row is skipped deliberately: its credential may be alive
		// (the failure was app-not-installed), so refreshing could resurrect it
		// to ACTIVE while every read of the repo still fails.
		const repoUnavailable = repo.status === "REPO_UNAVAILABLE";
		let repositoryStatus = repo.status;
		if (
			!repoUnavailable &&
			repo.provider === "GITHUB" &&
			repo.authMethod === "OAUTH"
		) {
			const refreshed = await ensureFreshRepoCredentials({
				integrationId: repo.repositoryIntegrationId,
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId,
				force: true,
			});
			repositoryStatus = refreshed.status;
		}
		if (repoUnavailable) {
			throw new AtlasError(
				"REPOSITORY_UNAVAILABLE",
				"The connected credentials can't read this repository. Install the provider app on it, or connect it with a personal access token in Settings.",
			);
		}
		if (repositoryStatus !== "ACTIVE") {
			throw new AtlasError(
				"REPOSITORY_REAUTH_REQUIRED",
				"Repository credentials have expired. Re-authenticate the repository in Settings before re-analysing.",
			);
		}

		// One run at a time PER REPOSITORY, regardless of branch: per-branch
		// rows mean a sibling branch row could be mid-run — check the whole
		// integration, not just the row about to start.
		const inFlight = await queries.findInFlightAnalysisForIntegration(
			this.ctx,
			input.projectId,
			repo.repositoryIntegrationId,
		);
		if (inFlight) {
			throw new AtlasError(
				"CONFLICT",
				"An analysis is already running for this repository.",
			);
		}

		// Per-branch row for the monitored branch: switching back to a
		// previously analysed branch reuses its row (and re-analyses
		// INCREMENTALLY off its own SHA); a never-analysed branch gets a fresh
		// row and a full run. Cross-branch SHA mixups are impossible by
		// construction — each row's `analyzedCommitSha` belongs to its branch.
		const analysis = await queries.getOrCreateAnalysis(this.ctx, {
			projectId: input.projectId,
			repositoryIntegrationId: repo.repositoryIntegrationId,
			provider: repo.provider,
			repositoryUrl: repo.repositoryUrl,
			repositoryName: repo.repositoryName,
			branch: repo.defaultBranch,
		});

		const fresh = Boolean(input.fresh);
		// "From fresh" (B5) forces a FULL re-analysis: re-clone, re-parse and
		// re-describe EVERY module (not just the incremental diff) so the AI
		// re-derives all descriptions + categories from scratch, ignoring the
		// user's manual overrides. A normal re-analyse stays incremental off the
		// prior commit. Without this, "from fresh" on an unchanged repo would
		// have nothing in its changed-module diff and skip the AI entirely.
		const incremental = fresh ? false : Boolean(analysis.analyzedCommitSha);
		const workflowId = `atlas-${analysis.id}`;
		// Non-blocking re-analysis (R2): when re-running an already-READY snapshot,
		// keep the served status at READY (the live graph stays visible) and track
		// the new run via the background-run markers. A first-ever analysis flips
		// the served status to PENDING (initial build spinner).
		const wasReady = analysis.status === "READY";
		await queries.beginAnalysisRun(analysis.id, {
			workflowId,
			keepServedStatus: wasReady,
			// "From fresh" forgets the prior manifest → the structure activity
			// re-describes every module (full re-derive of descriptions +
			// categories), not just an empty incremental diff.
			clearManifest: fresh,
		});

		// Open a RUNNING history row attributed to the triggering user. The
		// workflow's `finalize` closes out the latest RUNNING run for this
		// analysis (no workflow-arg change needed).
		await queries.createAnalysisRun(this.ctx, {
			analysisId: analysis.id,
			projectId: input.projectId,
			mode: incremental ? "incremental" : "full",
			branch: analysis.branch ?? repo.defaultBranch,
		});

		// Audit: user-initiated (re-)analysis.
		recordAudit({
			action: "atlas.analysis.requested",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_analysis", id: analysis.id },
			metadata: {
				mode: incremental ? "incremental" : "full",
				repositoryIntegrationId: repo.repositoryIntegrationId,
				fresh,
			},
		});

		return {
			analysisId: analysis.id,
			workflowId,
			taskQueue: ATLAS_TASK_QUEUE,
			workflowName: ATLAS_WORKFLOW,
			workflowArgs: {
				analysisId: analysis.id,
				projectId: input.projectId,
				repositoryIntegrationId: repo.repositoryIntegrationId,
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId,
				incremental,
				fresh,
			},
			status: await this.getStatus(input),
		};
	}

	/**
	 * Cancel the in-flight analysis for a project's (optionally specific) repo.
	 *
	 * Robust by design — the Temporal worker may be down, the workflow may be
	 * already closed, or the row may have raced to a terminal state:
	 *  1. Resolve the current PENDING/ANALYZING analysis (exact repo, else the
	 *     most-recent in-flight one). No in-flight row → return current status,
	 *     idempotent no-op.
	 *  2. Best-effort cancel the Temporal workflow via the injected
	 *     `cancelWorkflow` callback (the procedure owns the Temporal client to
	 *     avoid a `@repo/temporal` → `@repo/atlas` → `@repo/temporal`
	 *     dependency cycle). Errors are logged and swallowed.
	 *  3. ALWAYS idempotently finalize the row to FAILED with "Cancelled by
	 *     user" IF still in flight (re-checked just before the write to avoid
	 *     clobbering a row that finished in the meantime), reusing the existing
	 *     FAILED finalize path — no new enum value / migration. The workflow's
	 *     own cancel-catch may also finalize, which is idempotent.
	 *  4. Emit `atlas.analysis.cancelled` and return the refreshed status.
	 */
	async cancelAnalysis(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		cancelWorkflow?: (workflowId: string) => Promise<void>;
	}): Promise<AtlasStatus> {
		const analysis = await queries.findInFlightAnalysis(
			this.ctx,
			input.projectId,
			input.repositoryIntegrationId ?? null,
		);

		// Nothing in flight (never started, already finished, or already
		// cancelled) — idempotent no-op, just report the current status.
		if (!analysis) {
			return this.getStatus(input);
		}

		const workflowId = analysis.workflowId ?? `atlas-${analysis.id}`;

		// (2) Best-effort Temporal cancel. The worker may be unavailable or the
		// workflow already closed/not-found — never let that block the DB
		// finalize below (the row is the source of truth for the UI).
		if (input.cancelWorkflow) {
			try {
				await input.cancelWorkflow(workflowId);
			} catch (error) {
				logger.warn("[atlas] best-effort workflow cancel failed", {
					analysisId: analysis.id,
					workflowId,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		// (3) Idempotently finalize the row FAILED. Re-read the live status so a
		// run that completed between the lookup and here is left untouched. This
		// reuses the FAILED finalize columns directly (rather than the
		// `finalize` method) so the audit reads as `atlas.analysis.cancelled`,
		// not the workflow's generic `atlas.analysis.failed` — but still closes
		// out the open run-history row the same way.
		const cancelMessage = "Cancelled by user";
		const fresh = await queries.findAnalysisById(this.ctx, analysis.id);
		if (
			fresh &&
			(fresh.status === "ANALYZING" || fresh.status === "PENDING")
		) {
			await queries.finalizeAnalysis(analysis.id, {
				status: "FAILED",
				error: cancelMessage,
			});
			// Close out the matching RUNNING history row. Best-effort: history
			// is observability, never block the cancel on it.
			await queries
				.completeLatestRun(this.ctx, {
					analysisId: analysis.id,
					status: "FAILED",
					error: cancelMessage,
				})
				.catch((error) => {
					logger.warn(
						"[atlas] failed to complete cancelled run history",
						{
							analysisId: analysis.id,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				});
		}

		// (4) Audit: user-initiated cancel (distinct from the workflow-emitted
		// `atlas.analysis.failed`).
		recordAudit({
			action: "atlas.analysis.cancelled",
			severity: "warning",
			outcome: "success",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			projectId: input.projectId,
			resource: { type: "atlas_analysis", id: analysis.id },
			metadata: {
				repositoryIntegrationId: analysis.repositoryIntegrationId,
				workflowId,
			},
		});

		return this.getStatus(input);
	}

	// ── Persistent chat conversations (shared & private) ───────────────────────

	/**
	 * Conversations the caller may see (own + SHARED) for a project's repo.
	 * There is ONE shared history across both graph views — the list is never
	 * scoped by graph mode, so legacy Business and Technical sessions all
	 * stay visible.
	 */
	async listConversations(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		limit?: number;
		offset?: number;
		/** true = System-map (multi-repo) conversation history; else per-repo. */
		isSystemScope?: boolean;
	}): Promise<{ conversations: ConversationSummary[]; total: number }> {
		const [conversations, total] = await Promise.all([
			queries.listConversations(this.ctx, {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				limit: input.limit,
				offset: input.offset,
				isSystemScope: input.isSystemScope,
			}),
			queries.countConversations(this.ctx, {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				isSystemScope: input.isSystemScope,
			}),
		]);
		return { conversations, total };
	}

	/**
	 * Full conversation incl. messages (owner OR SHARED, else NOT_FOUND).
	 * Bound to the permission-checked project: a conversation id from another
	 * project resolves NOT_FOUND even within the same tenant.
	 */
	async getConversation(input: {
		conversationId: string;
		projectId: string;
	}): Promise<ConversationDetail> {
		const conversation = await queries.getConversation(this.ctx, {
			conversationId: input.conversationId,
			projectId: input.projectId,
		});
		if (!conversation) {
			throw new AtlasError("NOT_FOUND", "Conversation not found.");
		}
		return conversation;
	}

	/** Create an empty conversation (mode-independent — stored as TECHNICAL). */
	createConversation(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		title?: string;
		visibility?: ChatVisibility;
		isSystemScope?: boolean;
	}): Promise<ConversationDetail> {
		return queries.createConversation(this.ctx, {
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			title: input.title,
			visibility: input.visibility,
			isSystemScope: input.isSystemScope,
		});
	}

	/** Rename / re-scope a conversation. Owner only (else NOT_FOUND). */
	async updateConversation(input: {
		conversationId: string;
		projectId: string;
		title?: string;
		visibility?: ChatVisibility;
	}): Promise<ConversationDetail> {
		const ok = await queries.updateConversation(this.ctx, {
			conversationId: input.conversationId,
			title: input.title,
			visibility: input.visibility,
		});
		if (!ok) {
			throw new AtlasError(
				"NOT_FOUND",
				"Conversation not found or not owned by you.",
			);
		}
		return this.getConversation({
			conversationId: input.conversationId,
			projectId: input.projectId,
		});
	}

	/** Delete a conversation. Owner only (else NOT_FOUND). */
	async deleteConversation(input: {
		conversationId: string;
	}): Promise<{ deleted: true }> {
		const ok = await queries.deleteConversation(
			this.ctx,
			input.conversationId,
		);
		if (!ok) {
			throw new AtlasError(
				"NOT_FOUND",
				"Conversation not found or not owned by you.",
			);
		}
		return { deleted: true };
	}

	/**
	 * Graph-grounded chat that PERSISTS to a conversation — loss-proof by
	 * construction:
	 *
	 *  1. The USER turn (with first-turn title derivation) is written BEFORE
	 *     the stream starts, so an interruption can never lose the user's
	 *     words. A failed pre-stream write aborts the send with
	 *     `PERSISTENCE_FAILED` (no stream, no AI spend).
	 *  2. The ASSISTANT turn is persisted exactly once via a one-shot guard
	 *     shared by `onFinish` (complete reply), `onAbort`/`onError`, and the
	 *     returned stream's early-exit cleanup — a client disconnect surfaces
	 *     as consumer cancellation, which the SDK does NOT route through
	 *     `onAbort`, so the wrapper salvages the accumulated partial text
	 *     itself, flagged `interrupted`. Empty partials are skipped (no empty
	 *     assistant bubbles).
	 *  3. AI usage is recorded whenever the SDK reports a finish event —
	 *     including after a stream error (tokens were consumed); abort and
	 *     disconnect paths record none.
	 *
	 * Returns `{ textStream, persistOutcome }`. Consume `textStream` (NOT the
	 * raw SDK stream — the wrapper feeds the salvage buffer); `persistOutcome`
	 * resolves `{ persisted, interrupted }` once the assistant write settles:
	 * `persisted: false` ⇒ the turn could not be saved (procedure emits the
	 * "turn not saved" sentinel); `interrupted: true` ⇒ an abort/error/salvage
	 * path won (procedure emits the "interrupted" sentinel so the LIVE client
	 * can mark the reply — the SDK closes the text stream normally on provider
	 * errors, so the stream itself carries no signal). A skipped-empty partial
	 * counts as persisted — nothing to save is not a failure.
	 */
	async chat(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		mode: GraphMode;
		focusNodeKey?: string;
		conversationId?: string;
		messages: { role: "user" | "assistant" | "system"; content: string }[];
	}) {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		// Same per-branch resolution as the graph views: chat grounds on the
		// analysis the user is LOOKING AT (exact branch row, else the
		// integration's latest, else adopted/project fallback).
		const analysis = await this.resolveAnalysis(input.projectId, repo);
		if (!analysis || analysis.status !== "READY") {
			throw new AtlasError(
				"NOT_FOUND",
				"This repository has not been analysed yet.",
			);
		}

		// Resolve (or create) the conversation this exchange belongs to. There
		// is one shared history across both graph views; `input.mode` only
		// steers prompt emphasis below, never conversation scoping. A
		// self-created conversation is scoped to the RAW input repo selector
		// (not the resolved fallback id) so it shows up under the exact same
		// `repositoryIntegrationId` the history list queries with.
		const conversation = input.conversationId
			? await this.getConversation({
					conversationId: input.conversationId,
					projectId: input.projectId,
				})
			: await this.createConversation({
					projectId: input.projectId,
					repositoryIntegrationId:
						input.repositoryIntegrationId ?? null,
				});

		// The new user turn is the last user message the client sent.
		const newUserMessage = [...input.messages]
			.reverse()
			.find((m) => m.role === "user");

		// Prior turns come from the persisted conversation (the source of
		// truth), snapshotted BEFORE the pre-stream append below so the model
		// input cannot double-include the new turn.
		const priorMessages: StoredChatMessage[] = conversation.messages.filter(
			(m) => m.role !== "system",
		);
		const conversationForModel = [
			...priorMessages.map((m) => ({ role: m.role, content: m.content })),
			...(newUserMessage
				? [{ role: "user" as const, content: newUserMessage.content }]
				: []),
		];

		// In a multi-repo project, also ground on the cross-repo references that
		// touch THIS repository, so a solo-chat answer can reach into a sibling
		// repo when a question spans them. No-op for a single-repo project.
		const { crossRefs, repoNameByAnalysisId } =
			await this.resolveSoloCrossRefs(
				input.projectId,
				input.mode,
				analysis.id,
			);

		const system = await buildSystemPrompt(this.ctx, {
			analysisId: analysis.id,
			mode: input.mode,
			focusNodeKey: input.focusNodeKey,
			repositoryName: analysis.repositoryName,
			projectName: null,
			crossRefs,
			repoNameByAnalysisId,
			thisAnalysisId: analysis.id,
		});

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId ?? undefined,
			},
		);
		const usageStartedAt = Date.now();

		const conversationId = conversation.id;
		const titleIsDefault =
			conversation.messages.length === 0 &&
			(conversation.title === DEFAULT_CONVERSATION_TITLE ||
				!conversation.title);

		// Persist the user turn NOW — before any token streams — so a
		// mid-answer abort/disconnect can never lose the question. The title is
		// derived here too, so the conversation is findable in the history list
		// even if the very first answer is interrupted.
		if (newUserMessage) {
			const title = titleIsDefault
				? deriveConversationTitle(newUserMessage.content)
				: undefined;
			let updatedRows = 0;
			let userAppendError: unknown = null;
			try {
				updatedRows = await queries.appendMessages(
					conversationId,
					[
						{
							role: "user",
							content: newUserMessage.content,
							createdAt: new Date().toISOString(),
						},
					],
					title,
				);
			} catch (error) {
				userAppendError = error;
			}
			if (userAppendError != null || updatedRows === 0) {
				logger.warn("[atlas] failed to persist chat turn", {
					conversationId,
					error:
						userAppendError instanceof Error
							? userAppendError.message
							: String(
									userAppendError ??
										"conversation row missing",
								),
				});
				throw new AtlasError(
					"PERSISTENCE_FAILED",
					"Your message couldn't be saved. Please try sending it again.",
				);
			}
		}

		// One-shot assistant persistence shared by every completion path.
		// Whoever fires first (finish, abort, error, consumer cancel) wins; the
		// guard makes the rest no-ops, so the assistant turn lands exactly once.
		// The resolved outcome also carries WHICH kind of path won: the SDK
		// converts provider errors into error parts and closes the text stream
		// NORMALLY (it never throws to the consumer), so `interrupted` is the
		// procedure's only signal to tell the live client its reply was cut off
		// — including the error-before-first-token case where there is nothing
		// to persist at all.
		let assistantPersisted = false;
		let accumulatedText = "";
		let resolvePersistOutcome!: (outcome: {
			persisted: boolean;
			interrupted: boolean;
		}) => void;
		const persistOutcome = new Promise<{
			persisted: boolean;
			interrupted: boolean;
		}>((resolve) => {
			resolvePersistOutcome = resolve;
		});
		const persistAssistant = async (
			text: string,
			interrupted: boolean,
		): Promise<void> => {
			if (assistantPersisted) {
				return;
			}
			assistantPersisted = true;
			// Empty partial (interrupted before the first token): the user turn
			// is already saved; never write an empty assistant bubble. Still an
			// interruption from the client's point of view.
			if (text.trim() === "") {
				resolvePersistOutcome({ persisted: true, interrupted });
				return;
			}
			try {
				// A missing conversation row (deleted mid-stream) returns 0 rows
				// — kept as the historical silent-return for this post-stream
				// path (nothing to signal; the thread itself is gone).
				await queries.appendMessages(conversationId, [
					{
						role: "assistant",
						content: text,
						createdAt: new Date().toISOString(),
						...(interrupted ? { interrupted: true as const } : {}),
					},
				]);
				resolvePersistOutcome({ persisted: true, interrupted });
			} catch (error) {
				logger.warn("[atlas] failed to persist chat turn", {
					conversationId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				resolvePersistOutcome({ persisted: false, interrupted });
			}
		};

		const result = streamText({
			model,
			system,
			messages: conversationForModel.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
			onFinish: async ({ text, usage }) => {
				// Record usage whenever the SDK reports it — onFinish also fires
				// after onError with the tokens that were actually consumed, so
				// errored turns meter their real spend (the one-shot guard keeps
				// the earlier interrupted persist authoritative). Only abort /
				// disconnect paths, where the SDK never reaches finish, record
				// nothing.
				recordAtlasUsage({
					ctx: this.ctx,
					metadata,
					taskType: "CHAT",
					usage,
					startedAt: usageStartedAt,
					projectId: input.projectId,
				});
				trackUsage();
				await persistAssistant(text, false);
			},
			onAbort: async () => {
				await persistAssistant(accumulatedText, true);
			},
			onError: async () => {
				await persistAssistant(accumulatedText, true);
			},
		});

		// Wrap the SDK stream: accumulate deltas server-side for the salvage
		// paths, and treat an early consumer exit (client disconnect →
		// iterator.return(), which the SDK does NOT surface as onAbort) as an
		// interruption of its own.
		const textStream = (async function* () {
			let completed = false;
			try {
				for await (const delta of result.textStream) {
					accumulatedText += delta;
					yield delta;
				}
				completed = true;
			} finally {
				if (!completed) {
					await persistAssistant(accumulatedText, true);
				}
			}
		})();

		return { textStream, persistOutcome };
	}

	// ── Shared node positions (draggable layout) ───────────────────────────────

	/**
	 * Persist dragged node positions (collaborative — stored on the node row so
	 * every project member sees the same arrangement). Resolves the analysis
	 * from the repo selector, then delegates to the layout query.
	 */
	async saveLayout(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		mode: GraphMode;
		positions: NodeLayoutPosition[];
	}): Promise<{ updated: number }> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		// Positions belong to the DISPLAYED graph — resolve the same per-branch
		// analysis the graph views render.
		const analysis = await this.resolveAnalysis(input.projectId, repo);
		if (!analysis) {
			throw new AtlasError(
				"NOT_FOUND",
				"This repository has not been analysed yet.",
			);
		}
		return queries.saveNodeLayout(
			this.ctx,
			analysis.id,
			input.mode,
			input.positions,
		);
	}

	/**
	 * Persist dragged System-map node positions (multi-repo canvas). Shared per
	 * (project, mode) — last-write-wins, like `saveLayout`. The node ids are the
	 * System-map RF ids (`repo::${analysisId}` groups, `${analysisId}::${key}`
	 * cards), so they are stored in their own table rather than on a node row.
	 */
	async saveSystemLayout(input: {
		projectId: string;
		mode: GraphMode;
		positions: SystemLayoutPosition[];
	}): Promise<{ updated: number }> {
		return queries.saveSystemNodeLayout(
			this.ctx,
			input.projectId,
			input.mode,
			input.positions,
		);
	}

	// ── Producer methods (Temporal activities) ─────────────────────────────────

	async markStatus(input: {
		analysisId: string;
		status: "ANALYZING" | "READY" | "FAILED";
		error?: string | null;
	}): Promise<void> {
		// R2-aware transitions: ANALYZING advances the background-run marker while
		// keeping a served READY snapshot visible; FAILED clears the run without
		// blanking a previously-good snapshot. READY is handled by `finalize`.
		if (input.status === "ANALYZING") {
			await queries.markAnalysisAnalyzing(input.analysisId);
			return;
		}
		if (input.status === "FAILED") {
			await queries.failAnalysisRun(
				input.analysisId,
				humanizeAnalysisError(input.error),
			);
			return;
		}
		await queries.setAnalysisStatus(input.analysisId, input.status, {
			error: input.error ?? null,
		});
	}

	async runStructureAnalysis(input: {
		analysisId: string;
		projectId: string;
		repositoryIntegrationId: string;
		heartbeat?: () => void;
		/**
		 * Temporal activity cancellation signal (best-effort). When it fires —
		 * a user clicked "Cancel analysis" — the git clone subprocess is aborted
		 * and the pipeline bails between major steps so the (large) clone/parse
		 * stops promptly instead of running to the activity's 90-minute cap. The
		 * `finally` below still cleans up the clone directory on every exit.
		 */
		abortSignal?: AbortSignal;
		/**
		 * The Temporal activity attempt (`Context.current().info.attempt`), threaded
		 * in so each attempt clones into its OWN uniquely-named directory — a retry
		 * never shares (and so never deletes) a prior attempt's clone dir. Undefined
		 * outside an activity (e.g. unit tests).
		 */
		activityAttempt?: number;
	}): Promise<{
		commitSha: string;
		commitAt: string | null;
		manifest: FileManifest;
		changedModuleKeys: string[];
		nodeCount: number;
		edgeCount: number;
		filesAnalyzed: number;
	}> {
		const resolvedCreds = await queries.resolveRepoCredentials(
			input.projectId,
			input.repositoryIntegrationId,
			{
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId,
			},
		);
		if (!resolvedCreds) {
			throw new AtlasError(
				"NO_REPOSITORY",
				"Repository credentials could not be resolved.",
			);
		}

		// The run belongs to ONE per-branch analysis row — load it by id (a
		// (project, integration) lookup is ambiguous across branch rows) and
		// clone ITS branch, never the live `defaultBranch`: an in-flight run is
		// then immune to concurrent monitored-branch edits, and every branch
		// row always clones (and diffs its manifest against) its own branch.
		const analysis = await queries.findAnalysisById(
			this.ctx,
			input.analysisId,
		);
		const prior = (analysis?.fileManifest as FileManifest | null) ?? null;
		const creds = analysis?.branch
			? { ...resolvedCreds, branch: analysis.branch }
			: resolvedCreds;

		// Acquire the repo into a FRESH, per-attempt working directory with a
		// bounded in-activity retry (see `acquireRepoForAnalysis`). The returned
		// directory belongs to the winning attempt alone, so the `finally` cleanup
		// below can never delete a directory another (retried/concurrent) attempt's
		// git is running in — the race that surfaced as
		// `fatal: Unable to read current working directory: No such file or directory`.
		const { clonePath, commitSha, commitAt } =
			await this.acquireRepoForAnalysis({
				creds,
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				analysisId: input.analysisId,
				activityAttempt: input.activityAttempt,
				abortSignal: input.abortSignal,
				heartbeat: input.heartbeat,
			});
		try {
			input.heartbeat?.();
			this.throwIfAborted(input.abortSignal);
			const { sourcePaths, manifests, docs } =
				this.collectFiles(clonePath);
			input.heartbeat?.();
			this.throwIfAborted(input.abortSignal);
			// Stream the source: the builder reads ONE file at a time via the
			// reader below, folds its compact contribution into the graph, and
			// drops the content before the next read — so peak memory scales with
			// the graph (modules + files + previews), not with total source size.
			// The reader mirrors `collectFiles`' old per-source handling exactly
			// (bounded read + secret redaction), so the graph is byte-identical to
			// building over a fully-materialised `FileRecord[]`.
			// Resumability: reload any per-file parse metadata checkpointed by a
			// previous (disrupted) attempt at THIS commit, so the streaming parse
			// below skips re-reading + re-parsing those files. A re-clone at a
			// different commit returns an empty seed (stale rows are dropped).
			const checkpointSeed = await queries.loadParseCheckpoint(
				input.analysisId,
				commitSha,
			);
			const graph = await buildTechnicalGraphStreaming(
				sourcePaths,
				(rel) => {
					const content = this.readFileBounded(
						path.join(clonePath, rel),
						MAX_ANALYZED_FILE_BYTES,
					);
					return content === null
						? null
						: redactSecrets(content).redacted;
				},
				{
					checkpoint: {
						seed: checkpointSeed,
						// Persist each freshly-parsed batch durably (+ heartbeat) so a
						// mid-parse worker death only costs the in-flight batch — the
						// retry resumes from here instead of re-parsing the whole repo.
						onExtracted: async (batch) => {
							await queries.appendParseCheckpoint(this.ctx, {
								analysisId: input.analysisId,
								projectId: input.projectId,
								commitSha,
								files: batch,
							});
							input.heartbeat?.();
						},
					},
				},
			);
			// The streaming builder already produced the current manifest while
			// reading, so diff against it without re-reading/re-hashing any file.
			const diff = diffManifests(prior, graph.manifest);
			const filesAnalyzed = Object.keys(graph.manifest).length;

			const changed = new Set<string>();
			const fileNodeByKey = new Map(
				graph.nodes
					.filter((n) => n.kind === "FILE")
					.map((n) => [n.key, n.parentKey] as const),
			);
			for (const p of [...diff.added, ...diff.changed]) {
				const moduleKey = fileNodeByKey.get(normalizePath(p));
				if (moduleKey) {
					changed.add(moduleKey);
				}
			}
			for (const p of diff.deleted) {
				changed.add(
					moduleKeyAtDepth(normalizePath(p), graph.moduleDepth),
				);
			}
			// First run (no prior) → describe everything.
			if (!prior) {
				for (const n of graph.nodes) {
					if (n.kind === "MODULE") {
						changed.add(n.key);
					}
				}
			}

			// Last bail-out before the (expensive) graph write — if the user
			// cancelled during the parse/build, stop here so we don't half-write
			// a graph that's about to be finalized FAILED anyway.
			this.throwIfAborted(input.abortSignal);
			const docsByModule = this.mapDocsToModules(docs, graph.moduleDepth);
			await queries.persistTechnicalGraph(this.ctx, {
				analysisId: input.analysisId,
				projectId: input.projectId,
				graph,
				changedModuleKeys: changed,
				docsByModule,
			});
			// The graph is durably persisted — the parse checkpoint has served its
			// purpose, so drop it. (A retry that died before this point keeps its
			// checkpoint and resumes; a terminal failure clears it in `finalize`.)
			await queries.clearParseCheckpoint(input.analysisId);
			// Tech stack (frameworks/libraries + versions) from dependency
			// manifests, plus the repo's own published-package identities (drives
			// the precise cross-repo DEPENDS_ON in the System map).
			await queries.updateAnalysisTechStack(
				input.analysisId,
				parseTechStack(manifests),
				parsePublishedPackages(manifests),
			);
			// No-gaps guarantee: also (re)describe any module still missing a
			// description — e.g. a structure-only seed, or a module whose stale
			// description was cleared on persist — even if its files didn't change
			// this run. Already-described, unchanged modules are left untouched.
			for (const key of await queries.getUndescribedModuleKeys(
				input.analysisId,
			)) {
				changed.add(key);
			}
			input.heartbeat?.();

			return {
				commitSha,
				commitAt: commitAt ? commitAt.toISOString() : null,
				manifest: graph.manifest,
				changedModuleKeys: [...changed],
				nodeCount: graph.nodes.length,
				edgeCount: graph.edges.length,
				filesAnalyzed,
			};
		} finally {
			this.cleanupDir(clonePath);
		}
	}

	async describeChangedModules(input: {
		analysisId: string;
		projectId?: string;
		changedModuleKeys: string[];
		/** "From fresh" (B5) — do not feed user overrides into the prompts. */
		fresh?: boolean;
		heartbeat?: () => void;
	}): Promise<{
		described: number;
		requested: number;
		usage: TokenTotals;
		model: string | null;
		reasoning: string | null;
	}> {
		const modules = await queries.getModulesForDescribe(
			input.analysisId,
			input.changedModuleKeys,
			// Resumability: only (re-)describe modules that still lack an AI summary,
			// so a retried activity (after an OOM / eviction / deploy) skips work an
			// earlier attempt already persisted instead of re-billing the LLM.
			{ onlyUndescribed: true },
		);

		// B4: feed the user's authoritative notes (TECHNICAL-mode overrides) into
		// the describe prompt as ground truth — UNLESS this is a "from fresh" run.
		const overrides = input.fresh
			? new Map()
			: await this.loadOverridesForAnalysis(
					input.analysisId,
					"TECHNICAL",
				);
		const modulesWithNotes = modules.map((m) => {
			const ov = overrides.get(m.key);
			return ov?.userDescription || ov?.userCategory
				? {
						...m,
						userNote: {
							description: ov.userDescription,
							category: ov.userCategory,
						},
					}
				: m;
		});

		const result = await describeModules(
			modulesWithNotes,
			this.ctx,
			input.projectId,
			input.heartbeat,
			// Persist each batch as it completes (resumability) — replaces the old
			// single bulk write, so partial progress survives a mid-run worker death
			// and the retry's skip-filter excludes the already-persisted modules.
			(batch) =>
				queries.updateModuleDescriptions(input.analysisId, batch),
		);
		return {
			described: result.descriptions.length,
			requested: modules.length,
			usage: result.usage,
			model: result.model,
			reasoning: result.reasoning,
		};
	}

	/**
	 * Load the user overrides for an analysis in a given mode (B4 feeding / T5
	 * overlay support). Resolves the analysis's (project, repo, branch) and reads
	 * the stable override rows keyed on those — returns an empty map when the
	 * analysis row is gone.
	 */
	private async loadOverridesForAnalysis(
		analysisId: string,
		mode: GraphMode,
	): Promise<Map<string, queries.NodeOverrideValue>> {
		const analysis = await queries.findAnalysisById(this.ctx, analysisId);
		if (!analysis) {
			return new Map();
		}
		return queries.getNodeOverrides(this.ctx, {
			projectId: analysis.projectId,
			repositoryIntegrationId: analysis.repositoryIntegrationId,
			branch: analysis.branch,
			mode,
		});
	}

	async deriveBusiness(input: {
		analysisId: string;
		projectId: string;
		incremental?: boolean;
		changedModuleKeys?: string[];
		/** "From fresh" (B5) — do not feed user overrides into the prompts. */
		fresh?: boolean;
	}): Promise<{
		capabilities: number;
		skipped?: boolean;
		usage: TokenTotals;
		model: string | null;
		reasoning: string | null;
	}> {
		// Smart-skip: on an incremental run where no module changed AND a business
		// graph already exists, the capabilities cannot have changed — skip the two
		// AI calls. Always (re)derive on a full run, whenever a module changed, or
		// when no business graph exists yet, so the business view is never stale or
		// missing.
		const changedCount = input.changedModuleKeys?.length ?? 0;
		if (input.incremental && changedCount === 0) {
			const existing = await queries.countBusinessCapabilities(
				input.analysisId,
			);
			if (existing > 0) {
				return {
					capabilities: existing,
					skipped: true,
					usage: EMPTY_TOKEN_TOTALS,
					model: null,
					reasoning: null,
				};
			}
		}

		// B4: overlay the user's authoritative module notes (TECHNICAL-mode
		// overrides) onto the summaries so capabilities derive from them — unless
		// this is a "from fresh" run.
		const summaries = await queries.getModuleSummaries(input.analysisId);
		const overrides = input.fresh
			? new Map<string, queries.NodeOverrideValue>()
			: await this.loadOverridesForAnalysis(
					input.analysisId,
					"TECHNICAL",
				);
		const summariesWithNotes = summaries.map((s) => {
			const note = overrides.get(s.key)?.userDescription ?? null;
			return note ? { ...s, userNote: note } : s;
		});

		// Resumability: fingerprint the exact inputs that determine the business
		// graph (module summaries + user notes + the "fresh" flag). If a graph
		// already exists and was stamped with this same fingerprint, a retry — or
		// a re-run whose inputs didn't materially change — skips BOTH AI calls,
		// since identical inputs produce an identical graph.
		const businessSignature = fnv1a(
			(input.fresh ? "fresh|" : "") +
				summariesWithNotes
					.map((s) => JSON.stringify(s))
					.sort()
					.join("|"),
		);
		const existingCapabilities = await queries.countBusinessCapabilities(
			input.analysisId,
		);
		if (
			existingCapabilities > 0 &&
			(await queries.getBusinessSignature(input.analysisId)) ===
				businessSignature
		) {
			return {
				capabilities: existingCapabilities,
				skipped: true,
				usage: EMPTY_TOKEN_TOTALS,
				model: null,
				reasoning: null,
			};
		}

		const business = await deriveBusinessGraph(
			summariesWithNotes,
			this.ctx,
			input.projectId,
		);
		await queries.persistBusinessGraph(this.ctx, {
			analysisId: input.analysisId,
			projectId: input.projectId,
			draft: business.draft,
			signature: businessSignature,
		});
		// Business onboarding tour for non-technical newcomers — generated from
		// the freshly-derived capabilities. Best-effort: `generateBusinessTour`
		// returns null when no AI provider is configured, which clears the column.
		const repoName = await queries.getAnalysisRepositoryName(
			input.analysisId,
		);
		const tour = await generateBusinessTour(
			business.draft.capabilities.map((c) => ({
				key: c.key,
				label: c.label,
				description: c.description,
			})),
			repoName,
			this.ctx,
			input.projectId,
		);
		await queries.updateAnalysisBusinessTour(input.analysisId, tour.tour);
		return {
			capabilities: business.draft.capabilities.length,
			usage: addTokenTotals(business.usage, tour.usage),
			model: business.model ?? tour.model,
			reasoning: concatReasoning(business.reasoning, tour.reasoning),
		};
	}

	async finalize(input: {
		analysisId: string;
		status: "READY" | "FAILED";
		commitSha?: string | null;
		commitAt?: string | null;
		manifest?: FileManifest | null;
		nodeCount?: number;
		edgeCount?: number;
		filesAnalyzed?: number;
		modulesDescribed?: number;
		incremental?: boolean;
		branch?: string | null;
		/** "From fresh" run (B5) → persisted as `appliedUserOverrides = false`. */
		fresh?: boolean;
		// AI telemetry summed by the workflow across the describe + business
		// activities (T3). The cost is derived here from the model's rates.
		model?: string | null;
		promptTokens?: number | null;
		completionTokens?: number | null;
		totalTokens?: number | null;
		reasoning?: string | null;
		error?: string | null;
	}): Promise<void> {
		// A FAILED run's error is humanized for the UI (a raw git auth failure
		// becomes the clean reconnect guidance; any embedded URL credentials are
		// stripped). READY carries no error, so this is a no-op there.
		const finalError = humanizeAnalysisError(input.error);

		// Terminal failure: drop any parse checkpoint left behind by the structure
		// activity's retries so it doesn't linger (the success path already cleared
		// it once the graph was persisted).
		if (input.status === "FAILED") {
			await queries.clearParseCheckpoint(input.analysisId);
		}

		// Cost (T3): look up the model's per-1M-token rates and convert the summed
		// token counts to micro-USD. Best-effort — an unknown model / no tokens
		// yields null, never an error.
		let costMicroUsd: number | null = null;
		if (
			input.status === "READY" &&
			input.model &&
			((input.promptTokens ?? 0) > 0 || (input.completionTokens ?? 0) > 0)
		) {
			try {
				const rates = await queries.getModelCostRates(input.model);
				if (rates) {
					costMicroUsd = computeCostMicroUsd({
						promptTokens: input.promptTokens ?? 0,
						completionTokens: input.completionTokens ?? 0,
						inputCostPer1M: rates.inputCostPer1M,
						outputCostPer1M: rates.outputCostPer1M,
					});
				}
			} catch (error) {
				logger.warn("[atlas] cost computation failed", {
					analysisId: input.analysisId,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}

		const runTelemetry = {
			model: input.model ?? null,
			promptTokens: input.promptTokens ?? null,
			completionTokens: input.completionTokens ?? null,
			totalTokens: input.totalTokens ?? null,
			costMicroUsd,
		};

		// Close the run-history row FIRST so its derived `durationMs` (now − run
		// start) can be mirrored onto the analysis telemetry. Best-effort: history
		// is observability, never block finalize on it.
		const runResult = await queries
			.completeLatestRun(this.ctx, {
				analysisId: input.analysisId,
				status: input.status,
				commitSha: input.commitSha ?? null,
				commitAt: input.commitAt ? new Date(input.commitAt) : null,
				branch: input.branch ?? null,
				nodeCount: input.nodeCount,
				edgeCount: input.edgeCount,
				filesAnalyzed: input.filesAnalyzed,
				modulesDescribed: input.modulesDescribed,
				telemetry: runTelemetry,
				error: finalError,
			})
			.catch((error) => {
				logger.warn("[atlas] failed to complete analysis run history", {
					analysisId: input.analysisId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return { durationMs: null };
			});

		// Finalize the analysis row (source of truth) — swaps served data + clears
		// the background-run markers + persists telemetry (READY), or fails the run
		// without blanking a previously-good snapshot (FAILED).
		await queries.finalizeAnalysis(input.analysisId, {
			status: input.status,
			commitSha: input.commitSha ?? null,
			commitAt: input.commitAt ? new Date(input.commitAt) : null,
			fileManifest: input.manifest ?? null,
			nodeCount: input.nodeCount,
			edgeCount: input.edgeCount,
			filesAnalyzed: input.filesAnalyzed,
			incremental: input.incremental,
			error: finalError,
			telemetry:
				input.status === "READY"
					? {
							...runTelemetry,
							durationMs: runResult.durationMs,
							reasoning: input.reasoning ?? null,
							appliedUserOverrides: !input.fresh,
						}
					: undefined,
		});

		// Audit: analysis lifecycle outcome — so a FAILED run lands in the audit
		// ledger, not just the history row.
		recordAudit({
			action:
				input.status === "READY"
					? "atlas.analysis.completed"
					: "atlas.analysis.failed",
			severity: input.status === "READY" ? "info" : "error",
			outcome: input.status === "READY" ? "success" : "failure",
			actor: { type: "user", userId: this.ctx.userId },
			organizationId: this.ctx.organizationId ?? null,
			resource: { type: "atlas_analysis", id: input.analysisId },
			metadata:
				input.status === "READY"
					? {
							nodeCount: input.nodeCount ?? null,
							edgeCount: input.edgeCount ?? null,
							modulesDescribed: input.modulesDescribed ?? null,
							incremental: input.incremental ?? null,
							model: input.model ?? null,
							totalTokens: input.totalTokens ?? null,
							costMicroUsd,
							durationMs: runResult.durationMs,
							fresh: Boolean(input.fresh),
						}
					: { error: finalError },
		});
	}

	/** Analysis history (who / when / commit) for the resolved repo's analysis. */
	async getHistory(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		limit?: number;
		offset?: number;
	}): Promise<{ runs: AnalysisRunSummary[]; total: number }> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		// History lists the runs of the DISPLAYED analysis — same per-branch
		// resolution as the graph/status views.
		const analysis = await this.resolveAnalysis(input.projectId, repo);
		if (!analysis) {
			return { runs: [], total: 0 };
		}
		const [runs, total] = await Promise.all([
			queries.getHistory(
				this.ctx,
				analysis.id,
				input.limit ?? 20,
				input.offset ?? 0,
			),
			queries.countAnalysisRuns(this.ctx, analysis.id),
		]);
		return { runs, total };
	}

	// ── Multi-repo "System map" ────────────────────────────────────────────────

	/**
	 * Resolve a set of connected repos to their READY analyses (per-branch
	 * resolution, same as the single-repo views). `repositoryIntegrationIds`
	 * undefined = all connected repos. Repos without a READY analysis are returned
	 * as `unavailable` (the UI shows a hint) rather than dropped silently.
	 */
	private async resolveSelectedAnalyses(
		projectId: string,
		repositoryIntegrationIds: string[] | undefined,
	): Promise<{
		available: {
			repo: RepoOption;
			analysis: NonNullable<
				Awaited<ReturnType<AtlasService["resolveAnalysis"]>>
			>;
		}[];
		unavailable: UnavailableRepo[];
	}> {
		const all = await queries.listProjectRepositories(this.ctx, projectId);
		const wanted = repositoryIntegrationIds
			? all.filter(
					(r) =>
						r.repositoryIntegrationId !== null &&
						repositoryIntegrationIds.includes(
							r.repositoryIntegrationId,
						),
				)
			: all;
		const available: {
			repo: RepoOption;
			analysis: NonNullable<
				Awaited<ReturnType<AtlasService["resolveAnalysis"]>>
			>;
		}[] = [];
		const unavailable: UnavailableRepo[] = [];
		for (const repo of wanted) {
			const analysis = await this.resolveAnalysis(projectId, repo);
			if (analysis && analysis.status === "READY") {
				available.push({ repo, analysis });
			} else {
				unavailable.push({
					repoId: repo.repositoryIntegrationId,
					repoName: repo.repositoryName,
					reason: analysis
						? "Analysis not finished"
						: "Not analysed yet",
				});
			}
		}
		return { available, unavailable };
	}

	/**
	 * Load the persisted cross-repo edges for a set of analyses and overlay the
	 * user's edge overrides: the user-edited description wins over the AI
	 * rationale, soft-deleted edges are flagged (`deleted`), and user-created
	 * manual cross-repo edges are appended. Endpoint keys stay canonical (per
	 * analysis), NOT namespaced — each caller (System map, System-map chat, solo
	 * chat) namespaces/filters as it needs. This is the single source the map and
	 * both chats share, so a user's edits and manual connections are reflected
	 * everywhere identically.
	 */
	private async overlayCrossEdges(
		projectId: string,
		mode: GraphMode,
		repos: {
			analysisId: string;
			repositoryIntegrationId: string | null;
			branch: string;
		}[],
	): Promise<OverlaidCrossEdge[]> {
		const analysisIds = repos.map((r) => r.analysisId);
		if (analysisIds.length === 0) {
			return [];
		}
		const repoIdByAnalysisId = new Map<string, string | null>(
			repos.map((r) => [r.analysisId, r.repositoryIntegrationId]),
		);
		const analysisIdByRepoId = new Map<string | null, string>(
			repos.map((r) => [r.repositoryIntegrationId, r.analysisId]),
		);

		const crossRows = await queries.getCrossEdges(
			this.ctx,
			projectId,
			mode,
			analysisIds,
		);

		// Overrides are keyed by ENDPOINTS (repo integration + node key) and live
		// per branch, so load every distinct branch the selected analyses sit on.
		const distinctBranches = [...new Set(repos.map((r) => r.branch))];
		const overrideRows = (
			await Promise.all(
				distinctBranches.map((branch) =>
					queries.loadEdgeOverrides(
						this.ctx,
						projectId,
						branch,
						mode,
					),
				),
			)
		).flat();
		const overrideByEndpoints = new Map<
			string,
			(typeof overrideRows)[number]
		>();
		for (const override of overrideRows) {
			if (!override.isCrossRepo) {
				continue;
			}
			overrideByEndpoints.set(
				`${override.sourceRepositoryIntegrationId ?? "_"}::${override.sourceKey}->${override.targetRepositoryIntegrationId ?? "_"}::${override.targetKey}`,
				override,
			);
		}
		const overrideKeyForCross = (
			sourceAnalysisId: string,
			sourceKey: string | null,
			targetAnalysisId: string,
			targetKey: string | null,
		): string | null => {
			if (sourceKey === null || targetKey === null) {
				return null; // repo-level endpoints are not user-overridable here
			}
			const srcRepo = repoIdByAnalysisId.get(sourceAnalysisId) ?? null;
			const tgtRepo = repoIdByAnalysisId.get(targetAnalysisId) ?? null;
			return `${srcRepo ?? "_"}::${sourceKey}->${tgtRepo ?? "_"}::${targetKey}`;
		};

		const overlaid: OverlaidCrossEdge[] = [];
		const matchedOverrideIds = new Set<string>();
		for (const row of crossRows) {
			const overrideKey = overrideKeyForCross(
				row.sourceAnalysisId,
				row.sourceKey,
				row.targetAnalysisId,
				row.targetKey,
			);
			const override = overrideKey
				? overrideByEndpoints.get(overrideKey)
				: undefined;
			if (override) {
				matchedOverrideIds.add(override.id);
			}
			overlaid.push({
				// A user-RE-TYPED connection (`isUserKind`) shows the chosen kind
				// over the AI/structural detection; otherwise the detected kind stands.
				kind:
					override?.isUserKind && override.kind
						? override.kind
						: row.kind,
				detection: row.detection as CrossEdgeDetection,
				sourceAnalysisId: row.sourceAnalysisId,
				sourceKey: row.sourceKey,
				targetAnalysisId: row.targetAnalysisId,
				targetKey: row.targetKey,
				// User description override wins over the AI rationale.
				description: override?.userDescription ?? row.description,
				weight: row.weight,
				isManual: false,
				isUserDescription: Boolean(override?.userDescription),
				deleted: Boolean(override?.deletedAt),
				overrideId: override?.id ?? null,
			});
		}

		// Manual cross-repo edges (user-created, no underlying detected edge) whose
		// BOTH endpoints map to one of the supplied analyses.
		for (const override of overrideRows) {
			if (!override.isManual || !override.isCrossRepo) {
				continue;
			}
			if (matchedOverrideIds.has(override.id)) {
				continue;
			}
			const sourceAnalysisId = analysisIdByRepoId.get(
				override.sourceRepositoryIntegrationId,
			);
			const targetAnalysisId = analysisIdByRepoId.get(
				override.targetRepositoryIntegrationId,
			);
			if (!sourceAnalysisId || !targetAnalysisId) {
				continue;
			}
			overlaid.push({
				kind: override.kind,
				detection: null,
				sourceAnalysisId,
				sourceKey: override.sourceKey,
				targetAnalysisId,
				targetKey: override.targetKey,
				description: override.userDescription ?? null,
				weight: null,
				isManual: true,
				isUserDescription: Boolean(override.userDescription),
				deleted: Boolean(override.deletedAt),
				overrideId: override.id,
			});
		}

		return overlaid;
	}

	/**
	 * The cross-repository references that involve a single repository's analysis,
	 * for grounding the SOLO chat in a multi-repo project. Resolves the project's
	 * other READY analyses, overlays the user's edge edits/manual edges, drops
	 * soft-deleted ones, and keeps only edges with one endpoint in `thisAnalysis`.
	 * Degrades to empty for a single-repo project (nothing crosses).
	 */
	private async resolveSoloCrossRefs(
		projectId: string,
		mode: GraphMode,
		thisAnalysisId: string,
	): Promise<{
		crossRefs: ChatCrossRef[];
		repoNameByAnalysisId: Record<string, string>;
	}> {
		const { available } = await this.resolveSelectedAnalyses(
			projectId,
			undefined,
		);
		// Fewer than two READY repos → nothing can cross.
		if (available.length < 2) {
			return { crossRefs: [], repoNameByAnalysisId: {} };
		}
		const overlaid = await this.overlayCrossEdges(
			projectId,
			mode,
			available.map(({ repo, analysis }) => ({
				analysisId: analysis.id,
				repositoryIntegrationId: repo.repositoryIntegrationId,
				branch: analysis.branch,
			})),
		);
		const repoNameByAnalysisId: Record<string, string> = {};
		for (const { repo, analysis } of available) {
			repoNameByAnalysisId[analysis.id] = repo.repositoryName;
		}
		const crossRefs = overlaid
			.filter(
				(edge) =>
					!edge.deleted &&
					(edge.sourceAnalysisId === thisAnalysisId ||
						edge.targetAnalysisId === thisAnalysisId),
			)
			.map((edge) => ({
				sourceAnalysisId: edge.sourceAnalysisId,
				sourceKey: edge.sourceKey,
				targetAnalysisId: edge.targetAnalysisId,
				targetKey: edge.targetKey,
				kind: edge.kind,
				description: edge.description,
			}));
		return { crossRefs, repoNameByAnalysisId };
	}

	/**
	 * The merged multi-repo graph for a lens: each selected repo's nodes/edges
	 * (namespaced by analysis id, parented under a repo container) plus the
	 * persisted cross-repo edges. A PURE read — never runs AI; the cross-edges are
	 * computed/persisted by `linkRepositories`.
	 */
	async getSystemGraph(input: {
		projectId: string;
		repositoryIntegrationIds: string[];
		mode: GraphMode;
		/** Include soft-deleted edges (for an "edited connections" review surface). */
		includeDeleted?: boolean;
	}): Promise<SystemGraph> {
		const includeDeleted = input.includeDeleted ?? false;
		const { available, unavailable } = await this.resolveSelectedAnalyses(
			input.projectId,
			input.repositoryIntegrationIds,
		);

		const repos: RepoGroupInfo[] = [];
		const nodes: SystemGraphNode[] = [];
		const edges: SystemGraphEdge[] = [];

		for (const { repo, analysis } of available) {
			const graph = await queries.getGraph(
				this.ctx,
				analysis.id,
				input.mode,
				{ includeDeleted },
			);
			const groupId = `repo::${analysis.id}`;
			const ns = (key: string) => `${analysis.id}::${key}`;
			nodes.push({
				id: groupId,
				kind: "REPO_GROUP",
				label: repo.repositoryName,
				repoId: repo.repositoryIntegrationId,
				repoName: repo.repositoryName,
				analysisId: analysis.id,
				parentId: null,
				originalKey: null,
				filePath: null,
				language: null,
				description: null,
				category: null,
				isUserCategory: false,
				metrics: null,
			});
			for (const n of graph.nodes) {
				nodes.push({
					id: ns(n.key),
					kind: n.kind,
					label: n.label,
					repoId: repo.repositoryIntegrationId,
					repoName: repo.repositoryName,
					analysisId: analysis.id,
					parentId: groupId,
					originalKey: n.key,
					filePath: n.filePath,
					language: n.language,
					description: n.description,
					category: n.category,
					isUserCategory: n.isUserCategory,
					metrics: n.metrics,
				});
			}
			for (const e of graph.edges) {
				edges.push({
					id: `${analysis.id}::${e.source}->${e.target}`,
					source: ns(e.source),
					target: ns(e.target),
					kind: e.kind,
					crossRepo: false,
					detection: null,
					// Solo-edge overrides are already overlaid by `getGraph`.
					description: e.description ?? null,
					weight: e.weight,
					isManual: e.isManual ?? false,
					isUserDescription: e.isUserDescription ?? false,
					deleted: e.deleted ?? false,
					overrideId: e.overrideId ?? null,
				});
			}
			repos.push({
				repoId: repo.repositoryIntegrationId,
				repoName: repo.repositoryName,
				analysisId: analysis.id,
				nodeCount: graph.nodes.length,
			});
		}

		// Cross-repo edges among the available analyses, with the user's edge
		// overrides already overlaid (edited descriptions win, manual edges added,
		// soft-deletions flagged) — the SAME overlay the chats ground on. The map
		// then namespaces the canonical endpoints, drops edges whose endpoint no
		// longer exists (a re-analysis dropped the node), and respects
		// `includeDeleted`.
		const nodeIds = new Set(nodes.map((n) => n.id));
		const overlaidCrossEdges = await this.overlayCrossEdges(
			input.projectId,
			input.mode,
			available.map(({ repo, analysis }) => ({
				analysisId: analysis.id,
				repositoryIntegrationId: repo.repositoryIntegrationId,
				branch: analysis.branch,
			})),
		);
		const namespaceCrossEndpoint = (
			analysisId: string,
			key: string | null,
		): string =>
			key === null ? `repo::${analysisId}` : `${analysisId}::${key}`;
		for (const edge of overlaidCrossEdges) {
			if (edge.deleted && !includeDeleted) {
				continue;
			}
			const src = namespaceCrossEndpoint(
				edge.sourceAnalysisId,
				edge.sourceKey,
			);
			const tgt = namespaceCrossEndpoint(
				edge.targetAnalysisId,
				edge.targetKey,
			);
			if (!nodeIds.has(src) || !nodeIds.has(tgt)) {
				continue;
			}
			edges.push({
				id: `xrepo::${src}->${tgt}::${edge.kind}`,
				source: src,
				target: tgt,
				kind: edge.kind as SystemCrossEdgeKind,
				crossRepo: true,
				detection: edge.detection,
				description: edge.description,
				weight: edge.weight,
				isManual: edge.isManual,
				isUserDescription: edge.isUserDescription,
				deleted: edge.deleted,
				overrideId: edge.overrideId,
			});
		}

		const crossLink = await queries.getCrossLink(this.ctx, input.projectId);
		const currentSignature = computeSignature(
			available.map(({ analysis }) => ({
				analysisId: analysis.id,
				commitSha: analysis.analyzedCommitSha,
			})),
		);
		const stale =
			available.length >= 2 &&
			(!crossLink ||
				crossLink.status !== "READY" ||
				crossLink.signature !== currentSignature);

		// Saved shared System-map positions (project + mode), seeded by the FE.
		const layouts = await queries.getSystemNodeLayout(
			this.ctx,
			input.projectId,
			input.mode,
		);

		return {
			mode: input.mode,
			repos,
			nodes,
			edges,
			crossLink: {
				status: (crossLink?.status ?? "PENDING") as CrossLinkStatus,
				stale,
				edgeCount: crossLink?.edgeCount ?? 0,
			},
			unavailableRepos: unavailable,
			layouts,
		};
	}

	/**
	 * Compute + persist the cross-repo edges for a project (structural always; AI
	 * best-effort). Idempotent: a no-op when the freshness signature is unchanged.
	 * Runs the AI pass INLINE (same pattern as `describeNodeOnDemand`) — no Temporal
	 * workflow change, so nothing here is replay-sensitive.
	 */
	async linkRepositories(input: {
		projectId: string;
		repositoryIntegrationIds?: string[];
		/**
		 * Force a recompute, bypassing the freshness-signature idempotency (the
		 * "re-map relationships" action). `keep` preserves the user's cross-repo
		 * edge edits (they overlay the fresh edges); `fresh` wipes them first.
		 * Undefined = the automatic, idempotent stale-recompute.
		 */
		force?: "keep" | "fresh";
	}): Promise<CrossLinkState> {
		const { available } = await this.resolveSelectedAnalyses(
			input.projectId,
			input.repositoryIntegrationIds,
		);
		const liveIds = available
			.map(({ repo }) => repo.repositoryIntegrationId)
			.filter((id): id is string => id !== null);
		const signature = computeSignature(
			available.map(({ analysis }) => ({
				analysisId: analysis.id,
				commitSha: analysis.analyzedCommitSha,
			})),
		);
		const trigger =
			input.force === "fresh"
				? "remap_fresh"
				: input.force
					? "remap"
					: "auto";
		const startedAt = Date.now();

		// "Fresh" re-map: wipe the user's cross-repo edge edits (both lenses) so the
		// recompute starts from a clean slate — they are "all new now".
		if (input.force === "fresh") {
			await queries.deleteCrossRepoEdgeOverrides(
				this.ctx,
				input.projectId,
			);
		}

		// Fewer than two READY repos → nothing can cross. Clear stale edges and
		// mark READY so the UI doesn't keep retrying.
		if (available.length < 2) {
			await queries.replaceCrossEdges(this.ctx, input.projectId, []);
			await queries.finishCrossLink(this.ctx, input.projectId, {
				status: "READY",
				signature,
				repositoryIntegrationIds: liveIds,
				edgeCount: 0,
				model: null,
				totalTokens: null,
				costMicroUsd: null,
				error: null,
				durationMs: 0,
			});
			// Only a user-forced re-map is worth a history row here (there is
			// nothing to map, but the action still happened).
			if (input.force) {
				await queries
					.recordCrossLinkRun(this.ctx, {
						projectId: input.projectId,
						triggeredByUserId: this.ctx.userId,
						trigger,
						status: "READY",
						repositoryIntegrationIds: liveIds,
						edgeCount: 0,
						model: null,
						totalTokens: null,
						costMicroUsd: null,
						error: null,
						startedAt: new Date(startedAt),
						durationMs: Date.now() - startedAt,
					})
					.catch(() => {});
			}
			return { status: "READY", stale: false, edgeCount: 0 };
		}

		// Idempotency: unchanged participating analyses → keep the existing edges.
		// A forced re-map always recomputes (skips this short-circuit).
		const existing = await queries.getCrossLink(this.ctx, input.projectId);
		if (
			!input.force &&
			existing &&
			existing.status === "READY" &&
			existing.signature === signature
		) {
			return {
				status: "READY",
				stale: false,
				edgeCount: existing.edgeCount,
			};
		}

		await queries.startCrossLink(this.ctx, input.projectId);
		try {
			const toLite = (n: GraphNode): RepoNodeLite => ({
				key: n.key,
				label: n.label,
				kind: n.kind,
				description: n.description,
				filePath: n.filePath,
			});
			const repoData: RepoAnalysisData[] = [];
			for (const { repo, analysis } of available) {
				const [tech, biz] = await Promise.all([
					queries.getGraph(this.ctx, analysis.id, "TECHNICAL"),
					queries.getGraph(this.ctx, analysis.id, "BUSINESS"),
				]);
				repoData.push({
					analysisId: analysis.id,
					repoId: repo.repositoryIntegrationId,
					repoName: repo.repositoryName,
					repoUrl: repo.repositoryUrl,
					commitSha: analysis.analyzedCommitSha,
					techStack:
						(analysis.techStack as TechStackEntry[] | null) ?? [],
					publishedPackages:
						(analysis.publishedPackages as string[] | null) ?? [],
					technicalNodes: tech.nodes.map(toLite),
					businessNodes: biz.nodes.map(toLite),
				});
			}

			const structural = detectStructuralEdges(repoData);
			const ai = await detectAiEdges(this.ctx, repoData, input.projectId);
			const all: DetectedCrossEdge[] = [...structural, ...ai.edges];
			const edgeCount = await queries.replaceCrossEdges(
				this.ctx,
				input.projectId,
				all,
			);

			let costMicroUsd: number | null = null;
			if (ai.model && ai.usage.totalTokens > 0) {
				const rates = await queries.getModelCostRates(ai.model);
				if (rates) {
					costMicroUsd = computeCostMicroUsd({
						promptTokens: ai.usage.promptTokens,
						completionTokens: ai.usage.completionTokens,
						inputCostPer1M: rates.inputCostPer1M,
						outputCostPer1M: rates.outputCostPer1M,
					});
				}
			}

			await queries.finishCrossLink(this.ctx, input.projectId, {
				status: "READY",
				signature,
				repositoryIntegrationIds: liveIds,
				edgeCount,
				model: ai.model,
				totalTokens: ai.usage.totalTokens || null,
				costMicroUsd,
				error: null,
				durationMs: Date.now() - startedAt,
			});

			// History row — every actual recompute (auto / remap / remap_fresh) is
			// recorded with its cost so it shows in the System-map relationship
			// history. Best-effort: never fail the link on the audit write.
			await queries
				.recordCrossLinkRun(this.ctx, {
					projectId: input.projectId,
					triggeredByUserId: this.ctx.userId,
					trigger,
					status: "READY",
					repositoryIntegrationIds: liveIds,
					edgeCount,
					model: ai.model,
					totalTokens: ai.usage.totalTokens || null,
					costMicroUsd,
					error: null,
					startedAt: new Date(startedAt),
					durationMs: Date.now() - startedAt,
				})
				.catch(() => {});

			return { status: "READY", stale: false, edgeCount };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			await queries
				.finishCrossLink(this.ctx, input.projectId, {
					status: "FAILED",
					signature: null,
					repositoryIntegrationIds: liveIds,
					edgeCount: 0,
					model: null,
					totalTokens: null,
					costMicroUsd: null,
					error: message,
					durationMs: Date.now() - startedAt,
				})
				.catch(() => {});
			await queries
				.recordCrossLinkRun(this.ctx, {
					projectId: input.projectId,
					triggeredByUserId: this.ctx.userId,
					trigger,
					status: "FAILED",
					repositoryIntegrationIds: liveIds,
					edgeCount: 0,
					model: null,
					totalTokens: null,
					costMicroUsd: null,
					error: message,
					startedAt: new Date(startedAt),
					durationMs: Date.now() - startedAt,
				})
				.catch(() => {});
			throw error;
		}
	}

	/**
	 * System-map relationship history — the cross-link recompute runs (auto +
	 * user re-maps) with cost / tokens / model / duration. Newest-first.
	 */
	async getSystemRemapHistory(input: {
		projectId: string;
		limit?: number;
		offset?: number;
	}): Promise<{ runs: queries.CrossLinkRunSummary[]; total: number }> {
		const [runs, total] = await Promise.all([
			queries.getCrossLinkRuns(
				this.ctx,
				input.projectId,
				input.limit ?? 20,
				input.offset ?? 0,
			),
			queries.countCrossLinkRuns(this.ctx, input.projectId),
		]);
		return { runs, total };
	}

	/**
	 * Re-map a SOLO repo's relationships: run the AI intra-repo reference pass and
	 * persist the results as editable, re-analysis-surviving edge overrides
	 * (`isAiGenerated`). Two modes:
	 *  • keep (default) — drop only the prior AI-generated references, then
	 *    regenerate; the user's own edge edits/manual edges/deletions are kept and
	 *    NOT regenerated over.
	 *  • fresh — wipe ALL of this repo's solo edge edits (both lenses) first, then
	 *    regenerate from a clean slate.
	 * References that duplicate a structural edge (already shown) or an existing
	 * user override are skipped. Records a per-repo run-history row (`remap` /
	 * `remap_fresh`) with cost so it shows in the Atlas history alongside analyses.
	 */
	async remapSolo(input: {
		projectId: string;
		repositoryIntegrationId: string | null;
		fresh?: boolean;
	}): Promise<{
		referencesGenerated: number;
		model: string | null;
		totalTokens: number | null;
		costMicroUsd: number | null;
	}> {
		const repo = await this.resolveRepoOption(
			input.projectId,
			input.repositoryIntegrationId,
		);
		const analysis = await this.resolveAnalysis(input.projectId, repo);
		if (!analysis || analysis.status !== "READY") {
			throw new AtlasError(
				"NOT_FOUND",
				"This repository has not been analysed yet.",
			);
		}
		const branch = analysis.branch;
		const runMode = input.fresh ? "remap_fresh" : "remap";

		// History row (reuses the per-repo analysis-history surface).
		await queries.createAnalysisRun(this.ctx, {
			analysisId: analysis.id,
			projectId: input.projectId,
			mode: runMode,
			branch,
		});

		try {
			// Reset edits: `fresh` wipes ALL of this repo's solo edge edits (both
			// lenses); `keep` removes only the prior AI-generated references.
			await queries.deleteSoloEdgeOverrides(this.ctx, {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				branch,
				onlyAiGenerated: !input.fresh,
			});

			// Node sets + structural edges for both lenses.
			const [tech, biz] = await Promise.all([
				queries.getGraph(this.ctx, analysis.id, "TECHNICAL"),
				queries.getGraph(this.ctx, analysis.id, "BUSINESS"),
			]);
			const toLite = (n: GraphNode): RepoNodeLite => ({
				key: n.key,
				label: n.label,
				kind: n.kind,
				description: n.description,
				filePath: n.filePath,
			});

			const ai = await detectIntraRepoReferences(
				this.ctx,
				{
					analysisId: analysis.id,
					repoName: repo?.repositoryName ?? "this repository",
					technicalNodes: tech.nodes.map(toLite),
					businessNodes: biz.nodes.map(toLite),
				},
				input.projectId,
			);

			// Skip-set: endpoint pairs that already carry a user edit (keep-edits)
			// plus structural edges (already shown). Undirected, per lens,
			// NUL-delimited to match `getSoloOverrideEndpointPairs`.
			const skip = await queries.getSoloOverrideEndpointPairs(this.ctx, {
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId,
				branch,
			});
			const pairKey = (m: GraphMode, a: string, b: string): string =>
				`${m}\u0000${a}\u0000${b}`;
			const addBoth = (m: GraphMode, a: string, b: string) => {
				skip.add(pairKey(m, a, b));
				skip.add(pairKey(m, b, a));
			};
			for (const e of tech.edges) {
				addBoth("TECHNICAL", e.source, e.target);
			}
			for (const e of biz.edges) {
				addBoth("BUSINESS", e.source, e.target);
			}

			let referencesGenerated = 0;
			for (const e of ai.edges) {
				if (skip.has(pairKey(e.mode, e.sourceKey, e.targetKey))) {
					continue;
				}
				addBoth(e.mode, e.sourceKey, e.targetKey); // dedupe within this run
				await queries.upsertEdgeOverride(this.ctx, {
					projectId: input.projectId,
					branch,
					mode: e.mode,
					source: {
						repositoryIntegrationId: input.repositoryIntegrationId,
						key: e.sourceKey,
					},
					target: {
						repositoryIntegrationId: input.repositoryIntegrationId,
						key: e.targetKey,
					},
					kind: e.kind,
					userDescription: e.description,
					isManual: true,
					isCrossRepo: false,
					isAiGenerated: true,
					updatedByUserId: this.ctx.userId,
				});
				referencesGenerated++;
			}

			let costMicroUsd: number | null = null;
			if (ai.model && ai.usage.totalTokens > 0) {
				const rates = await queries.getModelCostRates(ai.model);
				if (rates) {
					costMicroUsd = computeCostMicroUsd({
						promptTokens: ai.usage.promptTokens,
						completionTokens: ai.usage.completionTokens,
						inputCostPer1M: rates.inputCostPer1M,
						outputCostPer1M: rates.outputCostPer1M,
					});
				}
			}

			await queries.completeLatestRun(this.ctx, {
				analysisId: analysis.id,
				status: "READY",
				branch,
				edgeCount: referencesGenerated,
				telemetry: {
					model: ai.model,
					promptTokens: ai.usage.promptTokens || null,
					completionTokens: ai.usage.completionTokens || null,
					totalTokens: ai.usage.totalTokens || null,
					costMicroUsd,
				},
			});

			return {
				referencesGenerated,
				model: ai.model,
				totalTokens: ai.usage.totalTokens || null,
				costMicroUsd,
			};
		} catch (error) {
			await queries
				.completeLatestRun(this.ctx, {
					analysisId: analysis.id,
					status: "FAILED",
					branch,
					error:
						error instanceof Error ? error.message : String(error),
				})
				.catch(() => {});
			throw error;
		}
	}

	/**
	 * Multi-repo Q&A (System map). Grounds on the SELECTED repos' graphs + the
	 * persisted cross-repo edges and persists to a project-wide (isSystemScope)
	 * conversation. Returns `{ textStream, persistOutcome }` — same contract as
	 * `chat`.
	 */
	async systemChat(input: {
		projectId: string;
		repositoryIntegrationIds: string[];
		mode: GraphMode;
		focusNodeKey?: string;
		conversationId?: string;
		messages: { role: "user" | "assistant" | "system"; content: string }[];
	}) {
		const { available } = await this.resolveSelectedAnalyses(
			input.projectId,
			input.repositoryIntegrationIds,
		);
		if (available.length === 0) {
			throw new AtlasError(
				"NOT_FOUND",
				"None of the selected repositories have been analysed yet.",
			);
		}

		// Overlay user edge edits/manual connections (and drop soft-deleted ones)
		// so the chat reflects exactly what the System map shows.
		const crossEdges = await this.overlayCrossEdges(
			input.projectId,
			input.mode,
			available.map(({ repo, analysis }) => ({
				analysisId: analysis.id,
				repositoryIntegrationId: repo.repositoryIntegrationId,
				branch: analysis.branch,
			})),
		);
		const system = await buildSystemChatPrompt(this.ctx, {
			repos: available.map(({ repo, analysis }) => ({
				repoName: repo.repositoryName,
				analysisId: analysis.id,
			})),
			mode: input.mode,
			crossEdges: crossEdges
				.filter((e) => !e.deleted)
				.map((e) => ({
					kind: e.kind,
					sourceAnalysisId: e.sourceAnalysisId,
					sourceKey: e.sourceKey,
					targetAnalysisId: e.targetAnalysisId,
					targetKey: e.targetKey,
					description: e.description,
				})),
			projectName: null,
		});

		const conversation = input.conversationId
			? await this.getConversation({
					conversationId: input.conversationId,
					projectId: input.projectId,
				})
			: await this.createConversation({
					projectId: input.projectId,
					repositoryIntegrationId: null,
					isSystemScope: true,
				});

		return this.streamAssistantTurn({
			projectId: input.projectId,
			conversation,
			system,
			incomingMessages: input.messages,
		});
	}

	/**
	 * Shared chat turn: persists the user message up front (loss-proof), streams a
	 * provider-agnostic completion grounded in `system`, and persists the assistant
	 * reply exactly once (one-shot guard across finish / abort / error / disconnect).
	 * Mirrors the proven single-repo `chat` machinery; used by `systemChat`.
	 */
	private async streamAssistantTurn(input: {
		projectId: string;
		conversation: ConversationDetail;
		system: string;
		incomingMessages: {
			role: "user" | "assistant" | "system";
			content: string;
		}[];
	}) {
		const { conversation, system } = input;

		const newUserMessage = [...input.incomingMessages]
			.reverse()
			.find((m) => m.role === "user");
		const priorMessages: StoredChatMessage[] = conversation.messages.filter(
			(m) => m.role !== "system",
		);
		const conversationForModel = [
			...priorMessages.map((m) => ({ role: m.role, content: m.content })),
			...(newUserMessage
				? [{ role: "user" as const, content: newUserMessage.content }]
				: []),
		];

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{
				userId: this.ctx.userId,
				organizationId: this.ctx.organizationId ?? undefined,
			},
		);
		const usageStartedAt = Date.now();

		const conversationId = conversation.id;
		const titleIsDefault =
			conversation.messages.length === 0 &&
			(conversation.title === DEFAULT_CONVERSATION_TITLE ||
				!conversation.title);

		if (newUserMessage) {
			const title = titleIsDefault
				? deriveConversationTitle(newUserMessage.content)
				: undefined;
			let updatedRows = 0;
			let userAppendError: unknown = null;
			try {
				updatedRows = await queries.appendMessages(
					conversationId,
					[
						{
							role: "user",
							content: newUserMessage.content,
							createdAt: new Date().toISOString(),
						},
					],
					title,
				);
			} catch (error) {
				userAppendError = error;
			}
			if (userAppendError != null || updatedRows === 0) {
				logger.warn("[atlas] failed to persist chat turn", {
					conversationId,
					error:
						userAppendError instanceof Error
							? userAppendError.message
							: String(
									userAppendError ??
										"conversation row missing",
								),
				});
				throw new AtlasError(
					"PERSISTENCE_FAILED",
					"Your message couldn't be saved. Please try sending it again.",
				);
			}
		}

		let assistantPersisted = false;
		let accumulatedText = "";
		let resolvePersistOutcome!: (outcome: {
			persisted: boolean;
			interrupted: boolean;
		}) => void;
		const persistOutcome = new Promise<{
			persisted: boolean;
			interrupted: boolean;
		}>((resolve) => {
			resolvePersistOutcome = resolve;
		});
		const persistAssistant = async (
			text: string,
			interrupted: boolean,
		): Promise<void> => {
			if (assistantPersisted) {
				return;
			}
			assistantPersisted = true;
			if (text.trim() === "") {
				resolvePersistOutcome({ persisted: true, interrupted });
				return;
			}
			try {
				await queries.appendMessages(conversationId, [
					{
						role: "assistant",
						content: text,
						createdAt: new Date().toISOString(),
						...(interrupted ? { interrupted: true as const } : {}),
					},
				]);
				resolvePersistOutcome({ persisted: true, interrupted });
			} catch (error) {
				logger.warn("[atlas] failed to persist chat turn", {
					conversationId,
					error:
						error instanceof Error ? error.message : String(error),
				});
				resolvePersistOutcome({ persisted: false, interrupted });
			}
		};

		const result = streamText({
			model,
			system,
			messages: conversationForModel.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
			onFinish: async ({ text, usage }) => {
				recordAtlasUsage({
					ctx: this.ctx,
					metadata,
					taskType: "CHAT",
					usage,
					startedAt: usageStartedAt,
					projectId: input.projectId,
				});
				trackUsage();
				await persistAssistant(text, false);
			},
			onAbort: async () => {
				await persistAssistant(accumulatedText, true);
			},
			onError: async () => {
				await persistAssistant(accumulatedText, true);
			},
		});

		const textStream = (async function* () {
			let completed = false;
			try {
				for await (const delta of result.textStream) {
					accumulatedText += delta;
					yield delta;
				}
				completed = true;
			} finally {
				if (!completed) {
					await persistAssistant(accumulatedText, true);
				}
			}
		})();

		return { textStream, persistOutcome };
	}

	// ── Repository acquisition (own clone/walk/redact) ─────────────────────────

	/**
	 * Throw if the activity has been cancelled. Used between major pipeline
	 * steps so a "Cancel analysis" stops the (long) structure activity promptly.
	 * The thrown error only surfaces directly if Temporal somehow doesn't report
	 * the activity as cancelled; under TRY_CANCEL the SDK reports a
	 * CancelledFailure to the workflow, which finalizes "Cancelled by user".
	 */
	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw new AtlasError("CONFLICT", "Analysis cancelled by user.");
		}
	}

	/**
	 * Decide whether a repo path is one the analyzer will actually parse, reusing
	 * the parser's OWN predicates so the sparse checkout below materializes
	 * EXACTLY the set `collectFiles` would have walked — no analysis drift versus
	 * a full clone.
	 *
	 * Mirrors `collectFiles`' precedence: a skipped-dir path is always excluded
	 * (in the walk that's the directory-level `continue`, so manifests/markdown
	 * buried under `node_modules`, `dist`, … are never collected either), then a
	 * path is wanted if it is analysable source OR a dependency manifest OR a
	 * markdown doc.
	 */
	private isWantedForAnalysis(rel: string): boolean {
		const p = normalizePath(rel);
		if (isInSkippedDir(p)) {
			return false;
		}
		return (
			isAnalyzableSource(p) || isManifestPath(p) || MARKDOWN_EXT.test(p)
		);
	}

	/**
	 * Clone the repo into a FRESH, per-attempt working directory, retrying a few
	 * times on transient network failures before giving up to Temporal's (heavier)
	 * activity-level retry. Returns the winning attempt's directory + commit info;
	 * the caller owns cleaning that directory up (`runStructureAnalysis`' `finally`).
	 *
	 * Two hardenings over a bare `cloneForAnalysis` call:
	 *  - Per-attempt directory (`makeClonePath`): the clone path used to be
	 *    deterministic (`fabric-cu-<analysisId>`), so a retried or concurrent
	 *    attempt cloned into — and a failed attempt's cleanup deleted — the SAME
	 *    directory another attempt's git was running in, surfacing as
	 *    `fatal: Unable to read current working directory: No such file or
	 *    directory`. Each attempt now gets a unique directory and, on failure,
	 *    removes ONLY its own.
	 *  - Bounded retry: a large fetch occasionally dies with a transient
	 *    `early EOF` / `invalid index-pack output`; a quick re-clone recovers far
	 *    faster than failing the activity. AUTH failures (which `cloneForAnalysis`
	 *    surfaces as a clean `REPOSITORY_REAUTH_REQUIRED` `AtlasError`) and user
	 *    cancellations are terminal and propagate immediately — never retried.
	 */
	private async acquireRepoForAnalysis(input: {
		creds: queries.ResolvedRepoCredentials;
		projectId: string;
		repositoryIntegrationId: string;
		analysisId: string;
		activityAttempt?: number;
		abortSignal?: AbortSignal;
		heartbeat?: () => void;
	}): Promise<{
		clonePath: string;
		commitSha: string;
		commitAt: Date | null;
	}> {
		for (let attempt = 1; attempt <= CLONE_MAX_ATTEMPTS; attempt++) {
			this.throwIfAborted(input.abortSignal);
			const clonePath = this.makeClonePath(
				input.analysisId,
				input.activityAttempt,
			);
			try {
				const { commitSha, commitAt } = await this.cloneForAnalysis({
					creds: input.creds,
					clonePath,
					projectId: input.projectId,
					repositoryIntegrationId: input.repositoryIntegrationId,
					abortSignal: input.abortSignal,
				});
				return { clonePath, commitSha, commitAt };
			} catch (error) {
				// Remove ONLY this attempt's (partial) clone before anything else,
				// so a retry starts clean and nothing is left behind in tmp.
				this.cleanupDir(clonePath);
				// A user "Cancel analysis" mid-clone surfaces as a cancellation, not
				// as a retryable failure.
				this.throwIfAborted(input.abortSignal);
				// Terminal failures propagate immediately: a reconnect-required auth
				// error (an `AtlasError` from `cloneForAnalysis`) or any auth-looking
				// git error won't be fixed by retrying. Anything else is treated as a
				// transient network failure and retried until attempts run out.
				const terminal =
					error instanceof AtlasError || isGitAuthError(error);
				if (terminal || attempt >= CLONE_MAX_ATTEMPTS) {
					throw error;
				}
				logger.warn(
					"[atlas] repo clone failed; retrying after backoff",
					{
						analysisId: input.analysisId,
						attempt,
						maxAttempts: CLONE_MAX_ATTEMPTS,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				await this.sleep(
					CLONE_RETRY_BASE_DELAY_MS * attempt,
					input.abortSignal,
				);
				// Keep the activity heartbeat alive across the backoff.
				input.heartbeat?.();
			}
		}
		// Unreachable: the final attempt always returns or throws above. Present
		// only so the function is statically known to return or throw.
		throw new AtlasError("NO_REPOSITORY", "Repository clone failed.");
	}

	/**
	 * Build a unique on-disk path for ONE clone attempt. A random suffix (plus the
	 * Temporal activity attempt when present, for traceability) guarantees a
	 * retried or concurrent attempt never shares a directory with another — so one
	 * attempt's cleanup can't delete the working tree another attempt's git is using.
	 */
	private makeClonePath(
		analysisId: string,
		activityAttempt?: number,
	): string {
		const attemptTag =
			typeof activityAttempt === "number" ? `a${activityAttempt}` : "a0";
		const unique = randomBytes(6).toString("hex");
		return path.join(
			os.tmpdir(),
			`fabric-cu-${analysisId}-${attemptTag}-${unique}`,
		);
	}

	/**
	 * Abort-aware delay for the clone backoff: resolves after `ms`, or early if the
	 * analysis is cancelled (the next loop turn's abort check then throws), so a
	 * "Cancel analysis" during a backoff doesn't wait out the full delay.
	 */
	private sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal?.aborted) {
				resolve();
				return;
			}
			let timer: ReturnType<typeof setTimeout>;
			const onAbort = (): void => {
				clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Clone for analysis, self-healing a dead GitHub OAuth credential ONCE.
	 *
	 * The integration can read ACTIVE at request time yet still fail the clone
	 * with `fatal: Authentication failed` — a rotated/revoked access token, or an
	 * org-SSO de-authorization the lightweight `GET /user` health probe never
	 * sees. On such an auth failure (GitHub OAuth only) we force a REAL token
	 * re-exchange and retry the clone exactly once. If the retry still fails — or
	 * the credential can't be re-exchanged at all — we flag the integration
	 * reconnect-required (notifying the configuring user) and raise a clean
	 * `REPOSITORY_REAUTH_REQUIRED` instead of surfacing the raw git error (which
	 * also embeds the token in the remote URL). A non-auth failure or a user
	 * cancellation propagates unchanged.
	 */
	private async cloneForAnalysis(input: {
		creds: queries.ResolvedRepoCredentials;
		clonePath: string;
		projectId: string;
		repositoryIntegrationId: string;
		abortSignal?: AbortSignal;
	}): Promise<{ commitSha: string; commitAt: Date | null }> {
		try {
			return await this.cloneRepo(
				input.creds,
				input.clonePath,
				input.abortSignal,
			);
		} catch (error) {
			// Never intercept a user "Cancel analysis" or a non-auth git failure.
			if (input.abortSignal?.aborted || !isGitAuthError(error)) {
				throw error;
			}
			logger.warn(
				"[atlas] clone authentication failed; attempting credential re-exchange",
				{ integrationId: input.repositoryIntegrationId },
			);

			// Self-heal: only a GitHub OAuth credential can be re-exchanged.
			if (input.creds.provider === "GITHUB") {
				const { refreshed } = await forceReExchangeRepoCredentials({
					integrationId: input.repositoryIntegrationId,
					userId: this.ctx.userId,
					organizationId: this.ctx.organizationId,
				});
				if (refreshed) {
					const refreshedCreds = await queries.resolveRepoCredentials(
						input.projectId,
						input.repositoryIntegrationId,
						{
							userId: this.ctx.userId,
							organizationId: this.ctx.organizationId,
						},
					);
					if (refreshedCreds) {
						// Re-clone the SAME branch with the freshly minted token.
						this.cleanupDir(input.clonePath);
						try {
							return await this.cloneRepo(
								{
									...refreshedCreds,
									branch: input.creds.branch,
								},
								input.clonePath,
								input.abortSignal,
							);
						} catch (retryError) {
							if (
								input.abortSignal?.aborted ||
								!isGitAuthError(retryError)
							) {
								throw retryError;
							}
							// Still unauthenticated after a real re-exchange —
							// fall through to the reconnect path below.
						}
					}
				}
			}

			// Unrecoverable: flag the integration reconnect-required (so the Atlas
			// tab shows the reconnect affordance and the configuring user is
			// notified) and raise a clean, actionable error.
			await markRepoReauthRequired({
				integrationId: input.repositoryIntegrationId,
				reason: "Repository authentication failed during analysis; re-authentication required.",
			});
			throw new AtlasError(
				"REPOSITORY_REAUTH_REQUIRED",
				REPO_REAUTH_MESSAGE,
			);
		}
	}

	/**
	 * Acquire the repo for analysis with a MINIMAL on-disk + on-wire footprint, so
	 * even a binary-heavy monorepo fits the worker's modest (~4 GiB) ephemeral disk
	 * with no resize:
	 *
	 *  1. BLOBLESS, shallow, single-branch, no-checkout clone
	 *     (`--depth 1 --single-branch --branch <b> --filter=blob:none
	 *     --no-checkout`). `--filter=blob:none` makes this a partial clone: only the
	 *     commit + tree objects arrive now (NO blobs, NO history), so the initial
	 *     download is tiny and `.git` stays small. The remote is recorded as a
	 *     "promisor" and individual blobs are back-filled lazily, on demand.
	 *  2. Enumerate every tracked path from the (already-present) trees (`ls-tree`,
	 *     no blob fetch) and select EXACTLY the files the parser reads (same
	 *     predicates as `collectFiles`).
	 *  3. Materialize ONLY those files via a CLIENT-SIDE non-cone sparse-checkout.
	 *     The `checkout` back-fills JUST the sparse-matched blobs from the promisor
	 *     remote — binaries, assets and vendored trees are never downloaded at all,
	 *     so both `.git` AND the working tree stay small.
	 *
	 * `--filter` is purely a DOWNLOAD/DISK choice, NOT an analysis-scope one: the
	 * sparse-checkout (unchanged) decides which files materialize, and the parser
	 * walks the WORKING TREE (never `.git`), so the analyzed file set — and the
	 * resulting graph — is byte-for-byte identical to a non-filtered or full
	 * checkout. Completeness depends only on the materialization COMPLETING.
	 *
	 * Robustness (all kept from the #1746 hardening, which was the real cure):
	 *  - Per-attempt unique clone dir (`makeClonePath`/`acquireRepoForAnalysis`) so
	 *    a retry/concurrent cleanup can't delete the tree a live `git` is using
	 *    (`fatal: Unable to read current working directory`) — the root cause #1746
	 *    fixed (dropping `--filter` was an over-correction, restored here).
	 *  - Bounded back-fill retry on the sparse `checkout` (below): the transient
	 *    promisor fetch errors (`invalid index-pack output`, `early EOF`,
	 *    `could not fetch from promisor remote`, `RPC failed`) clear on a quick
	 *    retry — recovering at the SMALL footprint instead of falling back early.
	 *  - Full-checkout fallback for the rare residual failure (it just uses more
	 *    disk; analysis still runs). Partial clone needs server support: GitHub,
	 *    GitLab and Azure DevOps allow it; Bitbucket does not (and self-hosted
	 *    GitLab gates it behind `uploadpack.allowFilter`). On an unsupporting server
	 *    git simply downloads all blobs at clone time (the filter is ignored) — or,
	 *    if a later back-fill fails, this fallback covers it — so analysis still
	 *    completes there, only without the disk savings.
	 *
	 * The result that `collectFiles` then walks off disk is identical to a full
	 * checkout (it just finds far fewer, exactly-wanted files). Commit metadata is
	 * read from the (present) commit/tree objects, so the return shape is unchanged.
	 */
	private async cloneRepo(
		creds: queries.ResolvedRepoCredentials,
		clonePath: string,
		abortSignal?: AbortSignal,
	): Promise<{ commitSha: string; commitAt: Date | null }> {
		const authUrl = buildAuthCloneUrl(
			creds.provider,
			creds.repositoryUrl,
			creds.token,
		);
		// `abort` plugin: simple-git kills the spawned git process when the
		// signal fires, so a cancelled analysis stops mid-clone/mid-fetch instead
		// of waiting for it to finish. Spread the option only when a signal is
		// present so the no-signal path keeps the original behaviour. Applied to
		// EVERY git invocation below so a "Cancel" kills whichever step is live.
		const gitOptions: Partial<SimpleGitOptions> = abortSignal
			? { abort: abortSignal }
			: {};
		const git = simpleGit(gitOptions);

		// (1) Blobless + shallow + single-branch + no-checkout. Only HEAD's commit +
		// tree objects arrive now (`--filter=blob:none` → partial clone, remote kept
		// as a promisor); NO blobs and NO history, so the initial download is tiny
		// and `.git` stays small. Blobs are back-filled lazily by the sparse-checkout
		// below. Nothing is materialized to the working tree yet (`--no-checkout`).
		await git.clone(authUrl, clonePath, [
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			creds.branch,
			"--filter=blob:none",
			"--no-checkout",
		]);

		const local = simpleGit(clonePath, gitOptions);

		// Commit metadata comes from the commit/tree objects (present in a blobless
		// clone), so it's resolved up-front and independent of which blobs we fetch.
		const commitSha = (await local.revparse(["HEAD"])).trim();
		let commitAt: Date | null = null;
		try {
			const iso = (
				await local.show(["-s", "--format=%cI", "HEAD"])
			).trim();
			if (iso) {
				commitAt = new Date(iso);
			}
		} catch {
			// best-effort commit timestamp
		}

		// (2) List every tracked path from the trees (no blob fetch) and keep only
		// the files the parser will read — reusing its predicates so the checkout
		// is exactly `collectFiles`' input set.
		const listed = await local.raw([
			"ls-tree",
			"-r",
			"--name-only",
			"HEAD",
		]);
		const wanted = listed
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map(normalizePath)
			.filter((p) => this.isWantedForAnalysis(p));

		// Edge case: nothing parseable in this repo. Skip the checkout entirely (no
		// blobs to fetch, no working tree to populate) and return commit info — the
		// downstream `collectFiles` walk just finds an empty tree.
		if (wanted.length === 0) {
			return { commitSha, commitAt };
		}

		// (3) Materialize ONLY the wanted files. Patterns can number in the
		// thousands (ARG_MAX), so enable non-cone sparse-checkout and write the
		// pattern file directly rather than passing paths on the command line.
		// Each pattern is an anchored, exact path (leading "/" + the repo-relative
		// path), which in non-cone (gitignore-style) mode matches just that one
		// file; git creates the parent directories automatically on checkout.
		try {
			await local.raw(["sparse-checkout", "init", "--no-cone"]);
			const sparseFile = path.join(
				clonePath,
				".git",
				"info",
				"sparse-checkout",
			);
			const patterns = wanted
				.map((p) => `/${escapeSparsePattern(p)}`)
				.join("\n");
			fs.writeFileSync(sparseFile, `${patterns}\n`, "utf-8");
			// Back-fill ONLY the sparse-matched blobs from the promisor remote. This
			// is the ONE network step of the blobless path, so a transient fetch blip
			// (`invalid index-pack output`, `early EOF`, `could not fetch ... from
			// promisor remote`, `RPC failed`) surfaces HERE, not at clone time —
			// bounded-retry it so we recover at the SMALL (blobless) footprint before
			// resorting to the (larger) full-checkout fallback. A non-transient error
			// is NOT retried (it drops straight to the fallback below); a cancellation
			// (`throwIfAborted`) is terminal and propagates.
			for (
				let attempt = 1;
				attempt <= SPARSE_CHECKOUT_MAX_ATTEMPTS;
				attempt++
			) {
				this.throwIfAborted(abortSignal);
				try {
					await local.raw(["checkout"]);
					break;
				} catch (checkoutError) {
					this.throwIfAborted(abortSignal);
					if (
						!isTransientBackfillError(checkoutError) ||
						attempt >= SPARSE_CHECKOUT_MAX_ATTEMPTS
					) {
						throw checkoutError;
					}
					logger.warn(
						"[atlas] sparse-checkout back-fill failed; retrying after backoff",
						{
							clonePath,
							attempt,
							maxAttempts: SPARSE_CHECKOUT_MAX_ATTEMPTS,
							error:
								checkoutError instanceof Error
									? checkoutError.message
									: String(checkoutError),
						},
					);
					await this.sleep(
						SPARSE_CHECKOUT_RETRY_BASE_DELAY_MS * attempt,
						abortSignal,
					);
				}
			}
		} catch (error) {
			// A user "Cancel analysis" must propagate, NOT trigger a (doomed) full
			// checkout — surface it before the fallback runs.
			this.throwIfAborted(abortSignal);
			// Robustness over optimization: if the sparse path still fails after the
			// bounded back-fill retry — sparse-checkout misbehaves on some unusual
			// repo/git, or the server doesn't support partial clone — fall back to a
			// full checkout so analysis still runs (it just uses more disk) rather
			// than failing outright. Disabling sparse first ensures the fallback
			// materializes the whole tree.
			logger.warn(
				"[atlas] sparse checkout failed; falling back to full checkout",
				{
					clonePath,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
			try {
				await local.raw(["sparse-checkout", "disable"]);
			} catch {
				// best-effort: ignore if sparse was never enabled
			}
			await local.raw(["checkout"]);
		}

		return { commitSha, commitAt };
	}

	private readFileBounded(abs: string, maxBytes: number): string | null {
		let size = 0;
		try {
			size = fs.statSync(abs).size;
		} catch {
			return null;
		}
		if (size > maxBytes) {
			return null;
		}
		try {
			return fs.readFileSync(abs, "utf-8");
		} catch {
			return null;
		}
	}

	/**
	 * One walk over the clone collecting three things:
	 *  - `sourcePaths`: repo-relative paths of analyzable source — fed to the
	 *    STREAMING graph builder, which reads/redacts each one's content on
	 *    demand (one file at a time) so total source content is NEVER held in
	 *    memory at once. Source content is therefore NOT retained here. To keep
	 *    the included set + `MAX_FILES` budget byte-identical to the old
	 *    materialising walk, each source file is still bounded-read here to decide
	 *    inclusion (an unreadable/oversized file is skipped and does NOT consume a
	 *    slot, exactly as before) — but the content is released immediately, so
	 *    only one file's content is ever live during collection too.
	 *  - `manifests`: dependency manifests → the tech stack (parsed for
	 *    name+version only; raw content is never persisted, so not redacted).
	 *    Small + bounded by the manifest filename set, so retained as before.
	 *  - `docs`: markdown (redacted) → attached to nodes + fed to business mode.
	 *    Bounded per file by `MAX_DOC_FILE_BYTES` and capped per module on use, so
	 *    retained as before.
	 */
	private collectFiles(root: string): {
		sourcePaths: string[];
		manifests: ManifestFile[];
		docs: DocFile[];
	} {
		const sourcePaths: string[] = [];
		const manifests: ManifestFile[] = [];
		const docs: DocFile[] = [];
		const walk = (dir: string): void => {
			if (sourcePaths.length >= MAX_FILES) {
				return;
			}
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = path.join(dir, entry.name);
				const rel = normalizePath(path.relative(root, abs));
				if (entry.isDirectory()) {
					if (isInSkippedDir(rel)) {
						continue;
					}
					walk(abs);
				} else if (entry.isFile()) {
					if (isAnalyzableSource(rel)) {
						if (sourcePaths.length >= MAX_FILES) {
							continue;
						}
						// Bounded-read only to decide inclusion + count toward the
						// MAX_FILES budget identically to the old walk; the content
						// is intentionally discarded — the streaming builder reads
						// it again (one file at a time) when it needs it.
						const content = this.readFileBounded(
							abs,
							MAX_ANALYZED_FILE_BYTES,
						);
						if (content === null) {
							continue;
						}
						sourcePaths.push(rel);
					} else if (isManifestPath(rel)) {
						const content = this.readFileBounded(
							abs,
							MAX_ANALYZED_FILE_BYTES,
						);
						if (content !== null) {
							manifests.push({ path: rel, content });
						}
					} else if (MARKDOWN_EXT.test(rel)) {
						const content = this.readFileBounded(
							abs,
							MAX_DOC_FILE_BYTES,
						);
						if (content !== null) {
							docs.push({
								path: rel,
								content: redactSecrets(content).redacted,
							});
						}
					}
				}
			}
		};
		walk(root);
		return { sourcePaths, manifests, docs };
	}

	/**
	 * Group collected markdown under the module it belongs to (by directory at the
	 * graph's module depth), concatenated + capped. README files sort first so a
	 * module's overview leads. Keys that don't match a real module node are simply
	 * never applied by `persistTechnicalGraph`.
	 */
	private mapDocsToModules(
		docs: DocFile[],
		moduleDepth: number,
	): Map<string, string> {
		const isReadme = (p: string): boolean =>
			/(?:^|\/)readme\.[^/]+$/i.test(p);
		const ordered = [...docs].sort((a, b) => {
			const ar = isReadme(a.path) ? 0 : 1;
			const br = isReadme(b.path) ? 0 : 1;
			return ar - br || a.path.localeCompare(b.path);
		});
		const byModule = new Map<string, string[]>();
		for (const doc of ordered) {
			const moduleKey = moduleKeyAtDepth(doc.path, moduleDepth);
			const arr = byModule.get(moduleKey) ?? [];
			arr.push(`<!-- ${doc.path} -->\n${doc.content.trim()}`);
			byModule.set(moduleKey, arr);
		}
		const out = new Map<string, string>();
		for (const [moduleKey, parts] of byModule) {
			const joined = parts.join("\n\n").slice(0, MAX_MODULE_DOC_CHARS);
			if (joined.trim().length > 0) {
				out.set(moduleKey, joined);
			}
		}
		return out;
	}

	private cleanupDir(dir: string): void {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			logger.warn("[atlas] failed to clean clone dir", {
				dir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
