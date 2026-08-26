/**
 * Publishing Suggestion Generation Workflow (Publishing Suite 1A — Task 9)
 *
 * The crux of the 1A engine: ties Tasks 5/6/7/8 + Task 3's persistence together.
 * Mirrors `daily-brief-generation-workflow.ts` (proxyActivities groups +
 * `Promise.allSettled` fan-out + terminal persist), but is smaller: no signals,
 * no queries, no continue-as-new.
 *
 * Outcome matrix is implemented in code below, not prose:
 *   assert tenant+cycle (fail-closed) → collect (tolerating partial failure) →
 *   classify succeeded/failed sources → if 0 succeeded throw
 *   PUBLISHING_ALL_SOURCES_FAILED → inlined sufficiency (PRs≥3 || transcripts≥1
 *   || documents≥2; stories EXCLUDED) → F7 freshness → F3 cumulative coverage →
 *   summarize → dedupe-key → CAS persist. A lost CAS ⇒ SUPERSEDED (M6, no
 *   markCycleFailed). Any thrown error ⇒ markCycleFailed then rethrow (FAILED is
 *   thrown, never returned).
 *
 * DETERMINISM: no `Date.now()`, no-arg `new Date()`, `Math.random()`,
 * `process.env`, or node built-ins in this body. Time boundaries derive ONLY
 * from `input.coveredThroughIso` (parsing a FIXED ISO string is deterministic).
 * The `node:crypto` dedupe-key hash lives in the `computeSuggestionTopics`
 * ACTIVITY (Step 4), never here.
 */
import type {
	PersistCycleTerminalInput,
	persistCycleTerminal as PersistFn,
	PublishingPreferencesSnapshot,
	PublishingTopicSuggestions,
	SourceCoverage,
} from "@repo/database";
import {
	ApplicationFailure,
	log,
	patched,
	proxyActivities,
} from "@temporalio/workflow";
import type * as acts from "../activities/publishing-suggestion";
// Runtime helper from a local, workflow-safe pure module (no imports at all →
// sandbox-safe, deterministic), importable into the workflow exactly like
// `./daily-brief-release-note-exclusions`.
import { publishingChatFailureDetail } from "./publishing-chat-failure-detail";
import { notificationActivationInput } from "./publishing-suggestion-notify-activation";
import { buildPrAuthorGithubIdByPr } from "./publishing-suggestion-pr-authors";

// =============================================================================
// Activity proxies
// =============================================================================

const short = {
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "1 minute",
} as const;
// collectReleases wraps `collectGitHubReleasesActivity`, whose OWN internal soft
// deadline is ~165s (2.75 min) — it EXCEEDS the 2-min `short` startToCloseTimeout,
// so a uniform 2-min group would kill it mid-fetch. Give it a dedicated 3-min
// deadline, mirroring the daily-brief workflow's releases proxy. `collectPullRequests`
// (~105s) fits the tight 2-min `short` group.
const releases = {
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "1 minute",
} as const;
const long = {
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
} as const;

// JS programming errors are deterministic — retrying burns attempts without
// changing the outcome. Mark them non-retryable so bugs surface fast.
const PROG = ["TypeError", "ReferenceError", "SyntaxError"] as const;

const {
	assertProjectTenantTuple,
	collectStories,
	collectDocuments,
	collectTranscripts,
	collectPullRequests,
} = proxyActivities<typeof acts>({
	...short,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		nonRetryableErrorTypes: [...PROG, "PUBLISHING_TENANT_MISMATCH"],
	},
});

const { collectReleases } = proxyActivities<typeof acts>({
	...releases,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		nonRetryableErrorTypes: [...PROG],
	},
});

const { summarizeTopicSuggestions } = proxyActivities<typeof acts>({
	...long,
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [
			"PUBLISHING_SCHEMA_VALIDATION_FAILED",
			"PUBLISHING_ACTOR_INVALID",
			...PROG,
		],
	},
});

const {
	persistCycleTerminal,
	markCycleFailed,
	computeSuggestionTopics,
	resolveTopicContributors,
} = proxyActivities<{
	persistCycleTerminal: typeof PersistFn;
	markCycleFailed: (
		cycleId: string,
		projectId: string,
		err: string,
	) => Promise<void>; // F5: projectId-scoped CAS
	// F4: typed end-to-end — takes the summarizer's topics, returns them with a
	// dedupeKey, matching exactly what persistCycleTerminal requires (no
	// `unknown` narrowing gaps).
	computeSuggestionTopics: (args: {
		projectId: string;
		topics: PublishingTopicSuggestions["topics"];
	}) => Promise<{ topics: PersistCycleTerminalInput["topics"] }>;
	// Phase 1B Task 8: resolves each topic's provenance (stories/documents) into
	// contributor user IDs (Task 5) before the terminal persist.
	resolveTopicContributors: (args: {
		tenant: {
			projectId: string;
			organizationId: string | null;
			userId: string | null;
		};
		topics: PersistCycleTerminalInput["topics"];
		prAuthorGithubIdByPr?: Record<string, string>;
	}) => Promise<{ topics: PersistCycleTerminalInput["topics"] }>;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 5, initialInterval: "1s" },
});

// Phase 1C-2b: the contributor notification. Kept in a SEPARATE proxy with its
// own short timeout and retry budget, mirroring the report pattern, so a
// notification outage cannot stall the long generation activities.
//
// The budget is real and load-bearing: the activity REJECTS when it cannot
// finish its job (unconfirmed recipients, a lost outcome compare-and-swap),
// which is what earns the retry — so the try/catch that protects the cycle is
// the workflow's, below, not the activity's.
//
// BOUNDED, never infinite. A `startToCloseTimeout` does NOT stop the attempt
// that timed out: a slow attempt can still be running while its retry proceeds,
// so attempts overlap by design. That is why the activity and its delivery
// ledger are built to be idempotent, and why the attempt count has a ceiling —
// an unbounded budget would keep stacking overlapping attempts against a
// dependency that is already unwell.
//
// The retries above are bounded from outside too: the workflow that hosts
// this proxy caps the WHOLE execution, retries included, at 2h via
// workflowExecutionTimeout in dispatch-suggestion.ts — one budget with the
// mail provider's 24h dedupe window. See that comment for what the
// relationship guarantees and what breaks it.
//
// Typed from the activities barrel rather than by hand: a hand-written
// structural type for an activity that is not type-checked against its
// registration can drift silently, and the input shape is exactly what would
// drift.
const { notifyPublishingTopicsReady } = proxyActivities<typeof acts>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 5, initialInterval: "2s" },
});

// Phase 1C-3b: the project-channel chat broadcast. Its OWN proxy, for the same
// reason the notify activity has one — but with a SMALLER retry budget, and the
// difference is argued rather than copied. Email retries a FAILED row, so more
// attempts recover more deliveries. Chat never re-posts: a retry can only help a
// target that has no ledger row yet, and every attempt against a target that
// already has one is refused by the claim at the cost of a round trip.
//
// It heartbeats per target, so it gets a heartbeatTimeout like the collectors.
const { broadcastPublishingTopicsToChat } = proxyActivities<typeof acts>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

// =============================================================================
// Input / output
// =============================================================================

export interface PublishingSuggestionWorkflowInput {
	cycleId: string;
	projectId: string;
	organizationId: string | null;
	tenantUserId: string | null;
	actorUserId: string;
	coveredThroughIso: string;
	/** F7: last successful per-source watermarks, for the freshness gate. */
	priorCoverage: SourceCoverage;
	/**
	 * 1C-1: per-project collection window override. Absent => WINDOW_DAYS (180),
	 * which is what every pre-1C history replays with.
	 */
	lookbackDays?: number;
	/**
	 * 1C-1: skip the F7 freshness gate for this run. Set by the manual
	 * "Generate now" trigger, or by a dispatch that detected a preferences
	 * change. Sufficiency still applies — a forced run on a project with
	 * nothing to say must still say nothing.
	 *
	 * It is NOT a human-initiated signal; that is
	 * `PublishingSuggestionCycle.triggeredByUserId`.
	 */
	force?: boolean;
	/**
	 * 1C-1b (§7.1): the canonical preferences this run was dispatched with.
	 * FORWARDED, never inspected here — the workflow hands it to
	 * `persistCycleTerminal`, which derives the fingerprint and records it on
	 * the terminals that count as a run.
	 *
	 * Captured at DISPATCH rather than read here, so a settings edit landing
	 * mid-run cannot make this cycle's output disagree with the fingerprint
	 * stored against it. It is also the object C-2's prompt clause and C-3's
	 * exclusion filter will read, so the values that generate and the values
	 * that are fingerprinted are the same object rather than two reads of one
	 * row taken at different instants.
	 *
	 * Absent on every pre-1C-1b history, and absent means "record nothing".
	 */
	preferences?: PublishingPreferencesSnapshot;
}

// M6: SUPERSEDED is a workflow-level outcome (CAS lost to a reclaiming/superseding
// run), distinct from the persist helper's terminal statuses — it MUST be in this
// union. FAILED is NEVER a return value — a failed run throws.
export type PublishingSuggestionStatus =
	| "READY"
	| "NO_TOPICS"
	| "INSUFFICIENT_CONTEXT"
	| "SUPERSEDED";

// The collector fan-out shape (Task 5). `failures` is present on releases/PRs.
type CollectorOut = {
	items: unknown[];
	qualifyingCount: number;
	newestQualifyingIso: string | null;
	capExhausted: boolean;
	failures?: unknown[];
};

const KEYS = [
	"stories",
	"documents",
	"transcripts",
	"pullRequests",
	"releases",
] as const;

// 180-day collection window, derived from the FIXED coveredThroughIso.
const WINDOW_DAYS = 180;

// =============================================================================
// Workflow
// =============================================================================

export async function publishingSuggestionWorkflow(
	input: PublishingSuggestionWorkflowInput,
): Promise<{ status: PublishingSuggestionStatus }> {
	const {
		cycleId,
		projectId,
		organizationId,
		tenantUserId,
		actorUserId,
		coveredThroughIso,
		priorCoverage,
	} = input;
	// F7 hardening: canonicalize to UTC Z once. `newestQualifyingIso` (Task 5/8)
	// is always `.toISOString()`; if `coveredThroughIso` ever arrives with a
	// non-Z offset the lexicographic string compares below (F7 freshness,
	// F3/F7 cumulative coverage) would silently misorder. Pure/deterministic:
	// `new Date(<fixed string>).toISOString()` has no wall-clock dependency.
	const coveredThroughCanonical = new Date(coveredThroughIso).toISOString();
	try {
		// 1) Fail-closed tenant + cycle-ownership assertion BEFORE any collection.
		//    F5: passing cycleId makes assertProjectTenantTuple (Task 6) also verify
		//    the cycle's projectId === projectId, so a stale/version-skewed cycleId
		//    can never reach persistence OR markCycleFailed.
		await assertProjectTenantTuple({
			cycleId,
			projectId,
			organizationId,
			tenantUserId,
			actorUserId,
		});

		// 2) Collect (bounded), tolerating partial failure. Deterministic window:
		//    new Date(<fixed ISO>) and new Date(<fixed number>) are pure — no no-arg
		//    Date/Date.now() in the sandbox.
		// 1C-1: honour the per-project lookback override, clamped so a
		// hand-edited settings row cannot widen the window without bound. A
		// non-finite value (NaN/Infinity) would otherwise survive Math.max/min
		// and produce an invalid date, so it is rejected up front and falls back
		// to the same default a missing value already resolves to. No patched()
		// gate: this reads an input and does date arithmetic — it issues no
		// workflow command, so the activity call sequence is unchanged and old
		// histories (lookbackDays undefined) replay identically.
		const requestedLookbackDays =
			input.lookbackDays != null && Number.isFinite(input.lookbackDays)
				? input.lookbackDays
				: WINDOW_DAYS;
		const windowDays = Math.min(365, Math.max(1, requestedLookbackDays));
		const windowStart = new Date(
			new Date(coveredThroughIso).getTime() - windowDays * 86_400_000,
		).toISOString();
		const cinput = {
			projectId,
			organizationId,
			userId: actorUserId,
			windowStart,
			windowEnd: coveredThroughCanonical,
		};
		const settled = await Promise.allSettled([
			collectStories(cinput),
			collectDocuments(cinput),
			collectTranscripts(cinput),
			collectPullRequests(cinput),
			collectReleases(cinput),
		]);

		// 3) Classify: a source FAILED if it rejected, was capExhausted, or returned
		//    failures[] (P5).
		const succeeded = new Map<string, CollectorOut>();
		const sourceFailures: Record<string, string> = {};
		settled.forEach((r, i) => {
			const key = KEYS[i];
			if (r.status === "rejected") {
				sourceFailures[key] = String(r.reason).slice(0, 300);
				return;
			}
			const v = r.value as CollectorOut;
			if (v.capExhausted || (v.failures?.length ?? 0) > 0) {
				sourceFailures[key] = "source incomplete";
				return;
			}
			succeeded.set(key, v);
		});
		if (succeeded.size === 0) {
			throw ApplicationFailure.nonRetryable(
				"all sources failed",
				"PUBLISHING_ALL_SOURCES_FAILED",
			);
		}

		const tenant = { projectId, organizationId, userId: tenantUserId };
		const prior = priorCoverage as Record<string, string>;

		// Sufficiency: INLINED mirror of evaluateSufficiency (Task 1) — the workflow
		// sandbox cannot import @repo/database (it pulls Prisma + node:crypto). Task
		// 1's evaluateSufficiency in packages/database/src/publishing-suite-schema.ts
		// is the canonical source; these two MUST stay in sync. Stories are EXCLUDED
		// (M5 → deferred to 1C).
		const qc = (k: string) => succeeded.get(k)?.qualifyingCount ?? 0;
		const sufficient =
			qc("pullRequests") >= 3 ||
			qc("transcripts") >= 1 ||
			qc("documents") >= 2;

		// F7 freshness: ≥1 succeeded source with a qualifier STRICTLY newer than
		// its prior watermark. `force` bypasses ONLY this gate — never sufficiency.
		const hasFreshQualifier =
			input.force === true ||
			[...succeeded].some(
				([k, v]) =>
					v.newestQualifyingIso != null &&
					v.newestQualifyingIso > (prior[k] ?? ""),
			);

		// F3/F7: CUMULATIVE coverage — carry EVERY prior watermark forward and advance
		// only the sources that succeeded THIS cycle, so a partial-success cycle never
		// DROPS a prior watermark (which would re-classify aged content as fresh next
		// cycle). Committed only on success (P5).
		const sourceCoverage: Record<string, string> = { ...prior };
		for (const k of succeeded.keys()) {
			sourceCoverage[k] = coveredThroughCanonical;
		}

		if (!sufficient || !hasFreshQualifier) {
			// INSUFFICIENT persists NO coverage (P5). M6: a lost CAS → SUPERSEDED (no
			// markCycleFailed).
			const { persisted } = await persistCycleTerminal({
				cycleId,
				kind: "INSUFFICIENT_CONTEXT",
				topics: [],
				sourceCoverage: {},
				sourceFailures,
				tenant,
				// 1C-1b: forwarded, and deliberately NOT behind a patched() marker.
				// That was MEASURED rather than argued, because both readings are
				// defensible and only one is true: a history was built in which the
				// workflow INPUT carries `preferences` while the recorded
				// `persistCycleTerminal` command does not — the exact shape an old
				// worker leaves behind during a rolling deploy — and replayed against
				// this code. Verdict: CLEAN. The same history with the recorded
				// activity RENAMED was replayed as a negative control and threw
				// [TMPRL1100], proving the replayer really does compare commands and
				// that the clean verdict is not a silent no-op. The SDK compares
				// activity TYPE and command ORDER, not activity ARGUMENTS.
				//
				// The conditional spread still matters: it keeps an old history's
				// payload byte-identical rather than gaining an explicit `undefined`.
				...(input.preferences && { preferences: input.preferences }),
			});
			return {
				status: persisted ? "INSUFFICIENT_CONTEXT" : "SUPERSEDED",
			};
		}

		// 4) Sufficient AND fresh → summarize succeeded context (collectors already
		//    recency-order + byte-bound their items), map each topic to a
		//    dedupeKey, then CAS-persist.
		const context = Object.fromEntries(
			[...succeeded].map(([k, v]) => [k, v.items]),
		);
		const summary = await summarizeTopicSuggestions({
			projectId,
			organizationId,
			actorUserId,
			context,
			// 1C-1b part 2 (§7.1(a)): the SAME snapshot the terminal writer
			// fingerprints, so the prompt this cycle ran under and the hash
			// recorded against it describe one configuration rather than two
			// reads taken at different instants.
			//
			// Spread rather than sent unconditionally, unlike the dispatcher's
			// own field: here an absent `preferences` is exactly what an OLD
			// history looks like, and the activity's byte-identical-prompt
			// guarantee is pinned against the field being MISSING, not against
			// it being present-and-undefined.
			//
			// No `patched()`. Adding a field to an existing activity's input
			// issues no new command, and the replay measurement for this exact
			// boundary is recorded in preferences-replay.test.ts: real history
			// CLEAN, negative control [TMPRL1100].
			...(input.preferences && { preferences: input.preferences }),
		});
		const mapped = await computeSuggestionTopics({
			projectId,
			topics: summary.topics,
		});
		// Phase 1B Task 8: resolve contributors (Task 5) between compute and
		// persist, so persistCycleTerminal receives topics with
		// contributorUserIds filled instead of compute's seeded `[]`.
		//
		// `patched()` is REQUIRED — this inserts a NEW activity call
		// (resolveTopicContributors) into the workflow's command stream between
		// computeSuggestionTopics and persistCycleTerminal. Histories recorded
		// before Phase 1B scheduled persistCycleTerminal DIRECTLY after
		// computeSuggestionTopics, so replaying them against this code throws
		// [TMPRL1100] Nondeterminism without the gate. Old histories
		// (patched() === false) skip resolution and persist compute's seeded
		// `contributorUserIds: []` — byte-identical to pre-1B behavior. The
		// activity self-degrades (never throws), so contributor resolution can
		// never break the run.
		let topicsToPersist = mapped.topics;
		if (patched("publishing-1b-resolve-contributors-v1")) {
			// Build the repoPr → author-github-id map from the collected PR
			// items (still in memory here) via the pure, deterministic helper.
			// It FAILS CLOSED on a cross-provider coordinate collision (a GitHub
			// PR and a GitLab/ADO PR sharing repoFullName#prNumber → credit
			// nobody) — see buildPrAuthorGithubIdByPr. Pure/deterministic →
			// replay-safe, and it does NOT add a workflow command, so no new
			// patched() is needed.
			const pullRequests = (context.pullRequests ?? []) as ReadonlyArray<{
				repoFullName: string;
				prNumber: number;
				authorGithubId?: string;
			}>;
			const prAuthorGithubIdByPr =
				buildPrAuthorGithubIdByPr(pullRequests);
			const withContributors = await resolveTopicContributors({
				tenant,
				topics: mapped.topics,
				prAuthorGithubIdByPr,
			});
			topicsToPersist = withContributors.topics;
		}
		// D9's marker, and the only one this design needs. Read ONCE into a local
		// and used for BOTH the activation input and the notify call, so the two
		// cannot disagree — and so the command stream carries one marker check,
		// not two.
		//
		// An old history returns false here, schedules no notification command,
		// and leaves the cycle at the column default — which is the honest
		// classification for a cycle that never entered the lifecycle.
		//
		// SPREAD, never `activateNotificationLifecycle: notifyEnabled`. The
		// field is optional and the revision that recorded the pre-1C
		// histories did not pass it at all, so on one of those histories an
		// explicit `false` would replay a payload that differs from the one
		// the history holds, for a persistCycleTerminal command that was
		// already committed — and for no behavioural gain, since
		// persistCycleTerminal reads the field with `=== true` and cannot
		// tell `false` from absent. See notificationActivationInput.
		const notifyEnabled = patched("publishing-1c-notify-v1");
		// Phase 1C-3b, and its OWN marker. Appending an activity call to a
		// workflow that has completed histories is a replay divergence — observed
		// on this card as "Activity machine does not handle this event:
		// WorkflowExecutionCompleted" — so the new call needs a gate. Reusing D9's
		// or 1C-2's would be worse than no gate at all: an old history that DID
		// notify would then also try to broadcast, which is the exact divergence
		// the marker exists to prevent. Read once into a local, like the one
		// above, so the command stream carries one marker check rather than two.
		const chatEnabled = patched("publishing-1c3-chat-v1");
		const { persisted, status } = await persistCycleTerminal({
			cycleId,
			kind: "SUGGESTIONS",
			topics: topicsToPersist,
			sourceCoverage,
			sourceFailures,
			tenant,
			// 1C-1b: forwarded — but ONLY once the activity has confirmed it
			// read them. See the measurement at the INSUFFICIENT_CONTEXT persist
			// above for why no patched() gate is needed; this extra condition is
			// a different problem, raised in adversarial review.
			//
			// The hash is written from the workflow's OWN input, so without this
			// it recorded what the dispatcher INTENDED, not what ran. During a
			// rolling deploy an old worker on the same task queue accepts the
			// `preferences` field, ignores it, and builds the old prompt — yet
			// the cycle would still be stamped with that hash, so the next
			// dispatch sees no change and never fires the corrective run. The
			// preference edit is swallowed until preferences change again: the
			// buried-content failure this slice exists to prevent, arriving
			// through the deploy rather than through the watermark.
			//
			// `=== true` and not truthiness, because the absence of the key is
			// precisely the old-worker signal. No hash is then recorded, the
			// reader treats a null hash as changed, and the next dispatch
			// regenerates. Self-healing without a second activity type.
			//
			// The INSUFFICIENT_CONTEXT persist above is deliberately NOT gated
			// this way: that path never calls the summarize activity at all, so
			// there is no prompt for a stale worker to get wrong and the hash is
			// honest on every version.
			//
			// WHAT THIS DOES NOT COVER, stated plainly so nobody reads the gate
			// as a guarantee. `fabric-worker` serves the workflow bundle and the
			// activities from ONE task queue, so a rolling revision can hand the
			// WORKFLOW task to an old pod too. That pod runs the old bundle,
			// which forwards unconditionally, and stamps the hash exactly as it
			// does today. This condition therefore shrinks the window — it now
			// takes an old pod winning the workflow task, not merely the
			// activity task — rather than closing it. Closing it needs Worker
			// Versioning or a dedicated queue, which is a larger change than the
			// bug warrants and was declined on that basis.
			//
			// The cost of the null-hash path is bounded by the CADENCE, not by a
			// retry loop: `dispatchSuggestion` treats a null hash as changed and
			// skips its cost guard, but it is only reached on a cadence tick, and
			// the default cadence is MANUAL. See the comment above
			// `preferencesChanged` in `dispatch-suggestion.ts`, which owns this
			// reasoning; one forced run per tick is the designed recovery, and it
			// predates this gate.
			...(input.preferences &&
				summary.preferencesRead === true && {
					preferences: input.preferences,
				}),
			...notificationActivationInput(notifyEnabled),
		});
		if (notifyEnabled && persisted && status === "READY") {
			// Its OWN try/catch, and that is STRUCTURAL rather than positional:
			// this call sits inside the workflow-wide try whose catch calls
			// markCycleFailed and rethrows. Merely placing it after the persist
			// buys no isolation. Without this inner catch a notification failure
			// would run markCycleFailed — a compare-and-swap that no-ops on an
			// already-READY row — and leave a READY cycle attached to a FAILED
			// workflow: the persisted topics would be invisible to anyone reading
			// the workflow's outcome.
			//
			// Absorbing retry exhaustion here is the NFR: notification failures
			// should be logged and must not break topic suggestion jobs. The
			// unconfirmed ledger rows and the unresolved PENDING outcome are the
			// operator-visible residue, and 1C-2d's sweep is what reads them.
			//
			// It catches ONLY what this one call throws. Everything that decides
			// the cycle's outcome — the persist above, the collectors, the
			// summarizer — stays outside it and still reaches markCycleFailed.
			try {
				await notifyPublishingTopicsReady({ cycleId, tenant });
			} catch (notifyError) {
				log.warn("publishing notification step failed", {
					cycleId,
					projectId,
					error:
						notifyError instanceof Error
							? notifyError.message
							: String(notifyError),
				});
			}
		}
		// A SIBLING of the notify block, never nested inside it. FR18 makes chat
		// independent of the addressed channels, and nesting would make the
		// broadcast conditional on `publishing-1c-notify-v1` — a marker about a
		// different feature — coupling the two in the one direction FR18 exists to
		// prevent. A notify step that exhausted its retries must still broadcast.
		if (chatEnabled && persisted && status === "READY") {
			// Its own try/catch, structural rather than positional for the reason
			// the notify block states at length: this call sits inside the
			// workflow-wide try whose catch runs markCycleFailed and rethrows, so
			// merely placing it later buys no isolation.
			//
			// THIS is FR18. A chat outage must not turn a cycle whose topics are
			// persisted, and whose contributors were notified, into a failed
			// workflow. The cycle's outcome stays a statement about the addressed
			// channels; the broadcast's own residue is its ledger rows and the
			// aggregate log line the activity emits on every run.
			try {
				await broadcastPublishingTopicsToChat({ cycleId, tenant });
			} catch (chatError) {
				log.warn("publishing chat broadcast step failed", {
					cycleId,
					projectId,
					error:
						chatError instanceof Error
							? chatError.message
							: String(chatError),
					// Timeout only, and empty otherwise — see the helper for why a
					// killed activity leaves no other record. Extracted so the
					// mapping is unit-testable; a workflow-harness case asserting on
					// captured logs would cost more than it covers and would still
					// pass if the mapping returned nothing.
					...publishingChatFailureDetail(chatError),
				});
			}
		}
		return { status: persisted ? status : "SUPERSEDED" }; // M6 CAS-loss → SUPERSEDED
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// F5: projectId-scoped CAS — cannot fail another project's cycle, and a lost
		// CAS above never reaches here (SUPERSEDED is returned, not thrown).
		await markCycleFailed(cycleId, projectId, msg);
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			msg,
			"PUBLISHING_SUGGESTION_FAILED",
		);
	}
}
