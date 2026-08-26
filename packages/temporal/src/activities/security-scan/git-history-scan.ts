/**
 * Git-history secret scan activity (gitleaks — the "history" half of the hybrid
 * scan).
 *
 * The Semgrep activity scans the working tree of a depth-1 clone, so it only
 * sees secrets in the *current* code. This activity complements it: it does a
 * FULL clone of the connected repository and runs gitleaks over the entire
 * commit history, catching secrets that were committed and later removed.
 *
 * SAFETY (non-negotiable): gitleaks runs with `--redact` so the raw secret never
 * reaches us, and every finding field is additionally run through
 * `redactSecrets` before it leaves this activity. The clone is deleted in
 * `finally`, so no source and no secret material is retained.
 *
 * GRACEFUL DEGRADATION: a missing repo, a clone failure, or a missing gitleaks
 * binary returns a `skipped` reason rather than throwing, so the LLM + Semgrep
 * halves of the scan still complete. The worker image must ship the `gitleaks`
 * binary (see packages/temporal/Dockerfile); until it does, this logs
 * `skipped: "gitleaks-unavailable"`.
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
import { Context } from "@temporalio/activity";
import {
	computeFindingFingerprint,
	normalizeSeverity,
	redactSecrets,
	type ScanFindingDraft,
} from "./scan-schemas";
import {
	buildAuthenticatedCloneUrl,
	isBinaryMissing,
	type RepoSource,
	repoSourceFromRepo,
	withHeartbeat,
} from "./semgrep-scan";

const execFileAsync = promisify(execFile);
const GITLEAKS_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Derived confidence for a git-history secret finding (G13). gitleaks rules are
 * precise (a matched secret pattern is rarely fabricated), so secrets get a high
 * fixed confidence; they remain FP-prone enough (test fixtures, examples) that
 * it is not 1.0.
 */
const GITLEAKS_CONFIDENCE = 0.85;

export interface RunGitHistorySecretScanInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	workflowRunId: string;
	/**
	 * Branch-scoped incremental scanning (optional; absent ⇒ current full-history
	 * behavior). `branch` is the concrete branch to clone. When
	 * `codeScanMode === "DIFF"` gitleaks is scoped to the commits in
	 * `baseSha`..`targetSha` (HEAD) instead of the entire commit history.
	 */
	branch?: string | null;
	baseSha?: string | null;
	targetSha?: string | null;
	codeScanMode?: "FULL" | "DIFF";
}

export interface RunGitHistorySecretScanOutput {
	findings: ScanFindingDraft[];
	/** Why no findings were produced, or null when the scan ran normally. */
	skipped: "no-repo" | "gitleaks-unavailable" | "clone-failed" | null;
	/** "owner/name" of the repo that was scanned, when one was. */
	repo?: string;
	/** New commits scanned in DIFF mode (0 on a full-history scan) — telemetry. */
	changedCommitCount: number;
}

/** One gitleaks JSON finding — the subset of fields we consume. */
interface GitleaksRawFinding {
	RuleID?: string;
	Description?: string;
	File?: string;
	Commit?: string;
	StartLine?: number;
}

/** Humanize a gitleaks RuleID, e.g. "aws-access-token" → "Aws access token". */
function humanizeRule(ruleId: string): string {
	const cleaned = ruleId.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) {
		return "Secret";
	}
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Map a gitleaks `--report-format json` payload into redacted SECURITY findings,
 * de-duped by rule + commit + file + line. Pure (no fs / process) so it is
 * fully unit-testable. gitleaks runs with `--redact`, but every field is still
 * run through `redactSecrets` as a belt-and-braces guarantee.
 */
export function parseGitleaksResults(
	json: unknown,
	repo?: RepoSource,
): ScanFindingDraft[] {
	const results = Array.isArray(json) ? (json as GitleaksRawFinding[]) : [];
	const seen = new Set<string>();
	const findings: ScanFindingDraft[] = [];
	for (const r of results) {
		if (!r || typeof r !== "object") {
			continue;
		}
		const ruleId = (r.RuleID ?? "secret").trim() || "secret";
		const file = (r.File ?? "").trim();
		const commit = (r.Commit ?? "").trim();
		const line = typeof r.StartLine === "number" ? r.StartLine : null;
		const key = `${ruleId}0000${commit}0000${file}0000${line ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		// Verifiable link to the offending commit (github/gitlab).
		const sourceUrl =
			repo?.linkable && commit ? `${repo.webUrl}/commit/${commit}` : null;

		const where = [
			file || null,
			line != null ? `line ${line}` : null,
			commit ? `commit ${commit.slice(0, 10)}` : null,
		]
			.filter(Boolean)
			.join(", ");
		const description =
			r.Description?.trim() ||
			`A secret matching the "${ruleId}" rule was committed to the repository's git history.`;

		const title = redactSecrets(
			`Secret in git history: ${humanizeRule(ruleId)}`,
		);
		const ruleSource = redactSecrets(`Secret history: ${ruleId}`);
		const redactedLocation = redactSecrets(where || file || "git history");
		// Evidence for the judge — the rule + location that matched, NEVER the
		// secret value (gitleaks runs with --redact and we redact again). A
		// concrete rule-hit at a real commit/file IS the detection: the judge's
		// deterministic-scanner carve-out treats this as real unless it's a
		// placeholder/test value.
		const evidence = redactSecrets(
			`gitleaks rule "${ruleId}" matched a committed secret${
				where ? ` at ${where}` : ""
			}. The secret value is redacted; a credential committed even once is compromised.`,
		);
		findings.push({
			title,
			severity: normalizeSeverity("HIGH"),
			description: redactSecrets(
				`${description}${where ? ` Found in ${where}.` : ""} A credential committed even once must be considered compromised.`,
			),
			remediation: redactSecrets(
				"Rotate the exposed credential now, purge it from git history (e.g. git filter-repo / BFG), and move it to a secret manager so it is never committed again.",
			),
			ruleSource,
			isCustomRule: false,
			location: redactedLocation,
			sourceUrl,
			confidence: GITLEAKS_CONFIDENCE,
			evidence,
			fingerprint: computeFindingFingerprint(
				"SECURITY",
				ruleSource,
				redactedLocation,
			),
		});
	}
	return findings;
}

export async function runGitHistorySecretScanActivity(
	input: RunGitHistorySecretScanInput,
): Promise<RunGitHistorySecretScanOutput> {
	const { projectId, workflowRunId } = input;
	const empty = (
		skipped: RunGitHistorySecretScanOutput["skipped"],
		repo?: string,
	): RunGitHistorySecretScanOutput => ({
		findings: [],
		skipped,
		changedCommitCount: 0,
		...(repo ? { repo } : {}),
	});

	const repos = await getProjectReposForCodeSearch(projectId);
	if (repos.length === 0) {
		logger.info(
			"[GitHistoryScan] No active repository connected — skipping",
			{
				projectId,
			},
		);
		return empty("no-repo");
	}
	const repo = repos[0];
	const repoSlug = `${repo.owner}/${repo.repo}`;

	const clonePath = path.join(
		os.tmpdir(),
		`fabric-gitleaks-${workflowRunId}`,
	);
	const reportPath = path.join(
		os.tmpdir(),
		`fabric-gitleaks-${workflowRunId}.json`,
	);

	try {
		return await withHeartbeat(async () => {
			const authUrl = await buildAuthenticatedCloneUrl(repo);
			if (!authUrl) {
				return empty("clone-failed", repoSlug);
			}

			await fs.rm(clonePath, { recursive: true, force: true });
			const simpleGit = (await import("simple-git")).default;
			// Resolve the branch to clone: the workflow-provided branch (kept in
			// sync with the resolve step's SHA), else the project's configured
			// scanBranch, else the repo's default, else "main".
			const scanConfig = await getProjectScanConfig(projectId);
			const targetBranch =
				input.branch?.trim() ||
				scanConfig.scanBranch?.trim() ||
				repo.branch ||
				"main";
			try {
				Context.current().heartbeat("cloning (full history)");
				// FULL clone (no --depth) so gitleaks can inspect every commit —
				// and so the base commit is present for the incremental log-opts
				// scoping below (no --shallow-exclude fetch needed).
				await simpleGit().clone(authUrl, clonePath, [
					"--single-branch",
					"--branch",
					targetBranch,
				]);
			} catch (error) {
				logger.warn("[GitHistoryScan] Clone failed — skipping", {
					projectId,
					repo: repoSlug,
					branch: targetBranch,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return empty("clone-failed", repoSlug);
			}

			// Incremental scope (DIFF mode): validate the base is reachable and
			// count the new commits, then scope gitleaks to `base..HEAD` so only
			// commits added since the last scan are re-inspected. If the base is
			// unreachable (history rewritten) we fall back to a full scan.
			let changedCommitCount = 0;
			let logOpts: string | undefined;
			if (input.codeScanMode === "DIFF" && input.baseSha) {
				const baseSha = input.baseSha;
				try {
					const countOut = await simpleGit(clonePath).raw([
						"rev-list",
						"--count",
						`${baseSha}..HEAD`,
					]);
					const n = Number.parseInt(countOut.trim(), 10);
					changedCommitCount = Number.isFinite(n) && n >= 0 ? n : 0;
					logOpts = `${baseSha}..HEAD`;
				} catch (error) {
					logger.warn(
						"[GitHistoryScan] Base commit unreachable — scanning full history",
						{
							projectId,
							repo: repoSlug,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
					changedCommitCount = 0;
					logOpts = undefined;
				}
			}

			// Run gitleaks. It exits non-zero when leaks are found, but still
			// writes the JSON report, so we read the report regardless of exit
			// code; only a missing binary is fatal.
			Context.current().heartbeat("running gitleaks");
			const detectArgs = (extra: string[]): string[] => [
				"detect",
				"--source",
				clonePath,
				"--report-format",
				"json",
				"--report-path",
				reportPath,
				"--redact",
				"--no-banner",
				...extra,
			];
			const runDetect = async (
				extra: string[],
			): Promise<"ok" | "missing-binary"> => {
				await fs.rm(reportPath, { force: true }).catch(() => {});
				try {
					await execFileAsync("gitleaks", detectArgs(extra), {
						maxBuffer: GITLEAKS_MAX_BUFFER,
					});
				} catch (error) {
					if (isBinaryMissing(error)) {
						return "missing-binary";
					}
					// Non-zero exit with leaks found is expected; fall through to
					// read the report. Any other error degrades to a clean skip.
				}
				return "ok";
			};

			let detect = await runDetect(
				logOpts ? ["--log-opts", logOpts] : [],
			);
			if (detect === "missing-binary") {
				logger.warn(
					"[GitHistoryScan] gitleaks binary not found — skipping (rebuild the worker image with gitleaks)",
					{ projectId, repo: repoSlug },
				);
				return empty("gitleaks-unavailable", repoSlug);
			}
			// A scoped (DIFF) run that produced no report likely hit a bad range —
			// fall back to a full scan rather than mis-reporting a clean history.
			if (logOpts) {
				const reportExists = await fs
					.stat(reportPath)
					.then(() => true)
					.catch(() => false);
				if (!reportExists) {
					logger.warn(
						"[GitHistoryScan] Scoped scan produced no report — falling back to full history",
						{ projectId, repo: repoSlug },
					);
					changedCommitCount = 0;
					detect = await runDetect([]);
					if (detect === "missing-binary") {
						return empty("gitleaks-unavailable", repoSlug);
					}
				}
			}

			let raw: string;
			try {
				raw = await fs.readFile(reportPath, "utf8");
			} catch {
				// No report written → treat as clean (graceful degradation).
				logger.info("[GitHistoryScan] No report — treating as clean", {
					projectId,
					repo: repoSlug,
				});
				return {
					findings: [],
					skipped: null,
					repo: repoSlug,
					changedCommitCount,
				};
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return empty("gitleaks-unavailable", repoSlug);
			}

			const findings = parseGitleaksResults(
				parsed,
				repoSourceFromRepo(repo, targetBranch),
			);
			logger.info("[GitHistoryScan] Completed", {
				projectId,
				repo: repoSlug,
				findings: findings.length,
				codeScanMode: logOpts ? "DIFF" : "FULL",
				changedCommitCount,
			});
			return {
				findings,
				skipped: null,
				repo: repoSlug,
				changedCommitCount,
			};
		});
	} finally {
		await fs
			.rm(clonePath, { recursive: true, force: true })
			.catch(() => {});
		await fs.rm(reportPath, { force: true }).catch(() => {});
	}
}
