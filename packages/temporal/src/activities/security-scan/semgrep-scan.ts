/**
 * Semgrep SAST scan activity (the "code" half of the hybrid scan).
 *
 * The LLM scanners read Fabric-held planning artifacts (features + documents).
 * This activity complements them with REAL, code-level findings: it clones the
 * project's connected repository and runs the Semgrep static analyzer over the
 * source, mapping every Semgrep result into the same `ScanFindingDraft` shape so
 * the persist path is shared. Semgrep findings are always `category: SECURITY`.
 *
 * GRACEFUL DEGRADATION (non-negotiable): this scan is best-effort. A missing
 * repository, a clone failure, or a missing Semgrep binary must NEVER fail the
 * overall scan — each returns a `skipped` reason and the LLM findings still
 * persist. The only hard requirement is the secret guarantee: every finding
 * field is run through `redactSecrets` before it leaves this activity, because
 * code matches frequently contain the literal secret value.
 *
 * The worker image must ship the `semgrep` binary (see packages/temporal/
 * Dockerfile). Until it does, this activity logs `skipped: "semgrep-unavailable"`
 * and the scan runs LLM-only.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	getProjectReposForCodeSearch,
	getProjectScanConfig,
} from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";
import { Context } from "@temporalio/activity";
import {
	type RepoIntegrationRow,
	resolveRepoAuth,
} from "../daily-brief/resolve-repo-auth";
import {
	computeFindingFingerprint,
	normalizeSeverity,
	redactSecrets,
	type ScanFindingDraft,
	type ScanSeverityValue,
} from "./scan-schemas";

const execFileAsync = promisify(execFile);

// 64 MB — a large repo's `--json` output can be sizeable; the default 1 MB
// would truncate and crash the parse.
const SEMGREP_MAX_BUFFER = 64 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

export interface RunSemgrepScanInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	workflowRunId: string;
	/**
	 * Branch-scoped incremental scanning (optional; absent ⇒ current full-scan
	 * behavior). `branch` is the concrete branch to clone (falls back to the
	 * project's scanBranch / repo default when absent). `baseSha`..`targetSha`
	 * is the range to diff; when `codeScanMode === "DIFF"` the scan is scoped to
	 * the files that changed in that range instead of the whole clone.
	 */
	branch?: string | null;
	baseSha?: string | null;
	targetSha?: string | null;
	codeScanMode?: "FULL" | "DIFF";
}

export interface RunSemgrepScanOutput {
	findings: ScanFindingDraft[];
	rulesRun: number;
	filesScanned: number;
	/** Why the scan produced no code findings, or null when it ran normally. */
	skipped: "no-repo" | "semgrep-unavailable" | "clone-failed" | null;
	/** "owner/name" of the repo that was scanned, when one was. */
	repo?: string;
	/**
	 * Repo-relative paths that changed in the diff range (DIFF mode only; empty
	 * on a full scan). Includes deleted paths so the workflow can drop their prior
	 * findings via location match. Merged into `scannedItemKeys` at persist time.
	 */
	changedFilePaths: string[];
	/** Count of changed files (0 on a full scan) — checkpoint telemetry. */
	changedFileCount: number;
}

/**
 * The subset of the Semgrep `--json` schema we consume. Everything is optional /
 * loosely typed because we only read a handful of fields and must tolerate
 * version drift in the rest of the payload.
 */
interface SemgrepRawResult {
	check_id?: string;
	path?: string;
	start?: { line?: number };
	extra?: {
		message?: string;
		severity?: string;
		fix?: string;
		/** The matched source line(s) — the real code evidence for a finding. */
		lines?: string;
		metadata?: {
			fix?: string;
			/** Semgrep's own per-rule confidence: "LOW" | "MEDIUM" | "HIGH". */
			confidence?: string;
			/** Rule category — "audit" rules are expected to be noisy. */
			category?: string;
			cwe?: string | string[];
			owasp?: string | string[];
		} & Record<string, unknown>;
	} & Record<string, unknown>;
}

/** Clamp for a captured source excerpt before it's persisted as evidence. */
const SEMGREP_EVIDENCE_MAX_CHARS = 500;
/**
 * Confidence cap for a Semgrep `audit`-category rule. These rules surface
 * patterns to review rather than confirmed defects (the noisy
 * `unsafe-formatstring` tail is one), so they're kept but down-ranked below the
 * default view's confidence floor — never dropped.
 */
const SEMGREP_AUDIT_CONFIDENCE_CAP = 0.35;

interface SemgrepJson {
	results?: SemgrepRawResult[];
	paths?: { scanned?: string[] };
}

// =============================================================================
// Pure parser (unit-tested — no fs / execa)
// =============================================================================

/** ERROR→HIGH, WARNING→MEDIUM, INFO→LOW; anything else defaults via normalize. */
function mapSemgrepSeverity(raw: unknown): ScanSeverityValue {
	const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	if (value === "ERROR") {
		return normalizeSeverity("HIGH");
	}
	if (value === "WARNING") {
		return normalizeSeverity("MEDIUM");
	}
	if (value === "INFO") {
		return normalizeSeverity("LOW");
	}
	return normalizeSeverity(value);
}

/**
 * Rule-severity → confidence proxy, used ONLY when Semgrep didn't report its own
 * per-rule confidence: ERROR rules are higher-signal than INFO. ERROR→0.8 /
 * WARNING→0.6 / INFO→0.4; unknown→0.5.
 */
function severityProxyConfidence(raw: unknown): number {
	const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	if (value === "ERROR") {
		return 0.8;
	}
	if (value === "WARNING") {
		return 0.6;
	}
	if (value === "INFO") {
		return 0.4;
	}
	return 0.5;
}

/**
 * Derived confidence for a Semgrep finding. Prefers Semgrep's OWN per-rule
 * confidence (`metadata.confidence` LOW/MEDIUM/HIGH → 0.3/0.6/0.9), which is a
 * far better false-positive signal than rule severity; falls back to the
 * severity proxy only when metadata is absent. An `audit`-category rule is
 * capped low ({@link SEMGREP_AUDIT_CONFIDENCE_CAP}) because those rules flag
 * patterns to review rather than confirmed defects — this is what pushes the
 * noisy audit tail below the default view's floor without dropping it. Pure +
 * exported for unit testing; tolerates missing/garbled metadata.
 */
export function deriveSemgrepConfidence(
	extra: SemgrepRawResult["extra"],
): number {
	const metadata = extra?.metadata;
	const metaConfidence =
		typeof metadata?.confidence === "string"
			? metadata.confidence.trim().toUpperCase()
			: "";
	let base: number;
	if (metaConfidence === "HIGH") {
		base = 0.9;
	} else if (metaConfidence === "MEDIUM") {
		base = 0.6;
	} else if (metaConfidence === "LOW") {
		base = 0.3;
	} else {
		base = severityProxyConfidence(extra?.severity);
	}
	const category =
		typeof metadata?.category === "string"
			? metadata.category.trim().toLowerCase()
			: "";
	if (category === "audit") {
		return Math.min(base, SEMGREP_AUDIT_CONFIDENCE_CAP);
	}
	return base;
}

/**
 * Turn Semgrep's matched `extra.lines` into a short, redacted evidence excerpt.
 * REDACTS FIRST, then clamps: a code match frequently contains the literal secret
 * value, and clamping before redaction could truncate a secret past the point its
 * pattern matches — leaking a partial credential into `scan_finding.evidence`. So
 * {@link redactSecrets} runs over the full string, and only the redacted result is
 * clamped. Null when Semgrep reported no lines. Pure + testable.
 */
export function extractSemgrepEvidence(lines: unknown): string | null {
	if (typeof lines !== "string") {
		return null;
	}
	const trimmed = lines.trim();
	if (!trimmed) {
		return null;
	}
	const redacted = redactSecrets(trimmed);
	return redacted.length > SEMGREP_EVIDENCE_MAX_CHARS
		? `${redacted.slice(0, SEMGREP_EVIDENCE_MAX_CHARS)}…`
		: redacted;
}

/**
 * Humanize the last segment of a Semgrep `check_id` into a short title, e.g.
 * `javascript.express.security.audit.xss.direct-response-write` →
 * "Direct response write". Falls back to the first line of the message.
 */
function deriveSemgrepTitle(result: SemgrepRawResult): string {
	const checkId = result.check_id?.trim();
	if (checkId) {
		const lastSegment = checkId.split(".").pop() ?? checkId;
		const humanized = lastSegment
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (humanized) {
			const titled =
				humanized.charAt(0).toUpperCase() + humanized.slice(1);
			return titled.slice(0, 240);
		}
	}
	const firstLine = result.extra?.message?.split("\n")[0]?.trim();
	if (firstLine) {
		return firstLine.slice(0, 240);
	}
	return "Semgrep finding";
}

/**
 * Map ONE Semgrep result into a persistable draft. Every string field is run
 * through `redactSecrets` so a literal secret matched in source code never
 * lands in `scan_finding`.
 */
/** Where the scanned repo lives on the web, for building blob/commit links. */
export type RepoSource = {
	/** Web base URL, e.g. https://github.com/owner/repo (no .git). */
	webUrl: string;
	/** Branch the scan ran against. */
	branch: string;
	/** Only github/gitlab share the /blob/<ref>/<path>#L<line> + /commit/<sha> shape. */
	linkable: boolean;
};

/**
 * Build a {@link RepoSource} from a repo integration row. Strips any credentials
 * from the URL (defense in depth — a source link must never carry a token) and
 * marks github/gitlab as linkable (their blob/commit URL shape is shared).
 */
export function repoSourceFromRepo(
	repo: RepoIntegrationRow,
	branchOverride?: string,
): RepoSource {
	let webUrl = repo.repositoryUrl;
	try {
		const u = new URL(repo.repositoryUrl);
		u.username = "";
		u.password = "";
		webUrl = u.toString();
	} catch {
		// non-URL value — fall through to the raw string
	}
	webUrl = webUrl.replace(/\.git$/, "").replace(/\/$/, "");
	const provider = (repo.provider ?? "").toLowerCase();
	return {
		webUrl,
		branch: branchOverride?.trim() || repo.branch || "main",
		linkable: provider.includes("github") || provider.includes("gitlab"),
	};
}

function mapSemgrepResult(
	result: SemgrepRawResult,
	repo?: RepoSource,
): ScanFindingDraft {
	const checkId = result.check_id?.trim() || "unknown-rule";
	const message = result.extra?.message?.trim() ?? "";
	const remediation =
		result.extra?.metadata?.fix?.trim() ||
		result.extra?.fix?.trim() ||
		"Review and remediate per the Semgrep rule.";
	const relativePath = result.path?.trim() || "unknown";
	const line = result.start?.line;
	const location =
		typeof line === "number" ? `${relativePath}:${line}` : relativePath;

	// Verifiable link to the exact file + line (github/gitlab blob URL).
	let sourceUrl: string | null = null;
	if (repo?.linkable && relativePath !== "unknown") {
		const anchor = typeof line === "number" ? `#L${line}` : "";
		sourceUrl = `${repo.webUrl}/blob/${repo.branch}/${relativePath}${anchor}`;
	}

	const title = redactSecrets(deriveSemgrepTitle(result));
	const ruleSource = redactSecrets(`Semgrep: ${checkId}`);
	const redactedLocation = redactSecrets(location);
	return {
		title,
		severity: mapSemgrepSeverity(result.extra?.severity),
		description: redactSecrets(message),
		remediation: redactSecrets(remediation),
		ruleSource,
		isCustomRule: false,
		location: redactedLocation,
		sourceUrl,
		confidence: deriveSemgrepConfidence(result.extra),
		// The matched source line(s) are the real evidence for the finding —
		// captured (redacted) so the adversarial judge confirms/refutes against
		// the actual code rather than abstaining on an empty evidence block.
		evidence: extractSemgrepEvidence(result.extra?.lines),
		fingerprint: computeFindingFingerprint(
			"SECURITY",
			ruleSource,
			redactedLocation,
		),
	};
}

/**
 * Parse a Semgrep `--json` payload into findings. Pure: no fs / process access,
 * so it is fully unit-testable. De-dupes identical findings by
 * `ruleSource + location` (Semgrep can report the same rule at the same line
 * across overlapping rule packs). When `repo` is provided, each finding gets a
 * verifiable `sourceUrl` to the file + line.
 */
export function parseSemgrepResults(
	json: unknown,
	repo?: RepoSource,
): ScanFindingDraft[] {
	const results =
		json && typeof json === "object"
			? ((json as SemgrepJson).results ?? [])
			: [];
	if (!Array.isArray(results)) {
		return [];
	}

	const seen = new Set<string>();
	const findings: ScanFindingDraft[] = [];
	for (const result of results) {
		if (!result || typeof result !== "object") {
			continue;
		}
		const draft = mapSemgrepResult(result, repo);
		// NUL separator can't collide with rule-source / location text.
		const key = `${draft.ruleSource}\u0000${draft.location ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		findings.push(draft);
	}
	return findings;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Emit a heartbeat every 20s while `fn` runs so a long clone+scan never goes
 * silent past its heartbeat timeout (mirrors atlas's withHeartbeat).
 */
export async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
	const timer = setInterval(() => {
		try {
			Context.current().heartbeat();
		} catch {
			// Outside an activity context (unit tests) / already settled.
		}
	}, 20_000);
	try {
		return await fn();
	} finally {
		clearInterval(timer);
	}
}

/**
 * Build an authenticated HTTPS clone URL for `repo` using its resolved auth.
 * Replicates `cloneRepositoryActivity`'s per-provider convention:
 *   - GitHub: username `x-access-token`, password = OAuth token
 *   - GitLab: username `oauth2`, password = (refresh-aware) access token
 *   - Azure DevOps: empty username, password = PAT
 * Returns null when the repo's auth could not be resolved (skipped upstream).
 */
export async function buildAuthenticatedCloneUrl(
	repo: RepoIntegrationRow,
): Promise<string | null> {
	const auth = await resolveRepoAuth(repo);
	const parsed = new URL(repo.repositoryUrl);

	if (auth.kind === "github") {
		parsed.username = "x-access-token";
		parsed.password = auth.token;
		return parsed.toString();
	}
	if (auth.kind === "gitlab") {
		const token = await auth.getToken();
		parsed.username = "oauth2";
		parsed.password = token;
		return parsed.toString();
	}
	if (auth.kind === "ado") {
		// resolveRepoAuth returns a Basic header for REST; for `git clone` we
		// need the PAT itself in the URL. Decrypt it directly (same source).
		if (!repo.encryptedPat) {
			return null;
		}
		try {
			parsed.username = "";
			parsed.password = decryptApiKey(repo.encryptedPat);
			return parsed.toString();
		} catch {
			return null;
		}
	}
	// kind === "unsupported"
	logger.warn("[SemgrepScan] Unsupported repo auth — skipping clone", {
		provider: repo.provider,
		reason: auth.reason,
	});
	return null;
}

/** True when an error is a "binary not found" (ENOENT) from execFile. */
export function isBinaryMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Parse `git diff --name-only <base> <target>` output into a de-duped list of
 * repo-relative changed paths. Tolerant of blank lines / CRLF. Includes deleted
 * paths (they surface as changed) so the caller can drop their prior findings.
 * Pure + exported for unit testing.
 */
export function parseDiffNameOnly(output: string): string[] {
	if (typeof output !== "string") {
		return [];
	}
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const line of output.split("\n")) {
		const p = line.trim();
		if (p && !seen.has(p)) {
			seen.add(p);
			paths.push(p);
		}
	}
	return paths;
}

/**
 * Resolve the diff scope for an incremental Semgrep scan. The three git/fs
 * operations are injected so the branching logic is unit-testable without
 * simple-git or a real clone:
 *   - `fetchBase` deepens the shallow clone with the base commit object,
 *   - `diffNames` runs `git diff --name-only <base> <target>`,
 *   - `fileExists` reports whether a changed path still exists in the working tree.
 *
 * Returns the full changed set (`changedFilePaths`, INCLUDING deletes — these are
 * the location-match keys the workflow uses to drop superseded prior findings) and
 * the subset that still exists on disk (`scanTargets` — the explicit Semgrep
 * targets, so a rename's new path is scanned and its deleted old path excluded).
 * Returns null when fetch/diff throws (an unreachable base), so the caller falls
 * back to a full-directory scan. Never throws.
 */
export async function computeSemgrepDiffScope(opts: {
	baseSha: string;
	targetSha: string;
	fetchBase: () => Promise<void>;
	diffNames: () => Promise<string>;
	fileExists: (relPath: string) => Promise<boolean>;
}): Promise<{ changedFilePaths: string[]; scanTargets: string[] } | null> {
	try {
		await opts.fetchBase();
		const output = await opts.diffNames();
		const changedFilePaths = parseDiffNameOnly(output);
		const scanTargets: string[] = [];
		for (const p of changedFilePaths) {
			if (await opts.fileExists(p)) {
				scanTargets.push(p);
			}
		}
		return { changedFilePaths, scanTargets };
	} catch {
		return null;
	}
}

// =============================================================================
// Activity
// =============================================================================

export async function runSemgrepScanActivity(
	input: RunSemgrepScanInput,
): Promise<RunSemgrepScanOutput> {
	const { projectId, workflowRunId } = input;
	const empty = (
		skipped: RunSemgrepScanOutput["skipped"],
		repo?: string,
	): RunSemgrepScanOutput => ({
		findings: [],
		rulesRun: 0,
		filesScanned: 0,
		skipped,
		changedFilePaths: [],
		changedFileCount: 0,
		...(repo ? { repo } : {}),
	});

	// 1. Resolve the project's connected repos; use the first ACTIVE one.
	const repos = await getProjectReposForCodeSearch(projectId);
	if (repos.length === 0) {
		logger.info("[SemgrepScan] No active repository connected — skipping", {
			projectId,
		});
		return empty("no-repo");
	}
	const repo = repos[0];
	const repoSlug = `${repo.owner}/${repo.repo}`;
	if (repos.length > 1) {
		logger.info(
			`[SemgrepScan] Project has ${repos.length} active repos — scanning the first (${repoSlug})`,
			{ projectId },
		);
	}

	const clonePath = path.join(os.tmpdir(), `fabric-semgrep-${workflowRunId}`);

	try {
		return await withHeartbeat(async () => {
			// 2. Build the authenticated clone URL + shallow-clone the branch.
			const authUrl = await buildAuthenticatedCloneUrl(repo);
			if (!authUrl) {
				return empty("clone-failed", repoSlug);
			}

			// Fresh dir each run.
			await fs.rm(clonePath, { recursive: true, force: true });

			const simpleGit = (await import("simple-git")).default;
			// Resolve the branch to clone: the workflow-provided branch (kept in
			// sync with the SHA the resolve step read for the diff), else the
			// project's configured scanBranch, else the repo's default, else "main".
			const scanConfig = await getProjectScanConfig(projectId);
			const targetBranch =
				input.branch?.trim() ||
				scanConfig.scanBranch?.trim() ||
				repo.branch ||
				"main";
			try {
				Context.current().heartbeat("cloning");
				await simpleGit().clone(authUrl, clonePath, [
					"--depth",
					"1",
					"--single-branch",
					"--branch",
					targetBranch,
				]);
			} catch (error) {
				// NEVER throw — a clone failure degrades to a skip so the LLM
				// scan still completes. Do not log the URL (it carries a token).
				logger.warn("[SemgrepScan] Clone failed — skipping code scan", {
					projectId,
					repo: repoSlug,
					branch: targetBranch,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return empty("clone-failed", repoSlug);
			}

			// 2b. Incremental diff scope (DIFF mode): fetch the base commit into
			// the shallow clone and scope Semgrep to the files changed in
			// base..target. On an unreachable base (fetch/diff throws) fall back
			// to a full scan. `changedFilePaths` (incl. deleted paths) is threaded
			// back so the workflow drops those files' prior findings.
			let changedFilePaths: string[] = [];
			let semgrepTargets: string[] = [clonePath];
			let semgrepCwd: string | undefined;
			if (
				input.codeScanMode === "DIFF" &&
				input.baseSha &&
				input.targetSha
			) {
				const baseSha = input.baseSha;
				const targetSha = input.targetSha;
				Context.current().heartbeat("computing diff scope");
				const git = simpleGit(clonePath);
				const scope = await computeSemgrepDiffScope({
					baseSha,
					targetSha,
					fetchBase: () =>
						git
							.fetch(["origin", baseSha, "--depth=1"])
							.then(() => undefined),
					diffNames: () =>
						git.raw(["diff", "--name-only", baseSha, targetSha]),
					fileExists: async (relPath) => {
						try {
							return (
								await fs.stat(path.join(clonePath, relPath))
							).isFile();
						} catch {
							return false;
						}
					},
				});
				if (scope) {
					changedFilePaths = scope.changedFilePaths;
					if (scope.scanTargets.length > 0) {
						// Repo-relative targets, scanned with cwd = clone root so
						// Semgrep reports repo-relative paths.
						semgrepTargets = scope.scanTargets;
						semgrepCwd = clonePath;
					} else {
						// Empty diff / only deletions: no fresh findings, but report
						// the changed paths so the workflow drops the deleted files'
						// prior findings via location match.
						logger.info(
							"[SemgrepScan] Diff produced no scannable files — skipping code scan",
							{ projectId, repo: repoSlug },
						);
						return {
							findings: [],
							rulesRun: 0,
							filesScanned: 0,
							skipped: null,
							repo: repoSlug,
							changedFilePaths,
							changedFileCount: changedFilePaths.length,
						};
					}
				} else {
					// Base unreachable — full scan, no diff scope (never fail).
					logger.warn(
						"[SemgrepScan] Diff scoping failed (unreachable base) — falling back to a full scan",
						{ projectId, repo: repoSlug },
					);
				}
			}

			// 3. Run Semgrep over the resolved targets (the whole clone, or the
			// changed files in DIFF mode).
			Context.current().heartbeat("running semgrep");
			let stdout: string;
			try {
				const result = await execFileAsync(
					"semgrep",
					[
						"scan",
						"--json",
						"--quiet",
						"--timeout=0",
						"--config=p/default",
						"--config=p/owasp-top-ten",
						...semgrepTargets,
					],
					{
						maxBuffer: SEMGREP_MAX_BUFFER,
						// DIFF mode runs relative to the clone root so Semgrep's
						// reported paths are repo-relative (match the git diff).
						...(semgrepCwd ? { cwd: semgrepCwd } : {}),
						// Semgrep exits non-zero when findings are present; we
						// only care about stdout, so never treat that as fatal.
					},
				);
				stdout = result.stdout;
			} catch (error) {
				// Binary missing → graceful degradation (image not yet rebuilt).
				if (isBinaryMissing(error)) {
					logger.warn(
						"[SemgrepScan] semgrep binary not found — skipping code scan (rebuild the worker image with Semgrep)",
						{ projectId, repo: repoSlug },
					);
					return empty("semgrep-unavailable", repoSlug);
				}
				// Semgrep returns a non-zero exit code when it finds issues; in
				// that case execFile still gives us stdout on the error object.
				const withStdout = error as { stdout?: string };
				if (
					typeof withStdout.stdout === "string" &&
					withStdout.stdout
				) {
					stdout = withStdout.stdout;
				} else {
					logger.warn(
						"[SemgrepScan] Semgrep run failed — skipping code scan",
						{
							projectId,
							repo: repoSlug,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
					return empty("semgrep-unavailable", repoSlug);
				}
			}

			// 4. Parse + map findings (pure, redacts every field).
			let parsed: SemgrepJson;
			try {
				parsed = JSON.parse(stdout) as SemgrepJson;
			} catch (error) {
				logger.warn(
					"[SemgrepScan] Could not parse Semgrep JSON — skipping code scan",
					{
						projectId,
						repo: repoSlug,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				return empty("semgrep-unavailable", repoSlug);
			}

			const findings = parseSemgrepResults(
				parsed,
				repoSourceFromRepo(repo, targetBranch),
			);
			const filesScanned = parsed.paths?.scanned?.length ?? 0;
			const rulesRun = findings.length;

			logger.info("[SemgrepScan] Completed", {
				projectId,
				repo: repoSlug,
				findings: findings.length,
				filesScanned,
				codeScanMode:
					input.codeScanMode === "DIFF" && semgrepCwd
						? "DIFF"
						: "FULL",
				changedFiles: changedFilePaths.length,
			});

			return {
				findings,
				rulesRun,
				filesScanned,
				skipped: null,
				repo: repoSlug,
				changedFilePaths,
				changedFileCount: changedFilePaths.length,
			};
		});
	} finally {
		// 5. Always remove the clone dir.
		await fs
			.rm(clonePath, { recursive: true, force: true })
			.catch((error) => {
				logger.warn("[SemgrepScan] Failed to clean up clone dir", {
					clonePath,
					error:
						error instanceof Error ? error.message : String(error),
				});
			});
	}
}
