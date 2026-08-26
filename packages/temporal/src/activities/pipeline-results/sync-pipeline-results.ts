/**
 * Pipeline-results sync activity (cards 1834 / 1688). The live "pull" that closes
 * the QA loop: for each connected code repo (Azure DevOps, GitHub, GitLab), it
 * resolves the stored credential, fetches CI runs newer than the stored cursor,
 * ingests them through the Phase-03 engine, advances the cursor, and (when the
 * project opted in) opens BUGs for cases left FAILED.
 *
 * Design notes:
 *  - Per-source isolation: one bad source records a sync failure and is skipped;
 *    the others still sync. A source's cursor only advances on success, so a
 *    failed fetch is retried whole next time (never silently skipped).
 *  - Provider dispatch: each provider has a thin fetcher (list→results→normalize)
 *    behind the shared `NormalizedRun` contract, so linkage / ingest / RCA are
 *    identical regardless of source. A provider we don't fetch is surfaced as an
 *    unsupported source (FR6), never a silent no-op.
 *  - `new Date()` is fine — this is an activity (non-deterministic side lives here,
 *    the workflow stays pure).
 */

import {
	advancePipelineSyncState,
	getPipelineSyncCursor,
	getProjectReposForPipelineSync,
	openBugsForFailedCases,
	parseRepoUrl,
	recordPipelineSyncFailure,
} from "@repo/database";
import {
	type RepoTokenRefreshFault,
	resolveFreshRepoToken,
} from "@repo/integrations";
import { logger } from "@repo/logs";
import { safeHeartbeat } from "../lib/activity-liveness";
import { createAdoPatClient } from "./fetchers/ado-client";
import { fetchAzureDevOpsRuns } from "./fetchers/azure-devops-fetcher";
import { fetchGithubActionsRuns } from "./fetchers/github-actions-fetcher";
import { createGithubTokenClient } from "./fetchers/github-client";
import { fetchGitlabCiRuns } from "./fetchers/gitlab-ci-fetcher";
import {
	createGitlabTokenClient,
	gitlabApiBaseFromRepoUrl,
} from "./fetchers/gitlab-client";
import { ProviderHttpError } from "./fetchers/provider-http-error";
import { ingestNormalizedRuns } from "./ingest-pipeline-results";
import type { NormalizedRun } from "./normalized-result";
import {
	classificationForKind,
	classifySyncFailure,
	type SyncFailureClassification,
} from "./sync-failure-classification";

type RepoSource = Awaited<
	ReturnType<typeof getProjectReposForPipelineSync>
>[number];

/**
 * Provider key the mapper/fetcher/ingest all agree on (see normalized-result).
 * Also the `provider` stored on the sync-state cursor row, so the key stays
 * stable per source type. Keyed by the query's own `provider` union, so adding a
 * provider to the schema fails to compile here until it gets a tag — a real
 * exhaustiveness tie, not a runtime hope.
 */
const PROVIDER_TAG: Record<RepoSource["provider"], string> = {
	AZURE_DEVOPS: "azure-devops",
	GITHUB: "github-actions",
	GITLAB: "gitlab-ci",
};

/**
 * Refine a fetch-failure classification with what we already know about the
 * credential we sent.
 *
 * The hazard: `resolveFreshRepoToken` falls back to the EXPIRED stored access
 * token whenever a refresh fails, and a refresh can fail for reasons that are
 * entirely ours — the deployment has no `FABRIC_GITHUB_CLIENT_ID` /
 * `FABRIC_GITHUB_CLIENT_SECRET` (or the GitLab pair), the provider's token
 * endpoint is down, our own database threw. The provider then answers 401 and
 * `classifySyncFailure` reads it as `CREDENTIAL_REJECTED` — the customer's
 * expired grant, `warn`, "reconnect the repository". A deployment-wide loss of
 * the OAuth client credentials would therefore downgrade a platform-wide
 * outage to a per-customer warning on EVERY expired integration at once: the
 * same inversion `credentialFault` / `DECRYPT_FAILED` was added to prevent, one
 * seam further along.
 *
 * Narrow on purpose — only `CREDENTIAL_REJECTED` is upgraded. A 403
 * (`PERMISSION_MISSING` / `SSO_REQUIRED`) means the token AUTHENTICATED and was
 * refused the resource, which a failed refresh does not explain; a 429 or 404
 * likewise says nothing about our refresh. Upgrading those would trade one
 * misattribution for another.
 *
 * `stale` is deliberately NOT part of this decision, though it is logged. It
 * says the token we sent was past its expiry, which is already implied
 * whenever a refresh was attempted and failed; on its own it cannot tell a
 * platform refresh failure from a genuinely revoked grant, and a 401 after a
 * grant-shaped refresh failure IS the customer's to fix. Letting `stale` alone
 * force `UNKNOWN` would silence exactly the "reconnect your repository" signal
 * a customer with a dead grant needs.
 */
function classifyWithRefreshFault(
	classification: SyncFailureClassification,
	refreshFault: RepoTokenRefreshFault | undefined,
): SyncFailureClassification {
	if (refreshFault && classification.kind === "CREDENTIAL_REJECTED") {
		return classificationForKind("UNKNOWN");
	}
	return classification;
}

export interface SyncPipelineResultsInput {
	projectId: string;
	organizationId: string | null;
	/** The user the sync is attributed to (drives RCA bug authorship). */
	userId: string | null;
	/** Limit to one repo integration; omit to sync every connected source. */
	integrationId?: string;
	/** Project opt-in for RCA→BUG (Project.autoCreateBugsFromFailures). */
	autoCreateBugsFromFailures?: boolean;
	/** How many recent runs to scan per source (fetcher default when omitted). */
	maxRuns?: number;
}

export interface SyncPipelineResultsResult {
	/** Sources actually attempted (had a usable credential + supported provider). */
	sourcesAttempted: number;
	ingestedRuns: number;
	skippedRuns: number;
	matched: number;
	unmatched: number;
	bugsOpened: number;
	/** Per-source failures — surfaced so the caller can report a partial sync. */
	errors: Array<{ source: string; error: string }>;
}

/** What a fetcher returns, uniform across providers. */
interface FetchOutput {
	runs: NormalizedRun[];
	/** Highest external run/pipeline id seen — stored as the next cursor. */
	newCursor: number | null;
	/**
	 * True when the fetcher's page cap stopped it before it reached the cursor,
	 * i.e. runs older than the ones returned exist and were NOT fetched. Surfaced
	 * so an enormous first sync can't read as a clean drain.
	 */
	truncated?: boolean;
}

/**
 * The per-source fetch plan the shared loop drives, or why one couldn't be
 * built. `providerTag` + `pipelineKey` are the sync-state scope keys and are
 * derived WITHOUT the token, so a credential failure records under the SAME key
 * a later success uses (for ADO that's the project segment, not `owner/repo`).
 * `makeFetch` binds the resolved token to the actual network call.
 */
type FetchPlan =
	| {
			ok: true;
			/** sync-state provider key (also the mapper's provider tag). */
			providerTag: string;
			/** Cursor scope key — the ADO project or the `owner/repo` path. */
			pipelineKey: string;
			makeFetch: (
				token: string,
			) => (sinceRunId: number | null) => Promise<FetchOutput>;
	  }
	| { ok: false; error: string };

/**
 * The sync-state key used when a source's plan cannot be derived at all.
 *
 * Plan derivation fails exactly when the real pipeline key is unknowable, so
 * something stable has to stand in. Defined once and used by BOTH the failure
 * write and the success-path clear — the bug this exists to prevent is the two
 * drifting apart, which is what left ADO failure banners un-clearable: the
 * failure wrote `owner/repo` while a later success wrote `project/repo`.
 */
function planFallbackKey(source: RepoSource): string {
	return `${source.owner}/${source.repo}`;
}

/**
 * Derive the provider-specific fetch plan for one connected source. Pure — no
 * token, no network: it resolves the cursor scope keys and returns `makeFetch`,
 * which the shared loop invokes with the resolved credential. Returns
 * `{ ok: false }` with a user-facing reason when the source can't be pulled (bad
 * URL, unsafe host, unsupported provider).
 */
function derivePlan(
	source: RepoSource,
	maxRuns: number | undefined,
): FetchPlan {
	switch (source.provider) {
		case "AZURE_DEVOPS": {
			// Reuse the canonical repo-URL parser (it captures the ADO project
			// segment the Test Runs API is scoped to). `azureOrganization` wins for
			// the org when the integration stored it explicitly.
			const parsed = parseRepoUrl(source.repositoryUrl);
			const org = source.azureOrganization || parsed?.owner;
			const project = parsed?.project;
			if (
				!parsed ||
				parsed.provider !== "AZURE_DEVOPS" ||
				!org ||
				!project
			) {
				return {
					ok: false,
					error: "Could not determine the Azure DevOps org/project from the repo URL.",
				};
			}
			return {
				ok: true,
				providerTag: PROVIDER_TAG.AZURE_DEVOPS,
				pipelineKey: `${project}/${source.repo ?? parsed.name}`,
				makeFetch: (token) => {
					const client = createAdoPatClient(org, token);
					return (sinceRunId) =>
						fetchAzureDevOpsRuns(client, {
							project,
							sinceRunId,
							maxRuns,
							// The per-repo QA branch override. ADO ignored it
							// entirely while the settings UI offered the field
							// and the log below claimed a filter was applied.
							branch: source.branch ?? undefined,
						});
				},
			};
		}
		case "GITHUB": {
			if (!source.owner || !source.repo) {
				return {
					ok: false,
					error: "Could not determine the GitHub owner/repo for this source.",
				};
			}
			const { owner, repo, branch } = source;
			return {
				ok: true,
				providerTag: PROVIDER_TAG.GITHUB,
				pipelineKey: `${owner}/${repo}`,
				makeFetch: (token) => {
					const client = createGithubTokenClient(token);
					return (sinceRunId) =>
						fetchGithubActionsRuns(client, {
							owner,
							repo,
							branch: branch || undefined,
							sinceRunId,
							maxRuns,
						});
				},
			};
		}
		case "GITLAB": {
			if (!source.owner || !source.repo) {
				return {
					ok: false,
					error: "Could not determine the GitLab project path for this source.",
				};
			}
			const apiBase = gitlabApiBaseFromRepoUrl(source.repositoryUrl);
			if (!apiBase) {
				return {
					ok: false,
					error: "The GitLab repository URL is not a usable https host for API access.",
				};
			}
			const projectPath = `${source.owner}/${source.repo}`;
			const ref = source.branch || undefined;
			return {
				ok: true,
				providerTag: PROVIDER_TAG.GITLAB,
				pipelineKey: projectPath,
				makeFetch: (token) => {
					const client = createGitlabTokenClient(apiBase, token);
					return (sinceRunId) =>
						fetchGitlabCiRuns(client, {
							projectPath,
							ref,
							sincePipelineId: sinceRunId,
							maxRuns,
						});
				},
			};
		}
		default: {
			// FR6: a connected source whose provider we don't fetch is surfaced as
			// unsupported, never silently dropped. PROVIDER_TAG's enum typing already
			// forces a new provider to be handled above before it compiles.
			const unhandled: never = source.provider;
			return {
				ok: false,
				error: `Pipeline results aren't supported for ${String(unhandled)} sources yet.`,
			};
		}
	}
}

export async function syncPipelineResultsForProject(
	input: SyncPipelineResultsInput,
): Promise<SyncPipelineResultsResult> {
	const result: SyncPipelineResultsResult = {
		sourcesAttempted: 0,
		ingestedRuns: 0,
		skippedRuns: 0,
		matched: 0,
		unmatched: 0,
		bugsOpened: 0,
		errors: [],
	};

	/**
	 * When THIS activity invocation started, stamped onto every sync-state write
	 * it makes (both the failure and the success path).
	 *
	 * It is the ordering token for the monotonic guard in
	 * `recordPipelineSyncFailure` / `advancePipelineSyncState`. The advisory lock
	 * those two share serializes their writes but says nothing about which
	 * ATTEMPT is newer, and two attempts genuinely overlap in production: the
	 * activity declares `heartbeatTimeout: 30 seconds` with `maximumAttempts: 3`,
	 * and Temporal does not kill a heartbeat-timed-out attempt — it starts
	 * another while the first is still hung. Without an ordering token, that
	 * first attempt can wake up and commit FAILED on top of the second attempt's
	 * SUCCESS, leaving a stale failure row and a stale banner.
	 *
	 * MUST stay above every `await` in this function, including the integration
	 * read below. A capture taken after an await records when that await
	 * RETURNED, not when the attempt began — and the hung call an attempt is
	 * timing out on can just as easily be the integration query as a provider
	 * fetch. An attempt that blocked there long enough to be superseded would
	 * then wake up, take a LATER timestamp than the attempt that overtook it,
	 * and pass the guard as "newer" — inverting the exact ordering the guard
	 * exists to establish.
	 *
	 * Captured ONCE per invocation rather than per source so all of an attempt's
	 * writes carry the same identity: the guard is about which attempt won, not
	 * about when within an attempt a particular source happened to finish.
	 * `lastFetchedAt` / `failedAt` stay per-write `new Date()` values — those are
	 * "when did this actually happen" facts a human reads, not ordering tokens.
	 *
	 * A wall clock is sufficient here and no attempt-sequence table is needed.
	 * The race being closed is a heartbeat-timed-out attempt being overtaken,
	 * which is a window at least as wide as the 30-second heartbeat timeout,
	 * while clock skew between NTP-synced workers is milliseconds — the two are
	 * four orders of magnitude apart. Sub-millisecond precision is not required,
	 * and two attempts landing on the same millisecond are handled by
	 * `attemptSupersedes` permitting equality on purpose (see its doc), not by
	 * tie-breaking them.
	 */
	const attemptStartedAt = new Date();

	const integrations = await getProjectReposForPipelineSync(input.projectId);
	const sources = integrations.filter(
		(i) => !input.integrationId || i.integrationId === input.integrationId,
	);

	/**
	 * Persist a per-source failure AND write it to the structured logger.
	 *
	 * The observability requirement — "fetch errors should be logged for
	 * support diagnosis" — was unmet: failures landed only on
	 * `TestPipelineSyncState.lastError`, which the UI renders but no log
	 * aggregation can see. Diagnosing a customer's silent sync meant asking them
	 * to read their own screen, or querying their database.
	 *
	 * Every failure goes through here so the two can't drift: a row without a log
	 * line is exactly the invisible case this closes.
	 *
	 * Log LEVEL follows `classification.severity`, not a blanket `error` (card
	 * #2383): most per-source failures are the CUSTOMER's problem — an expired
	 * token, a missing permission, SSO enforcement, a rate limit — and the cron
	 * in `schedules.ts` re-fires this every 15 minutes forever, which is how one
	 * stuck credential became 624 error-level lines in 12 hours across 9
	 * projects with nothing an engineer could do about any of them.
	 *
	 * `UNKNOWN` is the one kind that stays at `error` on EVERY cycle, repeat or
	 * not — that is where a genuine service fault (a 5xx, a network failure, an
	 * internal exception) has to stay loud, since suppressing it would hide a
	 * real outage behind "just another expected sync failure". Every other kind
	 * warns on the cycle it FIRST enters this failure state (so a state change
	 * is still visible) and steps down to `info` on an IDENTICAL repeat — same
	 * provider/pipelineKey and same `kind`, per `recordPipelineSyncFailure`'s
	 * `repeat` flag — so the row stays discoverable (still one line every cycle)
	 * without paging anyone for a token that has been expired for six hours.
	 *
	 * `opts.error` is ALWAYS the real, possibly-sensitive message and ALWAYS
	 * goes to the structured logger — engineers diagnosing a fault need it
	 * verbatim. What gets PERSISTED (`lastError`/`lastErrorDetail`, rendered by
	 * both the QA-tab banner and the Settings ▸ Development sync-health
	 * section) is different for `UNKNOWN`: a caught exception's `.message` is
	 * an arbitrary string that can carry configuration, an endpoint URL, or
	 * even ciphertext (a database, crypto, or refresh-library error can say
	 * anything), so it is never safe to show a customer just because it
	 * happened to be attached to a caught `Error`. Every OTHER kind is
	 * provider- or classifier-crafted prose (`provider-http-error.ts`'s
	 * messages, or this file's own "no usable credential" sentences) that is
	 * already written to be customer-facing, so it persists unchanged.
	 */
	const GENERIC_INTERNAL_FAILURE_MESSAGE =
		"Fabric hit an internal error syncing this pipeline. The error has been recorded — no action is needed from you.";

	const failSource = async (opts: {
		provider: string;
		pipelineKey: string;
		sourceLabel: string;
		error: string;
		/**
		 * Exactly what the provider replied, when it was an HTTP failure.
		 *
		 * Recorded separately from `error` so the surface can show a readable
		 * sentence and reveal the raw body on demand, rather than printing a JSON
		 * blob inside a sentence — which is what happens when the two are joined
		 * before anyone decides how to display them. Dropped entirely for
		 * `UNKNOWN` (see the level/severity note below) — the "Show what the
		 * provider returned" toggle is exactly as customer-visible as `error`.
		 */
		errorDetail?: string | null;
		/** Shorter text for the caller-facing result; defaults to the persisted `error`. */
		resultError?: string;
		/** Whose fault this is and whether reconnecting fixes it. */
		classification: SyncFailureClassification;
		/** The provider's own HTTP status — only set for a `ProviderHttpError`. */
		status?: number;
		/**
		 * Why refreshing this source's credential failed for a reason that is
		 * ours. Logged, never persisted: it is an internal diagnostic, and
		 * `classifyWithRefreshFault` has already folded its consequence into
		 * `classification`.
		 */
		refreshFault?: RepoTokenRefreshFault;
		/** Whether the token we sent was already past its expiry. Logged only. */
		staleToken?: boolean;
	}): Promise<void> => {
		const isOurFault = opts.classification.severity === "error";
		// The only place this substitution happens — callers never need to
		// remember to sanitize a message themselves, which is what makes this
		// safe against a future UNKNOWN call site forgetting to.
		const persistedError = isOurFault
			? GENERIC_INTERNAL_FAILURE_MESSAGE
			: opts.error;
		const persistedErrorDetail = isOurFault
			? null
			: (opts.errorDetail ?? null);

		// Read-before-write: `repeat` decides the log level below, and
		// `recordPipelineSyncFailure` is what compares against the PRIOR row
		// (never against this write), so it has to happen first.
		//
		// `applied` is false when the monotonic guard dropped the write because a
		// NEWER attempt had already written this row (see `attemptStartedAt`
		// above). This attempt's failure is then stale — it must not be reported
		// as a fresh transition into failure, or an overlapping attempt would
		// produce exactly the spurious failure signal this change exists to stop.
		const { repeat, applied } = await recordPipelineSyncFailure({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			provider: opts.provider,
			pipelineKey: opts.pipelineKey,
			error: persistedError,
			errorDetail: persistedErrorDetail,
			kind: opts.classification.kind,
			failedAt: new Date(),
			attemptStartedAt,
		});

		// A dropped (stale) write is levelled like a repeat: still one line per
		// cycle so nothing goes invisible, but never a transition-level `warn`
		// for a result that did not become the row's state. `UNKNOWN` is
		// unaffected — a 5xx or an internal exception really did happen during
		// this attempt, and stays at `error` whether or not its row write landed.
		const level: "error" | "warn" | "info" = isOurFault
			? "error"
			: repeat || !applied
				? "info"
				: "warn";

		logger[level]("qa.pipeline.sync.source_failed", {
			projectId: input.projectId,
			organizationId: input.organizationId,
			provider: opts.provider,
			pipelineKey: opts.pipelineKey,
			source: opts.sourceLabel,
			// The REAL message, unsanitized — logs are the engineer-facing
			// surface, never the customer-facing one.
			error: opts.error,
			// Structured, not just embedded in `error`, so monitoring can group by
			// kind without regexing the message. `status` only exists for HTTP
			// failures, so it is omitted rather than logged as `undefined`.
			kind: opts.classification.kind,
			// Only present when the write was dropped, so the default query shape
			// stays unchanged and `stale: true` is searchable on its own.
			...(applied ? {} : { stale: true }),
			...(opts.status !== undefined ? { status: opts.status } : {}),
			// Why our own refresh failed, and whether we knowingly sent an
			// expired token — the two facts that separate "their grant died"
			// from "we could not renew it". Omitted when neither applies.
			...(opts.refreshFault ? { refreshFault: opts.refreshFault } : {}),
			...(opts.staleToken ? { staleToken: true } : {}),
		});

		result.errors.push({
			source: opts.sourceLabel,
			error: opts.resultError ?? persistedError,
		});
	};

	for (const source of sources) {
		const sourceLabel = source.repositoryUrl;
		// The workflow declares a 30s heartbeatTimeout. One source can easily
		// exceed that on its own (list -> per-run detail -> artifact download ->
		// parse -> ingest), so check in before each one and again after the
		// fetch, or Temporal kills a perfectly healthy sync and retries it.
		safeHeartbeat({ source: sourceLabel });

		// Derive the cursor scope keys FIRST (no token needed), so every failure
		// path below records under the same provider/pipelineKey a success uses.
		const plan = derivePlan(source, input.maxRuns);
		if (!plan.ok) {
			// Bad repo URL / unsupported provider — always user-actionable
			// (fix the connection), never a service fault.
			await failSource({
				provider: PROVIDER_TAG[source.provider] ?? source.provider,
				pipelineKey: planFallbackKey(source),
				sourceLabel,
				error: plan.error,
				classification: classificationForKind("MISCONFIGURED"),
			});
			continue;
		}

		// Resolve the stored credential. A missing/undecryptable token is a
		// recorded sync failure, not a thrown activity — the other sources run.
		let token: string | null = null;
		let credentialFault: "ABSENT" | "DECRYPT_FAILED" | undefined;
		// Why a REFRESH of this credential failed, when the reason is ours (no
		// deployment OAuth client credentials, a token-endpoint outage, our own
		// database throwing). Set even when a token came back — the resolver's
		// fallback on a failed refresh is the expired STORED token, and the
		// provider is about to reject it. See `RepoTokenRefreshFault`.
		let refreshFault: RepoTokenRefreshFault | undefined;
		// The resolver's own "the token I am handing you is past its expiry"
		// flag. Diagnostic only — see the classification note at the fetch
		// catch below for why it does not drive the classification by itself.
		let staleToken = false;
		let tokenResolutionFault: Error | null = null;
		try {
			const resolved = await resolveFreshRepoToken({
				integrationId: source.integrationId,
				projectId: input.projectId,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			token = resolved.token;
			credentialFault = resolved.credentialFault;
			refreshFault = resolved.refreshFault;
			staleToken = resolved.stale === true;
		} catch (err) {
			// A THROW here is OURS, not the customer's — `resolveFreshRepoToken`'s
			// own contract is "never throws"; a DB error or a bug getting here
			// means something genuinely broke. Keep the thrown error's own
			// message for the logs — nothing on this path ever holds a decrypted
			// token value, so there is nothing to leak — and classify it UNKNOWN
			// so it stays at `error` on every cycle like any other fault.
			tokenResolutionFault =
				err instanceof Error ? err : new Error(String(err));
		}
		if (tokenResolutionFault) {
			await failSource({
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
				sourceLabel,
				error: `Credential resolution failed unexpectedly: ${tokenResolutionFault.message}`,
				resultError:
					"Credential resolution failed unexpectedly — see server logs.",
				classification: classificationForKind("UNKNOWN"),
			});
			continue;
		}
		if (!token) {
			// `credentialFault` distinguishes WHY the token is null.
			// `DECRYPT_FAILED` means ciphertext was stored but `decryptApiKey`
			// threw — a platform fault (a lost/rotated encryption key, corrupted
			// ciphertext), not the customer's: EVERY tenant's stored token would
			// fail to decrypt at once, and reconnecting cannot fix a broken
			// decryption key. That must classify UNKNOWN (stays `error` every
			// cycle, and never offers a reconnect the customer cannot act on) —
			// the exact inverse of what this change exists to fix if it were
			// left as CREDENTIAL_MISSING.
			// `ABSENT` (or unset, from paths that never reached `safeDecrypt` —
			// e.g. the integration row itself vanished) is a cleanly-resolved
			// absent credential — genuinely the customer's problem.
			//
			// A `refreshFault` lands in the same bucket for the same reason at a
			// DIFFERENT seam: we tried to refresh and could not even attempt it
			// (no deployment OAuth client credentials) or the token endpoint /
			// our database failed. Nothing about that says the customer's grant
			// is bad, and it hits every expired integration on the deployment at
			// once.
			const isDecryptFault = credentialFault === "DECRYPT_FAILED";
			const isPlatformFault =
				isDecryptFault || refreshFault !== undefined;
			await failSource({
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
				sourceLabel,
				error: isDecryptFault
					? `Stored ${source.provider} credential is present but could not be decrypted.`
					: refreshFault
						? `Could not refresh the stored ${source.provider} credential (${refreshFault}), and no usable token remained.`
						: `No usable ${source.provider} credential — reconnect the repo with a token scoped to read CI test results.`,
				resultError: isDecryptFault
					? "Stored credential could not be decrypted — see server logs."
					: refreshFault
						? "Credential refresh failed — see server logs."
						: `No usable ${source.provider} credential.`,
				classification: classificationForKind(
					isPlatformFault ? "UNKNOWN" : "CREDENTIAL_MISSING",
				),
				refreshFault,
				staleToken,
			});
			continue;
		}

		const fetchRuns = plan.makeFetch(token);
		result.sourcesAttempted++;

		try {
			const cursorRow = await getPipelineSyncCursor({
				projectId: input.projectId,
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
			});
			const parsedCursor = cursorRow?.lastRunExternalId
				? Number(cursorRow.lastRunExternalId)
				: null;
			const sinceRunId =
				parsedCursor != null && Number.isFinite(parsedCursor)
					? parsedCursor
					: null;

			const { runs, newCursor, truncated } = await fetchRuns(sinceRunId);

			// The branch is the single most common reason a sync "works" but
			// returns nothing: it follows the repo's qaBranch override, else its
			// default. Logged per source so a silent empty pull is diagnosable
			// without reproducing it.
			safeHeartbeat({ source: sourceLabel, fetched: runs.length });
			logger.info("qa.pipeline.sync.fetched", {
				projectId: input.projectId,
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
				branch: source.branch ?? null,
				sinceRunId,
				fetchedRuns: runs.length,
				truncated: truncated ?? false,
			});
			if (truncated) {
				// Not an error — the backlog simply exceeded one sync's page cap
				// and the rest will drain on the next runs. Logged because
				// "ingested N" alone would read as "that was all of them".
				logger.warn("qa.pipeline.sync.backlog_truncated", {
					projectId: input.projectId,
					provider: plan.providerTag,
					pipelineKey: plan.pipelineKey,
					fetchedRuns: runs.length,
				});
			}

			const ingest = await ingestNormalizedRuns({
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				runs,
				// A successful run on the branch this source watches counts as a
				// deployment, which marks ON_DEPLOY-enrolled documents due. Uses
				// the SAME branch the sync already filters on, so "what Fabric
				// considers a deploy" cannot drift from "what Fabric reads".
				deployBranch: source.branch ?? null,
			});
			result.ingestedRuns += ingest.ingestedRuns;
			result.skippedRuns += ingest.skippedRuns;
			result.matched += ingest.matched;
			result.unmatched += ingest.unmatched;

			// RCA→BUG (opt-in) runs BEFORE the cursor advances: if it throws, the
			// cursor is NOT advanced, so a retry re-fetches the same runs and
			// re-attempts RCA (ingest is idempotent; bugs dedup per case) rather
			// than skipping past the failed cases forever. Needs an attributable
			// creator; a system-triggered sync with no user skips bug creation.
			if (
				input.autoCreateBugsFromFailures &&
				input.userId &&
				ingest.touchedCaseIds.length > 0
			) {
				result.bugsOpened += await openBugsForFailedCases({
					projectId: input.projectId,
					createdById: input.userId,
					testCaseIds: ingest.touchedCaseIds,
				});
			}

			// Advance the cursor only after a successful ingest AND RCA. Keep the
			// prior high-watermark when this fetch surfaced nothing new (newCursor
			// null).
			await advancePipelineSyncState({
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
				lastRunExternalId:
					newCursor != null
						? String(newCursor)
						: (cursorRow?.lastRunExternalId ?? null),
				fetchedAt: new Date(),
				attemptStartedAt,
				// The key this source's plan-derivation failure would have used.
				// It differs from the success key for ADO (`owner/repo` vs
				// `project/repo`), so a repository URL that was fixed left its
				// original failure row — and its banner — behind forever.
				clearFallbackKey: planFallbackKey(source),
			});
		} catch (err) {
			await failSource({
				provider: plan.providerTag,
				pipelineKey: plan.pipelineKey,
				sourceLabel,
				error: err instanceof Error ? err.message : String(err),
				// Only a ProviderHttpError carries the provider's own body; every
				// other failure here is ours and has nothing to reveal.
				errorDetail:
					err instanceof ProviderHttpError
						? err.providerDetail
						: null,
				classification: classifyWithRefreshFault(
					classifySyncFailure(err),
					refreshFault,
				),
				status:
					err instanceof ProviderHttpError ? err.status : undefined,
				refreshFault,
				staleToken,
			});
		}
	}

	return result;
}
