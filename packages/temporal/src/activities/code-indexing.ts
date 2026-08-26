/**
 * Code Indexing Activities
 *
 * Temporal activities for the code indexing workflow (Phase 2).
 * Handles: shallow clone, secret scan, AST chunking, embedding,
 * Qdrant upsert, file summary generation, and cleanup.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	updateCodeIndexProgress,
	updateCodeIndexStats,
	updateCodeIndexStatus,
	upsertProjectCodeIndex,
} from "@repo/database";
import {
	buildAuthCloneUrl,
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
	resolveFreshRepoToken,
} from "@repo/integrations/repo-auth";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { SimpleGit } from "simple-git";
import {
	JOB_SOURCE,
	JOB_STEPS,
	jobComplete,
	jobEnsure,
	jobFail,
	jobHeartbeat,
	jobIncrement,
	jobSetCounts,
	jobStep,
	seedJobSteps,
} from "./lib/job-progress";

/**
 * Throw a non-retryable ApplicationFailure for errors that should not be retried.
 * (auth failures, repo not found, invalid input, etc.)
 */
function nonRetryable(message: string, type?: string): never {
	throw ApplicationFailure.nonRetryable(message, type ?? "NON_RETRYABLE");
}

/**
 * Strip credentials from any clone URL embedded in a message before it is
 * thrown / persisted. Git echoes the full `//user:token@host` URL in some fatal
 * messages (e.g. repository-not-found), which would otherwise land in the DB,
 * Temporal history, and worker logs.
 */
export function redactCloneUrl(message: string): string {
	return message.replace(/\/\/[^@\s]*@/g, "//***@");
}

/**
 * Classify git clone errors as retryable or non-retryable.
 */
function classifyCloneError(error: unknown): never {
	const msg = redactCloneUrl(
		error instanceof Error ? error.message : String(error),
	);
	// Auth failures
	if (
		msg.includes("Authentication failed") ||
		msg.includes("401") ||
		msg.includes("403") ||
		msg.includes("could not read Username")
	) {
		nonRetryable(`Authentication failed: ${msg}`, "AUTH_FAILURE");
	}
	// Repo not found
	if (
		msg.includes("not found") ||
		msg.includes("404") ||
		msg.includes("does not exist") ||
		msg.includes("Repository not found")
	) {
		nonRetryable(`Repository not found: ${msg}`, "NOT_FOUND");
	}
	// Branch not found
	if (msg.includes("Remote branch") && msg.includes("not found")) {
		nonRetryable(`Branch not found: ${msg}`, "BRANCH_NOT_FOUND");
	}
	// Invalid URL
	if (msg.includes("Invalid URL") || msg.includes("ERR_INVALID_URL")) {
		nonRetryable(`Invalid repository URL: ${msg}`, "INVALID_INPUT");
	}
	// Everything else is retryable (network timeouts, transient failures)
	throw error;
}

/** True when a clone failed because the requested branch does not exist. */
function isBranchNotFoundError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.includes("Remote branch") && msg.includes("not found");
}

/**
 * Parse a repo's default branch out of `git ls-remote --symref <url> HEAD`
 * output, e.g. `ref: refs/heads/master\tHEAD`. Returns null if not present.
 */
export function parseDefaultBranchFromSymref(output: string): string | null {
	const match = output.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
	return match?.[1] ?? null;
}

/**
 * Resolve a repository's real default branch via `git ls-remote --symref`, so
 * we never assume "main" (a master-default repo would 404 on `--branch main`).
 * Falls back to "main" only if the lookup itself fails.
 */
async function resolveDefaultBranch(
	git: SimpleGit,
	authUrl: string,
): Promise<string> {
	try {
		const output = await git.listRemote(["--symref", authUrl, "HEAD"]);
		const branch = parseDefaultBranchFromSymref(output);
		if (branch) {
			return branch;
		}
	} catch {
		// Deliberately not logging the error: a simple-git failure message can
		// embed the token-bearing clone URL. Fall back to the conventional default.
		logger.warn(
			"[CodeIndexing] Could not resolve default branch via ls-remote; falling back to main.",
		);
	}
	return "main";
}

/** Shallow, single-branch clone of one branch. */
async function cloneBranch(
	git: SimpleGit,
	authUrl: string,
	clonePath: string,
	branch: string,
): Promise<void> {
	await git.clone(authUrl, clonePath, [
		"--depth",
		"1",
		"--single-branch",
		"--branch",
		branch,
	]);
}

// =============================================================================
// Types
// =============================================================================

export interface CloneRepositoryInput {
	repositoryUrl: string;
	branch?: string;
	token: string;
	provider: "GITHUB" | "AZURE_DEVOPS" | "GITLAB";
	workflowRunId: string;
	/** Pin clone to a specific commit (for continuation consistency) */
	commitSha?: string;
	/**
	 * Project-repo integration coordinates. When present, the clone proactively
	 * refreshes a near-expiry OAuth token and self-heals a mid-clone auth failure
	 * via a forced re-exchange + retry before failing reconnect-required.
	 */
	integrationId?: string;
	projectId?: string;
	userId?: string;
	organizationId?: string | null;
}

export interface CloneRepositoryOutput {
	clonePath: string;
	commitSha: string;
	branch: string;
}

export interface ScanForSecretsInput {
	clonePath: string;
}

export interface ScanForSecretsOutput {
	secretsFound: number;
	redactionManifest: Array<{ path: string; type: string; count: number }>;
}

export interface WalkFileTreeInput {
	clonePath: string;
}

export interface WalkFileTreeOutput {
	/**
	 * Legacy: the full walked file list. Only present on results recorded before
	 * the on-disk-manifest patch; new runs write the manifest to disk and return
	 * only `manifestPath`. Kept optional so the workflow's pre-patch replay branch
	 * can still read it. Do NOT populate on new runs — a full file list on a large
	 * repo blows past Temporal's per-payload size limit.
	 */
	files?: Array<{
		relativePath: string;
		absolutePath: string;
		sizeBytes: number;
		language: string | null;
	}>;
	/**
	 * Path to the on-disk file manifest (a sibling of the clone dir). New runs
	 * iterate it by index via `readFileManifestSliceActivity` so no file list ever
	 * crosses the workflow boundary. Absent on legacy replay results.
	 */
	manifestPath?: string;
	totalFiles: number;
	skippedFiles: number;
}

/** One entry in the on-disk file manifest. absolutePath is reconstructed on read. */
interface FileManifestDiskEntry {
	relativePath: string;
	language: string | null;
}

/** A manifest slice hydrated with a reconstructed absolutePath, for activities. */
export interface FileManifestEntry {
	relativePath: string;
	absolutePath: string;
	language: string | null;
}

export interface ReadFileManifestSliceInput {
	manifestPath: string;
	/** Clone dir the manifest was walked from — absolutePath is derived from it. */
	clonePath: string;
	startIndex: number;
	count: number;
}

export interface SelectChangedFilesFromManifestInput {
	manifestPath: string;
	clonePath: string;
	changedFiles: string[];
}

export interface SelectChangedFilesFromManifestOutput {
	/** On-disk manifest of just the changed indexable files. */
	manifestPath: string;
	count: number;
}

export interface CodeIndexBatchInput {
	files: Array<{ relativePath: string; absolutePath: string }>;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	repoName: string;
	/** Repository integration this batch belongs to (null = default repo). */
	repositoryIntegrationId?: string | null;
	/** Override embedding model from project RAG settings (e.g., "VOYAGE_CODE_3") */
	codeEmbeddingModel?: string | null;
	/**
	 * Live-progress inputs (embed loop only, replay-safe additive fields). The
	 * branch keys the ProjectCodeIndex row; `filesProcessedSoFar` + this batch's
	 * file count is written as `indexedFileCount` after embedding, against
	 * `totalFileCount`. Absent (undefined) on the legacy path and other callers,
	 * where the progress write is skipped.
	 */
	branch?: string;
	filesProcessedSoFar?: number;
	totalFileCount?: number;
}

export interface ChunkAndEmbedBatchOutput {
	chunksCreated: number;
	filesProcessed: number;
	errors: string[];
}

export interface GenerateFileSummariesOutput {
	summariesCreated: number;
	errors: string[];
}

/** @deprecated Use CodeIndexBatchInput */
export type ChunkAndEmbedBatchInput = CodeIndexBatchInput;
/** @deprecated Use CodeIndexBatchInput */
export type GenerateFileSummariesInput = CodeIndexBatchInput;

export interface UpdateCodeIndexInput {
	projectId: string;
	repositoryIntegrationId?: string | null;
	branch?: string;
	userId: string;
	organizationId?: string | null;
	commitSha: string;
	filesIndexed: number;
	chunksCreated: number;
	summariesCreated: number;
	indexDurationMs: number;
	/**
	 * Precomputed manifest (legacy path). Ignored when `manifestPath` is set —
	 * the activity then reads the on-disk manifest instead, so the file list
	 * never crosses the payload boundary.
	 */
	fileManifest?: Array<{
		path: string;
		sha: string;
		language: string | null;
	}>;
	/** On-disk manifest to build fileManifest from (new path). */
	manifestPath?: string;
	redactionManifest?: Array<{ path: string; type: string; count: number }>;
	workflowId?: string;
	/** Incremental run — preserve index totals, stamp lastIncrementalAt. */
	incremental?: boolean;
}

export interface CleanupCloneDirInput {
	clonePath: string;
}

/**
 * Deterministic context id for a code vector. Folding the repository integration
 * id in keeps two repos that share a file path from colliding on the same Qdrant
 * point id. Legacy rows (null integration — the project's default repo) keep the
 * original id shape so their existing vectors stay addressable.
 */
function codeContextId(
	kind: "code" | "code-summary",
	projectId: string,
	repositoryIntegrationId: string | null | undefined,
	relativePath: string,
	chunkIndex = 0,
): string {
	const repoSegment = repositoryIntegrationId
		? `${repositoryIntegrationId}:`
		: "";
	const suffix = kind === "code" ? `:${chunkIndex}` : "";
	return `${kind}:${projectId}:${repoSegment}${relativePath}${suffix}`;
}

// =============================================================================
// File filtering
// =============================================================================

const MAX_FILE_SIZE = 500 * 1024; // 500KB

const SKIP_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".ico",
	".bmp",
	".webp",
	".mp3",
	".mp4",
	".wav",
	".avi",
	".mov",
	".pdf",
	".zip",
	".tar",
	".gz",
	".rar",
	".7z",
	".exe",
	".dll",
	".so",
	".dylib",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".min.js",
	".min.css",
	".map",
	".lock",
	".sum",
]);

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"__pycache__",
	".venv",
	"venv",
	"vendor",
	"target",
	".idea",
	".vscode",
	"coverage",
	".turbo",
]);

function detectLanguageFromExt(ext: string): string | null {
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".mjs": "javascript",
		".cjs": "javascript",
		".py": "python",
		".rs": "rust",
		".go": "go",
		".java": "java",
		".rb": "ruby",
		".php": "php",
		".cs": "csharp",
		".cpp": "cpp",
		".c": "c",
		".h": "c",
		".hpp": "cpp",
		".swift": "swift",
		".kt": "kotlin",
		".scala": "scala",
		".sh": "bash",
		".yaml": "yaml",
		".yml": "yaml",
		".json": "json",
		".toml": "toml",
		".md": "markdown",
		".sql": "sql",
		".css": "css",
		".scss": "scss",
		".html": "html",
		".vue": "vue",
		".svelte": "svelte",
		".prisma": "prisma",
		".graphql": "graphql",
		".proto": "protobuf",
		".tf": "terraform",
	};
	return map[ext] ?? null;
}

function shouldSkipFile(relativePath: string, sizeBytes: number): boolean {
	if (sizeBytes > MAX_FILE_SIZE || sizeBytes === 0) {
		return true;
	}

	const ext = path.extname(relativePath).toLowerCase();
	if (SKIP_EXTENSIONS.has(ext)) {
		return true;
	}

	const parts = relativePath.split("/");
	for (const part of parts) {
		if (SKIP_DIRS.has(part)) {
			return true;
		}
	}

	const filename = path.basename(relativePath);
	if (
		filename.startsWith(".") &&
		!filename.startsWith(".env") &&
		filename !== ".gitignore"
	) {
		return true;
	}

	return false;
}

// =============================================================================
// Shared helpers
// =============================================================================

/** Context types for code index vectors. */
const CODE_CONTEXT_TYPES = ["CODE_FILE", "CODE_FILE_SUMMARY"] as const;

/** Walk a directory tree, calling `onFile` for each non-skipped file. */
export function walkDirWith(
	rootDir: string,
	onFile: (fullPath: string, relativePath: string, entry: fs.Dirent) => void,
): void {
	function walk(dir: string, basePath: string) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}
			const fullPath = path.join(dir, entry.name);
			const relativePath = path.join(basePath, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) {
					walk(fullPath, relativePath);
				}
			} else if (entry.isFile()) {
				onFile(fullPath, relativePath, entry);
			}
		}
	}
	walk(rootDir, "");
}

/** Build a Qdrant point vector respecting hybrid (dense+sparse) layout. */
function buildVector(
	layout: {
		supportsHybrid: boolean;
		denseVectorName: string | null;
		sparseVectorName: string | null;
	},
	embedding: number[],
	sparse: { indices: number[]; values: number[] },
):
	| number[]
	| Record<string, number[] | { indices: number[]; values: number[] }> {
	if (layout.supportsHybrid && layout.denseVectorName) {
		return {
			[layout.denseVectorName]: embedding,
			[layout.sparseVectorName ?? "sparse"]: sparse,
		};
	}
	return embedding;
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Clone a repository using simple-git (shallow, single-branch).
 */
export async function cloneRepositoryActivity(
	input: CloneRepositoryInput,
): Promise<CloneRepositoryOutput> {
	const { repositoryUrl, branch, provider, workflowRunId } = input;
	const simpleGit = (await import("simple-git")).default;

	// Job Hub step tracking. Every code-indexing activity targets "the open row
	// of this workflow" without naming a source: the workflow id already encodes
	// the repo (`code-index-{project}-{integration}`), so there is exactly one.
	// On continueAsNew the clone re-runs against the same row and the step is
	// simply re-marked — `running` keeps its original start time.
	await jobStep("clone", "running");

	const clonePath = path.join(
		os.tmpdir(),
		`fabric-code-index-${workflowRunId}`,
	);

	// One clone attempt with a given plaintext token. Re-invoked once with a
	// freshly re-exchanged token when the first attempt fails with a git auth
	// error, so a token that died since it was minted can self-heal in place.
	const doClone = async (token: string): Promise<CloneRepositoryOutput> => {
		if (fs.existsSync(clonePath)) {
			fs.rmSync(clonePath, { recursive: true, force: true });
		}

		// `buildAuthCloneUrl` owns the per-provider basic-auth convention
		// (GitHub: x-access-token, GitLab: oauth2, Azure DevOps: pat).
		const authUrl = buildAuthCloneUrl(provider, repositoryUrl, token);

		const git = simpleGit();

		// Resolve the repo's real default branch when none was given, instead of
		// assuming "main" (a master-default repo would 404 on `--branch main`).
		const targetBranch =
			branch || (await resolveDefaultBranch(git, authUrl));

		logger.info(
			`[CodeIndexing] Cloning ${repositoryUrl} (branch: ${targetBranch}) to ${clonePath}`,
		);

		if (input.commitSha) {
			// Continuation: fetch the exact commit to ensure all batches index the same revision
			try {
				Context.current().heartbeat(
					`fetching commit ${input.commitSha.slice(0, 8)}`,
				);
				fs.mkdirSync(clonePath, { recursive: true });
				const localGit = simpleGit(clonePath);
				await localGit.init();
				await localGit.addRemote("origin", authUrl);
				await localGit.fetch([
					"--depth",
					"1",
					"origin",
					input.commitSha,
				]);
				await localGit.checkout("FETCH_HEAD");
			} catch (error) {
				classifyCloneError(error);
			}

			logger.info(
				`[CodeIndexing] Fetched pinned commit ${input.commitSha.slice(0, 8)} to ${clonePath}`,
			);
			return {
				clonePath,
				commitSha: input.commitSha,
				branch: targetBranch,
			};
		}

		// First run: shallow clone the branch head. If the requested branch doesn't
		// exist (e.g. a stale "main" stored for a master-default repo), fall back to
		// the repo's real default branch and retry once.
		let effectiveBranch = targetBranch;
		try {
			Context.current().heartbeat("cloning");
			await cloneBranch(git, authUrl, clonePath, effectiveBranch);
		} catch (error) {
			// Only a missing branch is worth retrying — auth/network/not-found
			// surface immediately (classifyCloneError throws).
			if (!isBranchNotFoundError(error)) {
				classifyCloneError(error);
			}
			// Stale stored branch (e.g. "main" for a master-default repo): resolve
			// the repo's real default and retry once.
			const fallback = await resolveDefaultBranch(git, authUrl);
			if (fallback === effectiveBranch) {
				classifyCloneError(error);
			}
			logger.warn(
				`[CodeIndexing] Branch '${effectiveBranch}' not found; retrying with default '${fallback}'`,
			);
			if (fs.existsSync(clonePath)) {
				fs.rmSync(clonePath, { recursive: true, force: true });
			}
			effectiveBranch = fallback;
			try {
				await cloneBranch(git, authUrl, clonePath, effectiveBranch);
			} catch (retryError) {
				classifyCloneError(retryError);
			}
		}

		Context.current().heartbeat("reading commit");
		const localGit = simpleGit(clonePath);
		const log = await localGit.log({ maxCount: 1 });
		const resolvedCommitSha = log.latest?.hash ?? "unknown";

		logger.info(
			`[CodeIndexing] Cloned successfully. Commit: ${resolvedCommitSha.slice(0, 8)}`,
		);

		return {
			clonePath,
			commitSha: resolvedCommitSha,
			branch: effectiveBranch,
		};
	};

	// Proactively resolve a fresh token before cloning: a GitHub/GitLab OAuth
	// token can lapse between when the workflow captured it and when the clone
	// actually runs. `resolveFreshRepoToken` refreshes a near-expiry token (or
	// returns the current one) and is scoped to the project.
	let token = input.token;
	if (input.integrationId && input.projectId) {
		const fresh = await resolveFreshRepoToken({
			integrationId: input.integrationId,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		if (fresh.token) {
			token = fresh.token;
		}
	}
	if (!token) {
		nonRetryable("No repository token available", "AUTH_FAILURE");
	}

	try {
		const cloned = await doClone(token);
		await jobStep("clone", "completed");
		return cloned;
	} catch (error) {
		// Self-heal a git auth failure: the token was dead despite reading valid.
		// Force a real OAuth re-exchange, then retry the clone once with the fresh
		// token. If it still fails (or can't refresh), flag reconnect-required and
		// surface a clean, actionable error instead of a raw git failure.
		if (input.integrationId && input.projectId && isGitAuthError(error)) {
			const { refreshed } = await forceReExchangeRepoCredentials({
				integrationId: input.integrationId,
				userId: input.userId ?? "",
				organizationId: input.organizationId,
			});
			if (refreshed) {
				const fresh = await resolveFreshRepoToken({
					integrationId: input.integrationId,
					projectId: input.projectId,
					userId: input.userId,
					organizationId: input.organizationId,
				});
				if (fresh.token) {
					try {
						const cloned = await doClone(fresh.token);
						await jobStep("clone", "completed");
						return cloned;
					} catch {
						// Fall through to reconnect-required — the re-exchanged token
						// still couldn't clone.
					}
				}
			}
			await markRepoReauthRequired({
				integrationId: input.integrationId,
				reason: "Repository authentication failed during code indexing; reconnect required.",
			});
			await jobStep("clone", "failed", {
				error: "Authentication failed — reconnect the repository to retry.",
			});
			nonRetryable(
				"Repository authentication failed — reconnect the repository in Settings, then re-run.",
				"REAUTH_REQUIRED",
			);
		}
		throw error;
	}
}

/**
 * Scan cloned repo for secrets using pattern matching.
 * Redacts detected secrets with [REDACTED] placeholders in-place.
 */
export async function scanForSecretsActivity(
	input: ScanForSecretsInput,
): Promise<ScanForSecretsOutput> {
	const { clonePath } = input;
	const redactionManifest: Array<{
		path: string;
		type: string;
		count: number;
	}> = [];
	let totalSecrets = 0;

	const SECRET_PATTERNS = [
		{ name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/g },
		{
			name: "Generic Secret",
			pattern:
				/(?:secret|password|token|api_key|apikey)[\s]*[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
		},
		{
			name: "Private Key",
			pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
		},
		{ name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
		// GitLab tokens — three families per GitLab docs:
		//   glpat-  : personal access tokens
		//   glptt-  : project / group access tokens (since GitLab 15.x)
		//   GR1348941… : runner registration tokens (legacy + 16.x)
		{ name: "GitLab PAT", pattern: /glpat-[A-Za-z0-9_-]{20,}/g },
		{ name: "GitLab Project Token", pattern: /glptt-[A-Za-z0-9_-]{20,}/g },
		{
			name: "GitLab Runner Token",
			pattern: /GR1348941[A-Za-z0-9_-]{20,}/g,
		},
	];

	function scanFile(filePath: string, relativePath: string) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			let modified = content;
			let fileSecrets = 0;

			for (const { pattern } of SECRET_PATTERNS) {
				const matches = content.match(pattern);
				if (matches) {
					fileSecrets += matches.length;
					modified = modified.replace(pattern, "[REDACTED]");
				}
			}

			if (fileSecrets > 0) {
				fs.writeFileSync(filePath, modified, "utf-8");
				redactionManifest.push({
					path: relativePath,
					type: "secret",
					count: fileSecrets,
				});
				totalSecrets += fileSecrets;
			}
		} catch {
			// Skip binary files or read errors
		}
	}

	Context.current().heartbeat("scanning for secrets");
	walkDirWith(clonePath, (fullPath, relativePath) => {
		const ext = path.extname(relativePath).toLowerCase();
		if (!SKIP_EXTENSIONS.has(ext)) {
			scanFile(fullPath, relativePath);
		}
	});

	logger.info(
		`[CodeIndexing] Secret scan: ${totalSecrets} secrets found and redacted in ${redactionManifest.length} files`,
	);
	await jobStep("secretScan", "completed");
	return { secretsFound: totalSecrets, redactionManifest };
}

/**
 * Where the on-disk file manifest lives for a given clone. A *sibling* of the
 * clone dir (not inside it), so a re-walk after continueAsNew never picks it up
 * as an indexable file. `walkDirWith` starts at `clonePath`, so its parent's
 * entries are never visited.
 */
function codeIndexManifestPath(clonePath: string): string {
	return `${clonePath}.code-index-manifest.json`;
}

/**
 * Where the incremental changed-subset manifest lives — a sibling of the clone
 * dir, like the full manifest. The embed/summary phases iterate it by index so
 * even a mass-change push never returns a file list over the payload limit.
 */
function codeIndexChangedManifestPath(clonePath: string): string {
	return `${clonePath}.code-index-changed-manifest.json`;
}

/** Persist the walked manifest and return its path. */
function writeFileManifest(
	clonePath: string,
	entries: FileManifestDiskEntry[],
): string {
	const manifestPath = codeIndexManifestPath(clonePath);
	fs.writeFileSync(manifestPath, JSON.stringify(entries));
	return manifestPath;
}

// Single-entry read-through cache. Within a run every slice read hits the same
// immutable manifest (its path embeds the run-id-derived clone dir and it is
// written exactly once), so caching the last-parsed one turns ~O(files/BATCH)
// re-parses of a multi-MB JSON into O(1). Bounded to one manifest per worker
// process; callers never mutate the returned array.
let lastReadManifest: {
	path: string;
	entries: FileManifestDiskEntry[];
} | null = null;

/** Read the full on-disk manifest (memoised on its path). */
function readFileManifest(manifestPath: string): FileManifestDiskEntry[] {
	if (lastReadManifest?.path === manifestPath) {
		return lastReadManifest.entries;
	}
	const entries = JSON.parse(
		fs.readFileSync(manifestPath, "utf8"),
	) as FileManifestDiskEntry[];
	lastReadManifest = { path: manifestPath, entries };
	return entries;
}

/**
 * Reconstruct a manifest entry's absolute path from the clone dir. On the Linux
 * workers `path.join(clonePath, "a/b.ts")` reproduces the walk's original
 * `fullPath` exactly (relativePath is already forward-slashed).
 */
function hydrateManifestEntry(
	clonePath: string,
	entry: FileManifestDiskEntry,
): FileManifestEntry {
	return {
		relativePath: entry.relativePath,
		absolutePath: path.join(clonePath, entry.relativePath),
		language: entry.language,
	};
}

/**
 * Walk the file tree, write the indexable-file manifest to disk, and return only
 * counts + the manifest path. The workflow iterates the manifest by index (via
 * `readFileManifestSliceActivity`) so a large repo's file list never crosses the
 * Temporal payload boundary.
 */
export async function walkFileTreeActivity(
	input: WalkFileTreeInput,
): Promise<WalkFileTreeOutput> {
	const { clonePath } = input;
	const entries: FileManifestDiskEntry[] = [];
	let skippedFiles = 0;

	walkDirWith(clonePath, (fullPath, relativePath) => {
		// Canonicalize to forward slashes so the stored path matches the GitHub
		// webhook's `changedFiles` (used by incremental selection + purge) and
		// the SKIP_DIRS "/" split — on any host OS. No-op on the Linux workers;
		// fixes native-Windows dev where path.join yields backslashes.
		const relPath = relativePath.split(path.sep).join("/");
		const stats = fs.lstatSync(fullPath);
		if (shouldSkipFile(relPath, stats.size)) {
			skippedFiles++;
			return;
		}
		const ext = path.extname(relPath).toLowerCase();
		entries.push({
			relativePath: relPath,
			language: detectLanguageFromExt(ext),
		});
	});

	const manifestPath = writeFileManifest(clonePath, entries);

	logger.info(
		`[CodeIndexing] File tree: ${entries.length} indexable files, ${skippedFiles} skipped`,
	);
	// Job Hub: publish the denominator now, so the panel can show
	// "120/3400 files" from the very first embed batch rather than a bare count.
	await jobStep("walk", "completed");
	await jobSetCounts({ totalFiles: entries.length });
	return { manifestPath, totalFiles: entries.length, skippedFiles };
}

/**
 * Return one slice of the on-disk manifest, hydrated with absolute paths. The
 * workflow calls this per batch so only ~BATCH_SIZE files ever cross the payload
 * boundary at a time.
 */
export async function readFileManifestSliceActivity(
	input: ReadFileManifestSliceInput,
): Promise<{ files: FileManifestEntry[] }> {
	const entries = readFileManifest(input.manifestPath);
	const slice = entries.slice(
		input.startIndex,
		input.startIndex + input.count,
	);
	return {
		files: slice.map((e) => hydrateManifestEntry(input.clonePath, e)),
	};
}

/**
 * The subset of the manifest to (re)embed on an incremental run: entries whose
 * repository-relative path is in the changed set. Mirrors `selectChangedFiles`
 * (order-preserving) but writes the subset to its own on-disk manifest and
 * returns only a path + count, so the workflow can iterate it by index — even a
 * mass-change push never crosses the payload boundary.
 */
export async function selectChangedFilesFromManifestActivity(
	input: SelectChangedFilesFromManifestInput,
): Promise<SelectChangedFilesFromManifestOutput> {
	const entries = readFileManifest(input.manifestPath);
	const changed = new Set(input.changedFiles);
	const subset = entries.filter((e) => changed.has(e.relativePath));
	const manifestPath = codeIndexChangedManifestPath(input.clonePath);
	fs.writeFileSync(manifestPath, JSON.stringify(subset));
	return { manifestPath, count: subset.length };
}

/**
 * Run `task` over `items` with at most `limit` in flight at once. `shouldStop`
 * lets a fail-fast caller (e.g. a non-retryable config error) stop idle workers
 * from pulling further items. Order of completion is not guaranteed; the caller
 * accumulates results in shared state (safe because JS is single-threaded).
 */
export async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<void>,
	shouldStop: () => boolean = () => false,
): Promise<void> {
	let cursor = 0;
	async function worker(): Promise<void> {
		while (!shouldStop()) {
			const idx = cursor++;
			if (idx >= items.length) {
				return;
			}
			await task(items[idx]);
		}
	}
	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Chunk a batch of files using AST-aware chunking and embed + upsert to Qdrant.
 */
export async function chunkAndEmbedBatchActivity(
	input: ChunkAndEmbedBatchInput,
): Promise<ChunkAndEmbedBatchOutput> {
	const {
		files,
		projectId,
		repositoryIntegrationId,
		userId,
		organizationId,
		repoName,
		codeEmbeddingModel,
	} = input;

	// Mark progress at the START of every attempt, not just on success. This
	// activity may be retried up to 5 times at 15 minutes each, and the counts
	// are only written when a batch finishes — without a heartbeat here, a
	// retrying batch looks dead to the watchdog for over an hour.
	await jobStep("embed", "running", {
		sourceId: repositoryIntegrationId ?? null,
	});
	await jobHeartbeat(repositoryIntegrationId ?? null);
	const errors: string[] = [];
	let totalChunks = 0;

	if (codeEmbeddingModel && codeEmbeddingModel !== "TEXT_EMBEDDING_3_SMALL") {
		// TODO: Wire up per-call model override once @repo/ai supports it.
		// For now, the tenant's default embedding model is used.
		logger.warn(
			`[CodeIndexing] Project requests code embedding model ${codeEmbeddingModel}, but per-call model override is not yet supported. Using tenant default.`,
		);
	}

	const { chunkCodeFile, isAstChunkable, applyContextualRetrieval } =
		await import("@repo/rag/lib/chunking/code-chunker");
	const { generateEmbeddings } = await import("@repo/rag/lib/embedding");
	const { generateSparseVector } = await import(
		"@repo/rag/lib/embedding/sparse"
	);
	const { getCollectionLayout, getCollectionName } = await import(
		"@repo/rag/lib/collection-manager"
	);
	const { qdrantClient } = await import(
		"@repo/rag/lib/project-contexts/client"
	);
	const { generatePointId } = await import("@repo/rag/lib/utils");

	// getCollectionLayout calls ensureCollection internally
	const layout = await getCollectionLayout(
		"project-contexts",
		organizationId,
	);
	const collectionName = getCollectionName(
		"project-contexts",
		organizationId,
	);
	const tenantContext = {
		userId,
		organizationId: organizationId ?? undefined,
	};

	let filesProcessedSoFar = 0;
	// A config error (bad creds / missing embedding model) is deterministic —
	// every file would hit it — so the first one aborts the whole batch.
	let aborted = false;

	async function processFile(file: (typeof files)[number]): Promise<void> {
		try {
			// Heartbeat after each file so Temporal knows we're alive
			Context.current().heartbeat(
				`chunking file ${++filesProcessedSoFar}/${files.length}: ${file.relativePath}`,
			);

			const sourceCode = fs.readFileSync(file.absolutePath, "utf-8");
			if (!sourceCode.trim()) {
				return;
			}

			const textsToEmbed: string[] = [];
			const pointPayloads: Array<Record<string, unknown>> = [];

			if (isAstChunkable(file.relativePath)) {
				const chunks = await chunkCodeFile(
					file.relativePath,
					sourceCode,
				);
				if (chunks.length === 0) {
					return;
				}

				for (const chunk of chunks) {
					const textForEmbedding = applyContextualRetrieval(
						chunk.contextualizedContent,
						file.relativePath,
						repoName,
					);

					textsToEmbed.push(textForEmbedding);
					pointPayloads.push({
						contextId: codeContextId(
							"code",
							projectId,
							repositoryIntegrationId,
							file.relativePath,
							chunk.index,
						),
						projectId,
						repositoryIntegrationId:
							repositoryIntegrationId ?? null,
						userId,
						organizationId: organizationId ?? null,
						contextType: "CODE_FILE",
						type: "CODE_FILE",
						content: chunk.content,
						filePath: file.relativePath,
						language: chunk.codeMetadata.language,
						symbolName: chunk.codeMetadata.symbolName ?? null,
						symbolType: chunk.codeMetadata.symbolType ?? null,
						chunkIndex: chunk.index,
						entities: chunk.codeMetadata.entities,
						scopeChain: chunk.codeMetadata.scopeChain,
						createdAt: new Date().toISOString(),
					});
				}
			} else {
				const ext = path.extname(file.relativePath).toLowerCase();
				const lang = detectLanguageFromExt(ext) ?? "text";
				const textForEmbedding = applyContextualRetrieval(
					sourceCode.slice(0, 8000),
					file.relativePath,
					repoName,
				);

				textsToEmbed.push(textForEmbedding);
				pointPayloads.push({
					contextId: codeContextId(
						"code",
						projectId,
						repositoryIntegrationId,
						file.relativePath,
						0,
					),
					projectId,
					repositoryIntegrationId: repositoryIntegrationId ?? null,
					userId,
					organizationId: organizationId ?? null,
					contextType: "CODE_FILE",
					type: "CODE_FILE",
					content: sourceCode.slice(0, 8000),
					filePath: file.relativePath,
					language: lang,
					symbolName: null,
					symbolType: null,
					chunkIndex: 0,
					createdAt: new Date().toISOString(),
				});
			}

			if (textsToEmbed.length === 0) {
				return;
			}

			const embeddingResult = await generateEmbeddings(
				textsToEmbed,
				tenantContext,
			);

			const points = embeddingResult.embeddings.map(
				(embedding: number[], i: number) => {
					const payload = pointPayloads[i];
					const pointId = generatePointId(
						payload.contextId as string,
					);
					const sparse = generateSparseVector(
						(payload.content as string) ?? "",
					);
					return {
						id: pointId,
						vector: buildVector(layout, embedding, sparse),
						payload,
					};
				},
			);

			for (let i = 0; i < points.length; i += 100) {
				const batch = points.slice(i, i + 100);
				await qdrantClient.upsert(collectionName, {
					wait: true,
					points: batch,
				});
			}

			totalChunks += points.length;
		} catch (error) {
			const errMsg =
				error instanceof Error ? error.message : String(error);
			// Non-retryable: embedding API auth failure or missing config
			if (
				errMsg.includes("API key") ||
				errMsg.includes("Unauthorized") ||
				errMsg.includes("Configure an embedding model")
			) {
				aborted = true;
				nonRetryable(
					`Embedding configuration error: ${errMsg}`,
					"EMBEDDING_CONFIG_ERROR",
				);
			}
			const msg = `Failed to process ${file.relativePath}: ${errMsg}`;
			logger.warn(`[CodeIndexing] ${msg}`);
			errors.push(msg);
		}
	}

	// Embedding is the dominant cost and is I/O-bound (one provider round-trip
	// per file), so process files with bounded concurrency rather than strictly
	// one at a time. The cap keeps us within provider rate limits while cutting
	// wall-clock time several-fold. JS is single-threaded, so the shared counters
	// (`totalChunks`, `errors`, `filesProcessedSoFar`) mutate atomically between
	// awaits — no locking needed.
	const EMBED_CONCURRENCY = 5;
	await runWithConcurrency(
		files,
		EMBED_CONCURRENCY,
		processFile,
		() => aborted,
	);

	// Best-effort live-progress write (embed loop only — gated on totalFileCount
	// being supplied). Never throws: a failed progress update must not fail the
	// batch or discard the chunks just embedded.
	if (input.totalFileCount !== undefined) {
		try {
			await updateCodeIndexProgress(
				{
					projectId,
					repositoryIntegrationId: repositoryIntegrationId ?? null,
					branch: input.branch,
				},
				{
					indexedFileCount:
						(input.filesProcessedSoFar ?? 0) + files.length,
					totalFileCount: input.totalFileCount,
				},
			);
		} catch (error) {
			logger.warn(
				`[CodeIndexing] Progress update failed (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	logger.info(
		`[CodeIndexing] Batch complete: ${totalChunks} chunks from ${files.length} files`,
	);

	// Job Hub: this is the near-real-time progress users watch during a long
	// index. Increments (not absolute writes) so concurrent batches compose.
	await jobIncrement(
		{
			filesProcessed: files.length,
			chunksCreated: totalChunks,
			...(errors.length > 0 ? { errors: errors.length } : {}),
		},
		repositoryIntegrationId ?? null,
	);

	return { chunksCreated: totalChunks, filesProcessed: files.length, errors };
}

/**
 * Delete the code-index vectors (chunks + summaries) for a set of changed or
 * removed files, so an incremental re-index doesn't leave stale chunks behind
 * (a shrunk file's extra chunks, or a deleted file's chunks). Propagates Qdrant
 * failures so the Temporal retry policy runs — this is the only routine orphan
 * cleanup, so a swallowed failure would leave stale chunks in search results.
 */
export async function deleteChangedCodeVectorsActivity(input: {
	projectId: string;
	repositoryIntegrationId?: string | null;
	organizationId?: string | null;
	filePaths: string[];
}): Promise<{ deletedPaths: number }> {
	if (input.filePaths.length === 0) {
		return { deletedPaths: 0 };
	}
	const { deleteProjectCodeIndexVectorsForPaths } = await import(
		"@repo/rag/lib/project-contexts/store"
	);
	await deleteProjectCodeIndexVectorsForPaths(
		input.projectId,
		input.organizationId ?? null,
		input.filePaths,
		input.repositoryIntegrationId ?? null,
	);
	return { deletedPaths: input.filePaths.length };
}

/**
 * Generate file-level summaries (Layer 1) for broad code queries.
 */
export async function generateFileSummariesActivity(
	input: GenerateFileSummariesInput,
): Promise<GenerateFileSummariesOutput> {
	const {
		files,
		projectId,
		repositoryIntegrationId,
		userId,
		organizationId,
		repoName,
	} = input;

	// Before the work, not after: this is the longest phase of a large index,
	// and marking it `running` on the way out left it reading `pending` for the
	// whole time the panel most needed to show where the job was. Same retry
	// exposure as the embed batch, so it heartbeats too.
	await jobStep("embed", "completed", {
		sourceId: repositoryIntegrationId ?? null,
	});
	await jobStep("summaries", "running", {
		sourceId: repositoryIntegrationId ?? null,
	});
	await jobHeartbeat(repositoryIntegrationId ?? null);
	const errors: string[] = [];
	let summariesCreated = 0;

	const { generateEmbeddings } = await import("@repo/rag/lib/embedding");
	const { generateSparseVector } = await import(
		"@repo/rag/lib/embedding/sparse"
	);
	const { getCollectionLayout, getCollectionName } = await import(
		"@repo/rag/lib/collection-manager"
	);
	const { qdrantClient } = await import(
		"@repo/rag/lib/project-contexts/client"
	);
	const { generatePointId } = await import("@repo/rag/lib/utils");

	const layout = await getCollectionLayout(
		"project-contexts",
		organizationId,
	);
	const collectionName = getCollectionName(
		"project-contexts",
		organizationId,
	);
	const tenantContext = {
		userId,
		organizationId: organizationId ?? undefined,
	};

	// Collect all summaries first, then batch embed + upsert
	const summaryTexts: string[] = [];
	const summaryPayloads: Array<Record<string, unknown>> = [];

	for (const file of files) {
		try {
			Context.current().heartbeat(
				`summarizing file ${summaryTexts.length + 1}/${files.length}: ${file.relativePath}`,
			);

			const sourceCode = fs.readFileSync(file.absolutePath, "utf-8");
			if (!sourceCode.trim()) {
				continue;
			}

			const summary = generateStructuralSummary(
				file.relativePath,
				sourceCode,
			);
			summaryTexts.push(
				`File: ${file.relativePath} in ${repoName}\n${summary}`,
			);
			summaryPayloads.push({
				contextId: codeContextId(
					"code-summary",
					projectId,
					repositoryIntegrationId,
					file.relativePath,
				),
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? null,
				userId,
				organizationId: organizationId ?? null,
				contextType: "CODE_FILE_SUMMARY",
				type: "CODE_FILE_SUMMARY",
				content: summary,
				filePath: file.relativePath,
				language:
					detectLanguageFromExt(
						path.extname(file.relativePath).toLowerCase(),
					) ?? "text",
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			const errMsg =
				error instanceof Error ? error.message : String(error);
			errors.push(`Failed to read ${file.relativePath}: ${errMsg}`);
		}
	}

	if (summaryTexts.length === 0) {
		return { summariesCreated: 0, errors };
	}

	// Batch embed all summaries at once
	try {
		Context.current().heartbeat(
			`embedding ${summaryTexts.length} summaries`,
		);
		const embeddingResult = await generateEmbeddings(
			summaryTexts,
			tenantContext,
		);

		const points = embeddingResult.embeddings.map(
			(embedding: number[], i: number) => {
				const payload = summaryPayloads[i];
				const pointId = generatePointId(payload.contextId as string);
				const sparse = generateSparseVector(
					(payload.content as string) ?? "",
				);
				return {
					id: pointId,
					vector: buildVector(layout, embedding, sparse),
					payload,
				};
			},
		);

		// Upsert in batches of 100
		for (let i = 0; i < points.length; i += 100) {
			const batch = points.slice(i, i + 100);
			await qdrantClient.upsert(collectionName, {
				wait: true,
				points: batch,
			});
		}

		summariesCreated = points.length;
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (
			errMsg.includes("API key") ||
			errMsg.includes("Unauthorized") ||
			errMsg.includes("Configure an embedding model")
		) {
			nonRetryable(
				`Embedding configuration error: ${errMsg}`,
				"EMBEDDING_CONFIG_ERROR",
			);
		}
		errors.push(`Batch embedding failed: ${errMsg}`);
	}

	logger.info(`[CodeIndexing] Generated ${summariesCreated} file summaries`);
	await jobIncrement({ summariesCreated }, repositoryIntegrationId ?? null);
	return { summariesCreated, errors };
}

/**
 * Generate a structural summary of a source file without LLM.
 */
function generateStructuralSummary(
	filePath: string,
	sourceCode: string,
): string {
	const lines = sourceCode.split("\n");
	const parts: string[] = [];

	const exports = lines
		.filter((l) => /^export\s/.test(l.trim()))
		.map((l) => l.trim().slice(0, 100))
		.slice(0, 10);
	if (exports.length > 0) {
		parts.push(`Exports: ${exports.join("; ")}`);
	}

	const imports = lines
		.filter((l) => /^import\s/.test(l.trim()))
		.map((l) => {
			const m = l.match(/from\s+["']([^"']+)["']/);
			return m ? m[1] : l.trim().slice(0, 60);
		})
		.slice(0, 5);
	if (imports.length > 0) {
		parts.push(`Imports from: ${imports.join(", ")}`);
	}

	const declarations = lines
		.filter((l) =>
			/^\s*(export\s+)?(async\s+)?(?:function|class|interface|type|enum)\s+\w/.test(
				l,
			),
		)
		.map((l) => {
			const m = l.match(/(?:function|class|interface|type|enum)\s+(\w+)/);
			return m ? m[1] : null;
		})
		.filter(Boolean)
		.slice(0, 10);
	if (declarations.length > 0) {
		parts.push(`Declarations: ${declarations.join(", ")}`);
	}

	parts.push(`Lines: ${lines.length}`);
	return parts.join(". ") || `Source file: ${filePath}`;
}

/**
 * Read the code embedding model from project RAG settings.
 * Returns null if not set (use default).
 */
export async function getCodeEmbeddingModelActivity(input: {
	projectId: string;
}): Promise<string | null> {
	const { getProjectRagSettings } = await import("@repo/database");
	const settings = await getProjectRagSettings(input.projectId);
	return (settings as any)?.codeEmbeddingModel ?? null;
}

/**
 * Check if Phase 2 code indexing is enabled via FEATURE_CODE_INDEXING env var.
 * Defaults to disabled. Set FEATURE_CODE_INDEXING=true to enable.
 */
export async function checkCodeIndexingEnabledActivity(): Promise<boolean> {
	const enabled = process.env.FEATURE_CODE_INDEXING === "true";
	if (!enabled) {
		logger.info(
			"[CodeIndexing] Phase 2 code indexing is disabled (set FEATURE_CODE_INDEXING=true to enable)",
		);
	}
	return enabled;
}

/**
 * Update the ProjectCodeIndex record with final stats.
 */
export async function updateCodeIndexActivity(
	input: UpdateCodeIndexInput,
): Promise<void> {
	// New path passes `manifestPath`; read the file list off disk so it never
	// crosses the payload boundary. Legacy path passes `fileManifest` inline.
	const fileManifest = input.manifestPath
		? readFileManifest(input.manifestPath).map((e) => ({
				path: e.relativePath,
				sha: "",
				language: e.language,
			}))
		: (input.fileManifest ?? []);

	await updateCodeIndexStats({
		projectId: input.projectId,
		repositoryIntegrationId: input.repositoryIntegrationId ?? null,
		branch: input.branch,
		filesIndexed: input.filesIndexed,
		chunksCreated: input.chunksCreated,
		summariesCreated: input.summariesCreated,
		indexDurationMs: input.indexDurationMs,
		fileManifest,
		redactionManifest: input.redactionManifest,
		incremental: input.incremental,
	});

	logger.info(
		`[CodeIndexing] Updated code index: ${input.filesIndexed} files, ${input.chunksCreated} chunks`,
	);

	// Job Hub: the workflow's terminal success step. Overwrite the running
	// increments with the authoritative totals — continueAsNew means a batch may
	// have been counted twice on retry, and these are the numbers the index row
	// itself reports.
	//
	// Name the source explicitly. A bare `jobComplete()` is workflow-scoped, and
	// this workflow id is stable per repo across runs — a superseded run's
	// in-flight finalize would otherwise close the successor's row.
	const sourceId = input.repositoryIntegrationId ?? null;
	const counts = {
		filesProcessed: input.filesIndexed,
		totalFiles: input.filesIndexed,
		chunksCreated: input.chunksCreated,
		summariesCreated: input.summariesCreated,
	};

	// A full run that walked files but embedded nothing leaves an index agents
	// will search and find nothing in. Reporting that as a green "Completed" is
	// the misreport this panel exists to remove, so say what happened; the usual
	// cause is a missing or rejected embedding provider key.
	//
	// Full runs only. On an incremental run `filesIndexed` is the whole repo
	// walk while only the changed subset is embedded, so zero chunks is the
	// normal outcome of a push that touched nothing indexable — docs, config, or
	// deletions. Failing those would put a confident, wrong diagnosis on a
	// healthy index, which is the very thing being fixed here.
	if (
		!input.incremental &&
		input.filesIndexed > 0 &&
		input.chunksCreated === 0
	) {
		// Mark the step that actually produced nothing, and leave the rest for
		// the close to sweep — claiming embed/summaries/finalize "completed"
		// above a red badge would be a fresh misreport.
		await jobStep("embed", "failed", {
			sourceId,
			error: "No chunks were produced.",
		});
		await jobSetCounts(counts, sourceId);
		await jobFail(
			"No content was indexed — every file failed to embed. Check the AI provider key in Settings > AI Providers, then re-index.",
			{ sourceId, errorClass: "NothingIndexed" },
		);
		return;
	}

	await jobStep("embed", "completed", { sourceId });
	await jobStep("summaries", "completed", { sourceId });
	await jobStep("finalize", "completed", { sourceId });
	await jobComplete({ sourceId, counts });
}

/**
 * Initialize the code index record (set status to INDEXING).
 */
export async function initCodeIndexActivity(input: {
	projectId: string;
	repositoryIntegrationId?: string | null;
	branch?: string;
	userId: string;
	organizationId?: string | null;
	commitSha: string;
	workflowId?: string;
	/** Display name for the Job Hub row (owner/repo). */
	repoName?: string;
}): Promise<void> {
	// Job Hub: the API pre-creates this row when a user action starts the run,
	// so the panel shows the job the instant they click. This is the safety net
	// for the paths that start the workflow without one (webhooks); ensure()
	// adopts the pre-created row when it exists.
	await jobEnsure({
		kind: "CODE_INDEXING",
		title: input.repoName ?? "Repository indexing",
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		sourceType: JOB_SOURCE.repositoryIntegration,
		sourceId: input.repositoryIntegrationId ?? null,
		steps: seedJobSteps([...JOB_STEPS.codeIndexing]),
	});

	await upsertProjectCodeIndex({
		projectId: input.projectId,
		repositoryIntegrationId: input.repositoryIntegrationId ?? null,
		branch: input.branch,
		userId: input.userId,
		organizationId: input.organizationId,
		commitSha: input.commitSha,
		status: "INDEXING",
		workflowId: input.workflowId,
	});
}

/**
 * Mark code index as failed.
 */
export async function failCodeIndexActivity(input: {
	projectId: string;
	repositoryIntegrationId?: string | null;
	branch?: string;
	error: string;
}): Promise<void> {
	// Job Hub: every failure path in the indexing workflow routes through here,
	// so this single call covers them all. `error` is rendered verbatim in the
	// panel.
	await jobFail(input.error, {
		sourceId: input.repositoryIntegrationId ?? null,
	});

	try {
		await updateCodeIndexStatus(
			{
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				branch: input.branch,
			},
			"FAILED",
			input.error,
		);
	} catch {
		logger.warn(
			`[CodeIndexing] Could not mark index as failed for ${input.projectId}`,
		);
	}
}

/**
 * Clean up the temporary clone directory.
 */
export async function cleanupCloneDirActivity(
	input: CleanupCloneDirInput,
): Promise<void> {
	try {
		if (fs.existsSync(input.clonePath)) {
			fs.rmSync(input.clonePath, { recursive: true, force: true });
			logger.info(
				`[CodeIndexing] Cleaned up clone dir: ${input.clonePath}`,
			);
		}
		// Remove the sibling on-disk manifests (best-effort — absent on the
		// legacy path, if the walk never ran, or for a full (non-incremental) run).
		fs.rmSync(codeIndexManifestPath(input.clonePath), { force: true });
		fs.rmSync(codeIndexChangedManifestPath(input.clonePath), {
			force: true,
		});
	} catch (error) {
		logger.warn(
			`[CodeIndexing] Failed to clean up: ${error instanceof Error ? error.message : error}`,
		);
	}
}

// Vector cleanup is handled by deleteProjectCodeIndexVectors in @repo/rag
// (called directly from API procedures, not via Temporal activity)

// =============================================================================
// Token resolution (for workflows started with integrationId instead of token)
// =============================================================================

export interface ResolveRepoTokenInput {
	integrationId: string;
	projectId: string;
}

export interface ResolveRepoTokenOutput {
	token: string | null;
	authMethod: string | null;
}

export async function resolveRepoTokenActivity(
	input: ResolveRepoTokenInput,
): Promise<ResolveRepoTokenOutput> {
	// Canonical resolver: refreshes a near-expiry GitHub/GitLab OAuth token
	// instead of decrypting a stored one that a GitHub App expires after 8h.
	const { token, authMethod } = await resolveFreshRepoToken({
		integrationId: input.integrationId,
		projectId: input.projectId,
	});
	return { token, authMethod };
}

// Re-export symbol extraction from modular sub-module
export {
	deleteProjectCodeSymbolsActivity,
	type ExtractAndPersistSymbolsInput,
	type ExtractSymbolsActivityInput,
	type ExtractSymbolsActivityOutput,
	extractAndPersistSymbolsActivity,
	extractSymbolsActivity,
	type PersistCodeSymbolsInput,
	type PersistCodeSymbolsOutput,
	persistCodeSymbolsActivity,
} from "./code-indexing/extract-symbols";
