import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import {
	buildMeetingSpeakers,
	buildRosterIndex,
	type MeetingSpeakers,
	matchSpeaker,
} from "../../../src/meeting-speaker-match";
import type {
	SourceCoverage,
	SourceFailures,
} from "../../../src/publishing-suite-schema";
import { computeDedupeKey } from "../../../src/publishing-suite-schema";
import { publishingTerminalCountsAsRun } from "../../../src/publishing-cadence";
import {
	computePublishingPreferencesHash,
	type PublishingPreferencesSnapshot,
} from "../../../src/publishing-preferences";
import {
	type PublishingSnoozePreset,
	resolvePublishingSnoozeUntil,
} from "../../../src/publishing-snooze";
import { isTopicSnoozed } from "../../../src/publishing-inbox";
import { db, Prisma } from "../../client"; // packages/database/prisma/client.ts re-exports both — NOT ../../../src
import type {
	FunctionTag,
	PublishingCycleStatus,
	PublishingTopicPostType,
} from "../../generated/client";
import { getProjectMemberFunctionTags } from "./function-tags";
import { getProjectMembers } from "./members";
import { activateCycleNotificationLifecycle } from "./publishing-notification-outcome";

const WHY_SUGGESTED_NAME_CAP = 3;
const WHY_SUGGESTED_ID_CHUNK = 500;

function chunkIds(ids: string[], size: number): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += size) {
		out.push(ids.slice(i, i + size));
	}
	return out;
}

export interface CreateOrGetCycleInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	actorUserId: string;
	coveredThrough: Date;
	executionTimeoutAt: Date;
	/**
	 * N2 retry-idempotency: a stable per-dispatch-run id (the Temporal dispatcher's
	 * `runId`, constant across the dispatch activity's retries within one daily run,
	 * distinct per run). When supplied, a cycle is recovered by `(projectId,
	 * occurrenceKey)` REGARDLESS of status — so a retry after the generation
	 * workflow terminalized the cycle reuses it instead of creating a second one.
	 * Omitted for manual/legacy callers → exact back-compat behavior (active-
	 * GENERATING partial index is the sole guard).
	 */
	occurrenceKey?: string;
	/**
	 * Audit breadcrumb only — NOT the AI-usage actor (that stays `actorUserId`).
	 * Set for a manual "Generate now" run to the clicking user; omitted/undefined
	 * for the scheduled sweep, which persists as NULL.
	 */
	triggeredByUserId?: string;
}

const CYCLE_SELECT = {
	id: true,
	status: true,
	temporalWorkflowId: true,
	// F4-producer: the dispatcher's (later) workflow-input build needs the cycle's STORED
	// collection boundary on a reuse (P2002 read-back), not the retry's current time — both
	// the create and read-back paths share this select so the reused cycle carries its
	// original coveredThrough/executionTimeoutAt rather than the caller re-deriving them.
	coveredThrough: true,
	executionTimeoutAt: true,
} as const;

export async function createOrGetPublishingCycle(
	input: CreateOrGetCycleInput,
): Promise<{
	cycle: {
		id: string;
		status: string;
		temporalWorkflowId: string | null;
		coveredThrough: Date;
		executionTimeoutAt: Date | null;
	};
	created: boolean;
}> {
	// N2 retry-recovery (pre-check): when a per-dispatch-run occurrenceKey is
	// supplied, FIRST return any cycle already created under it — regardless of
	// status. A Temporal retry of the dispatch activity (the `start` landed but the
	// activity's COMPLETION was lost) finds the SAME cycle even after the generation
	// workflow terminalized it (READY/NO_TOPICS/…), so it is REUSED (created:false)
	// rather than recreated. The active-GENERATING partial index alone cannot do
	// this: once the cycle goes terminal its slot is free and a bare create would
	// spawn a duplicate cycle + second workflow (duplicate collectors + LLM spend).
	if (input.occurrenceKey) {
		const prior = await db.publishingSuggestionCycle.findFirst({
			where: {
				projectId: input.projectId,
				occurrenceKey: input.occurrenceKey,
			},
			select: CYCLE_SELECT,
		});
		if (prior) {
			return { cycle: prior, created: false };
		}
	}

	try {
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				status: "GENERATING",
				actorUserId: input.actorUserId,
				triggeredByUserId: input.triggeredByUserId ?? null,
				coveredThrough: input.coveredThrough,
				executionTimeoutAt: input.executionTimeoutAt,
				occurrenceKey: input.occurrenceKey ?? null,
			},
			select: CYCLE_SELECT,
		});
		return { cycle, created: true };
	} catch (error) {
		// Recover ONLY from a unique violation (P2002) — a concurrent run beat us to
		// the slot. EVERY other error (validation, schema, middleware, connection,
		// transient) must surface, not be masked as idempotent success (which would
		// hide the real defect and block operational recovery).
		if (
			!(error instanceof Prisma.PrismaClientKnownRequestError) ||
			error.code !== "P2002"
		) {
			throw error;
		}
		// The P2002 can now come from EITHER unique index: the (projectId,
		// occurrenceKey) occurrence index (a concurrent retry created the cycle under
		// the same run id) OR the active-GENERATING partial index (the existing
		// concurrent-dispatch case). Read back by occurrence key FIRST — that row is
		// this dispatch run's own cycle, returned regardless of status — then fall
		// back to the active-GENERATING row.
		if (input.occurrenceKey) {
			const byKey = await db.publishingSuggestionCycle.findFirst({
				where: {
					projectId: input.projectId,
					occurrenceKey: input.occurrenceKey,
				},
				select: CYCLE_SELECT,
			});
			if (byKey) {
				return { cycle: byKey, created: false };
			}
		}
		const existing = await db.publishingSuggestionCycle.findFirst({
			where: { projectId: input.projectId, status: "GENERATING" },
			orderBy: { createdAt: "desc" },
			select: CYCLE_SELECT,
		});
		if (existing) {
			return { cycle: existing, created: false };
		}
		throw error; // P2002 but neither an occurrence nor an active row is present (raced) — surface it
	}
}

export interface PersistCycleTerminalInput {
	cycleId: string;
	kind: "SUGGESTIONS" | "INSUFFICIENT_CONTEXT";
	topics: {
		title: string;
		pitch: string;
		dedupeKey: string;
		provenance: unknown;
		suggestedPostTypes: PublishingTopicPostType[];
		contributorUserIds: string[];
		relevantFunctionTags: FunctionTag[];
		postTypeRecommendations: {
			type: PublishingTopicPostType;
			theme: string;
			rationale: string;
		}[];
		angle?: string;
		subject?: string | null;
		subjectKey?: string | null;
	}[];
	sourceCoverage: SourceCoverage; // committed ONLY for kind === "SUGGESTIONS" (P5)
	sourceFailures: SourceFailures;
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	};
	/**
	 * 1C-2b: enter the notification lifecycle (NOT_APPLICABLE -> PENDING) in the same transaction
	 * that sets the cycle READY. Set by the workflow from patched("publishing-1c-notify-v1"), so an
	 * old history — which schedules no notification step — leaves the cycle at the default, which
	 * is the honest classification for a cycle that never entered the lifecycle.
	 *
	 * Absent behaves exactly as an older worker that has never seen this field, which is what makes
	 * the rolling-deploy case testable rather than hypothetical.
	 */
	activateNotificationLifecycle?: boolean;
	/**
	 * 1C-1b (§7.1): the canonical preferences this run used, captured at dispatch
	 * and carried through workflow input so a mid-run settings edit cannot make a
	 * cycle's output disagree with the fingerprint recorded for it.
	 *
	 * The SNAPSHOT rather than a precomputed hash, deliberately. A hash argument
	 * would mean two call sites producing a value that must agree with nothing
	 * forcing them to; deriving it here leaves one producer, so "the hash stored
	 * against a cycle describes what that cycle ran with" holds by construction.
	 * It is also the transport C-2's prompt clause and C-3's exclusion filter
	 * read, so the values that generate and the values that are fingerprinted are
	 * the same object.
	 *
	 * Absent (an older worker, or an old history) writes nothing at all rather
	 * than writing null, so a rolling deploy cannot blank a column a newer worker
	 * just set.
	 */
	preferences?: PublishingPreferencesSnapshot;
}

type TerminalStatus = "READY" | "NO_TOPICS" | "INSUFFICIENT_CONTEXT";

export async function persistCycleTerminal(
	input: PersistCycleTerminalInput,
): Promise<{ persisted: boolean; status: TerminalStatus }> {
	try {
		return await db.$transaction(async (tx) => {
			// F5: bind the cycle to the supplied tenant BEFORE any write. The worker runs BYPASSRLS,
			// and PublishingTopic/PublishingSuggestionCycle reference Project independently, so a
			// stale/malformed/version-skewed workflow input could otherwise link a topic to — or
			// terminalize — another project's cycle. Load the cycle; if it is missing OR its tenant
			// tuple does not match `input.tenant`, no-op (persisted:false) — never write across tenants.
			const owner = await tx.publishingSuggestionCycle.findUnique({
				where: { id: input.cycleId },
				select: { projectId: true, organizationId: true, userId: true },
			});
			const terminal =
				input.kind === "INSUFFICIENT_CONTEXT"
					? ("INSUFFICIENT_CONTEXT" as const)
					: ("NO_TOPICS" as const);
			if (
				!owner ||
				owner.projectId !== input.tenant.projectId ||
				owner.organizationId !== input.tenant.organizationId ||
				owner.userId !== input.tenant.userId
			) {
				return { persisted: false, status: terminal };
			}

			// F1: the check above only proves the CYCLE's denormalized tuple (snapshotted at
			// cycle-creation time) matches `input.tenant` — it says nothing about the Project's
			// tuple NOW. If the Project transfers org (or is archived/soft-deleted) between the
			// workflow's start-time assertion (assertProjectTenantTuple) and this persist, the
			// stale cycle tuple still matches `input.tenant` and topics would get committed
			// under the wrong/stale org. Re-lock + re-read the Project's CURRENT row inside this
			// same transaction: `FOR UPDATE` blocks a concurrent transfer from committing until
			// this tx does, closing the TOCTOU window rather than merely detecting it after the
			// fact. Validate both the normalized tenant tuple (mirrors assertProjectTenantTuple's
			// org/personal branching) AND eligibility (mirrors find-eligible-projects.ts's sweep
			// filter: status ACTIVE, deletedAt null) — a Project archived/deleted after dispatch
			// must not receive topics either. Missing/mismatched/ineligible → no-op: no topics
			// written, no cycle transition (defense in depth on top of the cycle-tuple check).
			const projectRows = await tx.$queryRaw<
				{
					organizationId: string | null;
					userId: string;
					status: string;
					deletedAt: Date | null;
				}[]
			>`SELECT "organizationId", "userId", "status", "deletedAt" FROM "project" WHERE "id" = ${input.tenant.projectId} FOR UPDATE`;
			const project = projectRows[0];
			const org = input.tenant.organizationId;
			const tenantMatchesCurrentProject =
				project != null &&
				(project.organizationId ?? null) === org &&
				(org !== null || project.userId === input.tenant.userId);
			const projectEligible =
				project != null &&
				project.status === "ACTIVE" &&
				project.deletedAt === null;
			if (!tenantMatchesCurrentProject || !projectEligible) {
				// 1C-2a: this is also the path a RETRY of an already-committed attempt takes
				// when the project moved tenant or became ineligible in between, and the
				// caller cannot tell that apart from a competing terminalization — both
				// arrive as persisted:false. Recovery is deliberately NOT attempted here:
				// the committed topics carry the previous tenant tuple, while a downstream
				// notification step resolves recipients from current membership, so
				// reporting the terminal status would address the new tenant's members
				// about the previous tenant's content. Log it so an operator can tell which
				// of the two happened.
				console.warn(
					"[publishing-suite/persistCycleTerminal] project moved tenant or is ineligible; not persisting",
					{
						projectId: input.tenant.projectId,
						cycleId: input.cycleId,
						tenantMatchesCurrentProject,
						projectEligible,
					},
				);
				return { persisted: false, status: terminal };
			}

			// One derivation for both terminals. `undefined` means "record
			// nothing", which is what an old history and an unconfigured caller
			// both produce.
			const preferencesHash = input.preferences
				? computePublishingPreferencesHash(input.preferences)
				: undefined;

			if (input.kind === "INSUFFICIENT_CONTEXT") {
				// P5: never advance coverage on a non-success — leave prior watermarks
				// intact so failed/insufficient sources retry next cycle.
				const { count } = await tx.publishingSuggestionCycle.updateMany(
					{
						where: {
							id: input.cycleId,
							projectId: input.tenant.projectId,
							status: "GENERATING",
						},
						data: {
							status: "INSUFFICIENT_CONTEXT",
							completedAt: new Date(),
							sourceFailures: input.sourceFailures as object,
							// Only a CLEAN insufficient run counts as a run, and
							// only a run records its preferences. A dirty one is
							// retried tomorrow, so recording a hash for it would
							// settle a mismatch that was never actually applied.
							...(preferencesHash !== undefined &&
								publishingTerminalCountsAsRun({
									status: "INSUFFICIENT_CONTEXT",
									sourceFailures: input.sourceFailures,
								}) && { preferencesHash }),
						},
					},
				);
				if (count === 0) {
					// 1C-2a: the same replay recovery as the SUGGESTIONS branch below. This
					// branch writes no topics, so the ownership question does not arise —
					// it is enough that the cycle already holds INSUFFICIENT_CONTEXT.
					const current =
						await tx.publishingSuggestionCycle.findUnique({
							where: { id: input.cycleId },
							select: { status: true },
						});
					if (current?.status === "INSUFFICIENT_CONTEXT") {
						// Fill a hash the first attempt could not write. Guarded three
						// ways, and each guard matters: only when this call HAS a
						// snapshot, only where the stored value is still NULL — so a
						// replay carrying different preferences can never rewrite what
						// the recorded run actually used — and only on a terminal that
						// counts as a run.
						if (
							preferencesHash !== undefined &&
							publishingTerminalCountsAsRun({
								status: "INSUFFICIENT_CONTEXT",
								sourceFailures: input.sourceFailures,
							})
						) {
							await tx.publishingSuggestionCycle.updateMany({
								where: {
									id: input.cycleId,
									projectId: input.tenant.projectId,
									preferencesHash: null,
								},
								data: { preferencesHash },
							});
						}
						return {
							persisted: true,
							status: "INSUFFICIENT_CONTEXT" as const,
						};
					}
				}
				return {
					persisted: count > 0,
					status: "INSUFFICIENT_CONTEXT" as const,
				};
			}

			// SUGGESTIONS: createMany with skipDuplicates → the (projectId, dedupeKey)
			// unique index drops any already-owned key (manual/prior), race-safe, and
			// `count` is the number ACTUALLY inserted (P8).
			const inserted = await tx.publishingTopic.createMany({
				data: input.topics.map((t) => ({
					projectId: input.tenant.projectId,
					organizationId: input.tenant.organizationId,
					userId: input.tenant.userId,
					cycleId: input.cycleId,
					title: t.title,
					pitch: t.pitch,
					status: "SUGGESTION" as const,
					origin: "AI" as const,
					provenance: t.provenance as object,
					dedupeKey: t.dedupeKey,
					suggestedPostTypes: t.suggestedPostTypes,
					contributorUserIds: t.contributorUserIds,
					relevantFunctionTags: t.relevantFunctionTags,
					postTypeRecommendations:
						t.postTypeRecommendations as Prisma.InputJsonValue,
					angle: t.angle || null, // blank angle = "none" -> NULL, not "" (Copilot; normalizer already coerces "" -> undefined upstream)
					subject: t.subject ?? null,
					subjectKey: t.subjectKey ?? null,
				})),
				skipDuplicates: true,
			});
			// 1C-2a: derive the terminal status from OWNERSHIP, not from this attempt's
			// insert count. On a Temporal retry of a call that already committed,
			// `createMany({ skipDuplicates: true })` inserts zero rows — every dedupeKey is
			// already owned, by *this same cycle* — so `inserted.count` recomputes
			// NO_TOPICS for a cycle that is genuinely READY, and the caller is told
			// SUPERSEDED. Counting this call's own keys that now carry THIS cycle id equals
			// `inserted.count` on a first attempt (nothing else can carry this cycle id),
			// and recovers READY on a replay.
			const ownedByThisCycle = await tx.publishingTopic.count({
				where: {
					projectId: input.tenant.projectId,
					cycleId: input.cycleId,
					dedupeKey: { in: input.topics.map((t) => t.dedupeKey) },
				},
			});
			const status: TerminalStatus =
				ownedByThisCycle > 0 ? "READY" : "NO_TOPICS";

			// 1C-2b: a cycle ENTERS the notification lifecycle here, in the same transaction that
			// makes it READY — not when the notification command is scheduled, which happens
			// afterwards. That weaker claim is what this write can actually support, and it is
			// enough: a cycle whose workflow dies in the gap is still visible as unresolved
			// instead of being indistinguishable from one that never entered.
			const activateIfRequested = async () => {
				if (
					input.activateNotificationLifecycle === true &&
					status === "READY"
				) {
					await activateCycleNotificationLifecycle(tx, {
						cycleId: input.cycleId,
						projectId: input.tenant.projectId,
					});
				}
			};

			// D9: surface create-once skips — a smaller inserted.count than requested
			// means some keys were already owned by a prior cycle / manual topic. Not an
			// error (create-once is intended); observability only.
			if (inserted.count < input.topics.length) {
				console.info(
					"[publishing-suite/persistCycleTerminal] some topics were create-once skipped",
					{
						projectId: input.tenant.projectId,
						requested: input.topics.length,
						inserted: inserted.count,
						skipped: input.topics.length - inserted.count,
					},
				);
			}

			// Best-effort AI promotion (D10 / Codex R5 F9): a multiplication member whose
			// title collided with a re-surfaced AI row was skipped by create-once above,
			// so it never received its subject label. Stamp subject/subjectKey onto group
			// member rows that are still UNGROUPED (subjectKey IS NULL) — never overwriting
			// a row already in a group (so a title recurring for a DIFFERENT subject cannot
			// corrupt an existing group) and never a manual topic (origin: AI only).
			const groups = new Map<
				string,
				{ subject: string; keys: string[] }
			>();
			for (const t of input.topics) {
				if (t.subjectKey && t.subject) {
					const g = groups.get(t.subjectKey) ?? {
						subject: t.subject,
						keys: [],
					};
					g.keys.push(t.dedupeKey);
					groups.set(t.subjectKey, g);
				}
			}
			for (const [subjectKey, g] of groups) {
				await tx.publishingTopic.updateMany({
					where: {
						projectId: input.tenant.projectId,
						origin: "AI",
						subjectKey: null,
						dedupeKey: { in: g.keys },
					},
					data: { subject: g.subject, subjectKey },
				});
			}

			// CAS: only a still-GENERATING cycle goes terminal; commit coverage here
			// (success path only). If the CAS lost, throw so the inserts roll back.
			const { count } = await tx.publishingSuggestionCycle.updateMany({
				where: {
					id: input.cycleId,
					projectId: input.tenant.projectId,
					status: "GENERATING",
				}, // F5: tenant-scoped CAS
				data: {
					status,
					completedAt: new Date(),
					sourceCoverage: input.sourceCoverage as object,
					sourceFailures: input.sourceFailures as object,
					// READY and NO_TOPICS both count as a run even with partial
					// collector failure, so no cleanliness test applies here — the
					// predicate is still called so the two branches cannot drift
					// into disagreeing about what a run is.
					...(preferencesHash !== undefined &&
						publishingTerminalCountsAsRun({
							status,
							sourceFailures: input.sourceFailures,
						}) && { preferencesHash }),
				},
			});
			if (count === 0) {
				// 1C-2a: a lost CAS is this call's OWN earlier commit only when BOTH hold —
				// this attempt wrote nothing (so there is nothing to roll back) AND the
				// cycle already holds exactly the status this call computed. Anything else
				// is a genuinely competing terminalization (a liveness reclaim to FAILED, a
				// superseding cycle) and keeps today's throw → rollback → SUPERSEDED, which
				// is what the workflow's CAS-loss mapping was always about.
				const current =
					inserted.count === 0
						? await tx.publishingSuggestionCycle.findUnique({
								where: { id: input.cycleId },
								select: { status: true },
							})
						: null;
				if (current?.status === status) {
					// Fill a hash the first attempt could not write. Guarded three
					// ways, and each guard matters: only when this call HAS a
					// snapshot, only where the stored value is still NULL — so a
					// replay carrying different preferences can never rewrite what
					// the recorded run actually used — and only on a terminal that
					// counts as a run.
					if (
						preferencesHash !== undefined &&
						publishingTerminalCountsAsRun({
							status,
							sourceFailures: input.sourceFailures,
						})
					) {
						await tx.publishingSuggestionCycle.updateMany({
							where: {
								id: input.cycleId,
								projectId: input.tenant.projectId,
								preferencesHash: null,
							},
							data: { preferencesHash },
						});
					}
					// 1C-2b: the replay-recovery path. If attempt 1 ran on an older worker
					// (or without the flag) and attempt 2 on a new one, this is the only
					// place left that can still close the activation gap for this cycle.
					await activateIfRequested();
					return { persisted: true, status };
				}
				throw new Error("PUBLISHING_CAS_LOST");
			}
			// 1C-2b: the CAS-won path — the common case, a first attempt committing READY.
			await activateIfRequested();
			return { persisted: true, status };
		});
	} catch (e) {
		// CAS lost (cycle was reclaimed/superseded) → the whole tx rolled back, so no
		// topics were written. Report not-persisted rather than surfacing an error.
		if (e instanceof Error && e.message === "PUBLISHING_CAS_LOST") {
			return { persisted: false, status: "NO_TOPICS" };
		}
		throw e;
	}
}

/**
 * Cost guard: cheap existence check for whether a project has any content newer than
 * its per-source coverage watermarks. A `false` lets the Task 10 dispatcher skip
 * starting a daily cycle (no LLM cost); `true` means the cycle is worth starting.
 *
 * H2: PRs/releases live in GitHub/ADO, NOT local tables. Their coverage keys alone
 * cannot prove "nothing new" — after the first successful cycle both keys are set
 * forever, so an "is a coverage key missing" test goes false permanently and
 * external-only activity (a new PR/release with no local story/doc change) stops
 * triggering cycles. A DB-layer guard cannot cheaply call GitHub, so treat "the
 * project has an ACTIVE repo integration" as always-possibly-new and dispatch; the
 * workflow's `qualifyingCount` sufficiency gate (not this guard) is what actually
 * bounds LLM spend — an idle repo yields qualifyingCount 0 → INSUFFICIENT_CONTEXT,
 * no LLM call. (1C efficiency follow-up: replace with a cheap external-cursor
 * watermark probe — latest PR `updatedAt` / release `publishedAt` vs coverage — to
 * skip truly-idle repos, mirroring collect-github-releases.ts's `GET /releases/latest`
 * per-repo anchor.)
 */
export async function countNewContextSince(
	projectId: string,
	organizationId: string | null,
	coverage: SourceCoverage,
): Promise<{ hasNew: boolean }> {
	const after = (k: keyof SourceCoverage) =>
		coverage[k] ? new Date(coverage[k] as string) : new Date(0);
	const [stories, docs, transcripts] = await Promise.all([
		db.userStory.count({
			where: {
				projectId,
				project: { organizationId },
				OR: [
					{ createdAt: { gt: after("stories") } },
					{ lastEditedAt: { gt: after("stories") } },
				],
			},
		}),
		db.projectDocument.count({
			where: {
				projectId,
				project: { organizationId },
				updatedAt: { gt: after("documents") },
			},
		}),
		db.projectMeetingTranscript.count({
			// ProjectMeetingTranscript has NO `createdAt` — use `syncedAt` (non-null,
			// @default(now()); other timestamps meetingDate/insightsExtractedAt are nullable).
			// F5: the collector defines transcript freshness as `insightsExtractedAt ??
			// syncedAt` — a transcript synced BEFORE the watermark but summarized (insights
			// extracted) AFTER it is still new context the LLM hasn't seen. Filtering on
			// `syncedAt` alone would never trigger dispatch for that row, so a row qualifies
			// when EITHER timestamp is past the watermark.
			where: {
				projectId,
				project: { organizationId },
				OR: [
					{ syncedAt: { gt: after("transcripts") } },
					{ insightsExtractedAt: { gt: after("transcripts") } },
				],
			},
		}),
	]);
	const activeExternalSources = await db.projectRepositoryIntegration.count({
		where: { projectId, status: "ACTIVE", project: { organizationId } },
	});
	return {
		hasNew: stories + docs + transcripts > 0 || activeExternalSources > 0,
	};
}

// ---------------------------------------------------------------------------
// Plan 3 (Surface) Task 1: user-facing topic + cycle read/write helpers, plus
// the XOR-normalized tenant-tuple resolver the create procedure (Task 2)
// stamps tenant columns from instead of trusting client input (P1/H1).
// ---------------------------------------------------------------------------

/** Projection shared by every helper below — no `pitch`/`declineReason` leaks beyond this shape. */
export interface PublishingTopicRecord {
	id: string;
	title: string;
	pitch: string | null;
	status: string;
	origin: string;
	declineReason: string | null;
	publishedUrl: string | null;
	createdById: string | null;
	createdAt: Date;
	snoozedUntil: Date | null;
	snoozeReason: string | null;
}

const TOPIC_SELECT = {
	id: true,
	title: true,
	pitch: true,
	status: true,
	origin: true,
	declineReason: true,
	publishedUrl: true,
	createdById: true,
	createdAt: true,
	snoozedUntil: true,
	snoozeReason: true,
} as const;

/**
 * FR14: per-viewer "why ranked" reason. Computed per request (viewer-dependent),
 * NEVER stored. `null` = tier 3 (the rest) OR any ranking degrade.
 */
export type PublishingTopicRankReason =
	| { kind: "contributed" }
	| { kind: "role_match"; matchedTags: FunctionTag[] }
	| null;

/**
 * Display-only, per-topic author recommendation (FR4-8, UC2/UC3). Computed at
 * request time from contributorUserIds ∩ relevantFunctionTags ∩ roster tags;
 * NEVER stored. `null` = no function-tag fit, flag off, or any roster-read
 * degrade. Per-topic (identical for every viewer), unlike `rankReason`.
 */
export type PublishingTopicAuthorRecommendation = {
	model: "single" | "co_author";
	authors: {
		id: string;
		name: string;
		image: string | null;
		username: string | null;
		matchedTags: FunctionTag[]; // non-empty; ⊆ topic.relevantFunctionTags
	}[];
} | null;

/** A resolved provenance source shown in the "why suggested" line. `label` is
 *  "" only for a meeting with no subject (rendered as bare "Meeting"). */
export type PublishingWhySuggestedSource = {
	type: "story" | "document" | "meeting";
	label: string;
};

/** Global, per-topic "why suggested" provenance summary (display-only). Named
 *  local sources (capped) + a visible PR count. `null` = render nothing. */
export type PublishingWhySuggested = {
	named: PublishingWhySuggestedSource[];
	prCount: number;
	overflowCount: number;
} | null;

/**
 * List-only projection: the shared record fields plus the 1B post-type
 * suggestions and RESOLVED contributor handles. Deliberately NOT merged into
 * `PublishingTopicRecord` — `createManualPublishingTopic`,
 * `updatePublishingTopicStatus`, and `getPublishingTopic` (via `TOPIC_SELECT`)
 * don't resolve handles, so widening the shared type/select would force every
 * one of those call sites to pay for a `db.user.findMany` they never use.
 */
export interface PublishingTopicListItem {
	id: string;
	title: string;
	pitch: string | null;
	status: string;
	origin: string;
	declineReason: string | null;
	publishedUrl: string | null;
	createdById: string | null;
	createdAt: Date;
	suggestedPostTypes: PublishingTopicPostType[];
	relevantFunctionTags: FunctionTag[];
	postTypeRecommendations: {
		type: PublishingTopicPostType;
		theme: string;
		rationale: string;
	}[];
	contributors: {
		id: string;
		name: string;
		image: string | null;
		username: string | null;
	}[];
	rankReason: PublishingTopicRankReason;
	authorRecommendation: PublishingTopicAuthorRecommendation;
	angle: string | null;
	subject: string | null;
	whySuggested: PublishingWhySuggested;
	userPostTypes: PublishingTopicPostType[] | null;
	meetingSpeakers: MeetingSpeakers;
	updatedAt: Date;
	snoozedUntil: Date | null;
	snoozeReason: string | null;
	/** Server-computed against one `now` per request, so every item in a
	 *  response is judged against the same instant and no client clock is
	 *  involved. */
	isSnoozed: boolean;
	/** This viewer's read marker. Best-effort: any failure reading the markers
	 *  degrades every item to `false` rather than failing the list. */
	isRead: boolean;
}

const TOPIC_LIST_SELECT = {
	...TOPIC_SELECT,
	suggestedPostTypes: true,
	contributorUserIds: true,
	relevantFunctionTags: true,
	postTypeRecommendations: true,
	angle: true,
	subject: true,
	provenance: true,
	postTypesOverridden: true,
	userPostTypes: true,
	updatedAt: true,
} as const;

/**
 * List a project's publishing topics with resolved contributor handles and a
 * per-viewer, request-time THREE-tier ranking (1B role-aware): topics the
 * viewer contributed to (tier 1), then topics matching the viewer's function
 * tags that they did NOT contribute to (tier 2), then everything else
 * (tier 3) — each tier preserves the `createdAt desc` recency order from the
 * underlying query (stable partition).
 *
 * Contributor-handle resolution, the viewer's function-tag read, and the
 * partition itself are each independently best-effort (AC6):
 *  - a `db.user.findMany` failure degrades every topic to untagged
 *    (`contributors: []`) AND unranked (plain recency) — the earliest,
 *    highest-severity degrade;
 *  - a `db.projectUserFunctionTag.findUnique` failure (or a genuinely
 *    untagged viewer) degrades ONLY the role tier — tier 2 collapses to
 *    empty, so ranking falls back to the pre-1B two-tier (contribution-only)
 *    order, with handles unaffected;
 *  - any error while partitioning falls back to plain recency order;
 *  - a `db.publishingTopicRead.findMany` failure degrades every topic's
 *    `isRead` to `false`, independently of handles/ranking/`isSnoozed`.
 * None of these ever fails the whole list.
 *
 * `isSnoozed` is computed against one `now` captured at the top of the
 * request, so every item in a response is judged against the same instant.
 *
 * The viewer function-tag read is also gated behind `isFunctionTagsEnabled()`
 * (`FABRIC_FEATURE_FUNCTION_TAGS`, default OFF): when the flag is off, the
 * query is skipped entirely (not just degraded) — `viewerTags` is `[]`, tier
 * 2 is always empty, and the list is always the pre-1B 2-tier order, even for
 * a project with existing `ProjectUserFunctionTag` rows. This avoids paying
 * for a query whose result the flag guarantees is unused.
 */
export async function listPublishingTopics(o: {
	projectId: string;
	status?: string;
	viewerUserId: string;
}): Promise<{ items: PublishingTopicListItem[] }> {
	const rows = await db.publishingTopic.findMany({
		where: {
			projectId: o.projectId,
			...(o.status ? { status: o.status as never } : {}),
		},
		orderBy: { createdAt: "desc" }, // recency baseline (preserved within each rank tier)
		select: TOPIC_LIST_SELECT,
	});

	// ONE `now` for the whole response — per-item `new Date()` calls could
	// straddle a snooze boundary and return a self-inconsistent list.
	const now = new Date();

	// Read markers are BEST-EFFORT, matching this function's existing degrade
	// contract (AC6): showing a read topic as unread is cosmetic, failing the
	// whole list is not.
	let readTopicIds = new Set<string>();
	try {
		const markers = await db.publishingTopicRead.findMany({
			where: {
				userId: o.viewerUserId,
				topicId: { in: rows.map((r) => r.id) },
			},
			select: { topicId: true },
		});
		readTopicIds = new Set(markers.map((m) => m.topicId));
	} catch (error) {
		readTopicIds = new Set();
		console.warn(
			"[listPublishingTopics] read-marker resolution failed — degrading to unread topics",
			{ projectId: o.projectId },
			error,
		);
	}

	// Resolve contributor handles in ONE query; drop ids with no live user
	// (DV-7/DV-8 — a deleted user leaves a stale id in contributorUserIds).
	// AC6: handle resolution is best-effort — a `db.user.findMany` failure must
	// degrade to untagged AND UNRANKED topics, never throw and error the whole
	// list. `handlesResolved` records success so the two-tier partition below can
	// honor the FULL degrade contract: on failure we skip ranking and return the
	// query's `createdAt desc` order (plain recency), rather than a
	// reranked-but-untagged list — the raw `contributorUserIds` column survives
	// the lookup failure, so ranking on it would silently reorder the list during
	// the very failure path meant to fall back safely.
	const allIds = [...new Set(rows.flatMap((r) => r.contributorUserIds))];
	let byId = new Map<
		string,
		{
			id: string;
			name: string;
			image: string | null;
			username: string | null;
		}
	>();
	let handlesResolved = true;
	try {
		const users = allIds.length
			? await db.user.findMany({
					where: { id: { in: allIds } },
					select: {
						id: true,
						name: true,
						image: true,
						username: true,
					},
				})
			: [];
		byId = new Map(users.map((u) => [u.id, u]));
	} catch (error) {
		handlesResolved = false;
		console.warn(
			"[listPublishingTopics] contributor handle resolution failed — degrading to untagged, unranked topics",
			{ projectId: o.projectId },
			error,
		);
	}

	// Author recommendations (FR4-8, UC2/UC3): per-topic (global), display-only.
	// A contributor is a candidate iff their CURRENT-roster function tags
	// intersect the topic's `relevantFunctionTags` (fit-only, D3). Isolated
	// best-effort read (D6): a roster-read failure degrades to null
	// recommendations WITHOUT touching handles, the viewer-tag read, or the
	// three-tier ranking below (AC-AR6). Gated behind the Function Tags flag —
	// skipped entirely when off (dormant-by-default). Roster-scoped
	// (getProjectMemberFunctionTags): an ex-member has no entry and is never
	// recommended (D4). Candidates are also a subset of the resolved handles
	// (`byId`), so a deleted user drops out.
	const authorRecById = new Map<
		string,
		PublishingTopicAuthorRecommendation
	>();
	if (handlesResolved && isFunctionTagsEnabled()) {
		try {
			const roster = await getProjectMemberFunctionTags(o.projectId);
			const rosterTagsById = new Map(
				roster.map((m) => [m.userId, m.tags]),
			);
			for (const r of rows) {
				if (r.relevantFunctionTags.length === 0) {
					continue;
				}
				// Dedupe the topic's disciplines, order-preserving. Both
				// `relevantFunctionTags` and `contributorUserIds` are Postgres
				// arrays with NO uniqueness constraint, so stale/malformed data
				// could otherwise double-count a discipline (inflating a
				// candidate's match rank) or list the same contributor twice
				// (Codex plan-review). The spec (§4.2) requires a deduped,
				// order-preserving intersection.
				const relevant = [
					...new Set<FunctionTag>(r.relevantFunctionTags),
				];
				const seenAuthor = new Set<string>();
				const candidates: {
					id: string;
					name: string;
					image: string | null;
					username: string | null;
					matchedTags: FunctionTag[];
				}[] = [];
				for (const id of r.contributorUserIds) {
					if (seenAuthor.has(id)) {
						continue; // dedupe duplicate ids
					}
					seenAuthor.add(id);
					const handle = byId.get(id);
					if (!handle) {
						continue; // deleted user — no handle
					}
					const memberTags = rosterTagsById.get(id);
					if (!memberTags) {
						continue; // not a current member (D4)
					}
					const memberTagSet = new Set<FunctionTag>(memberTags);
					// matchedTags is derived from the DEDUPED `relevant`, so it
					// cannot contain duplicates.
					const matchedTags = relevant.filter((t) =>
						memberTagSet.has(t),
					);
					if (matchedTags.length === 0) {
						continue; // no fit
					}
					candidates.push({ ...handle, matchedTags });
				}
				if (candidates.length === 0) {
					continue; // fit-only → no recommendation
				}
				// Order: most matched disciplines first; Array.sort is stable
				// (ES2019+) so ties keep contributor order. Cap the DISPLAYED
				// authors at 3; the model is single iff exactly one candidate.
				candidates.sort(
					(a, b) => b.matchedTags.length - a.matchedTags.length,
				);
				authorRecById.set(r.id, {
					model: candidates.length === 1 ? "single" : "co_author",
					authors: candidates.slice(0, 3),
				});
			}
		} catch (error) {
			authorRecById.clear(); // isolated degrade → all null; ranking untouched
			console.warn(
				"[listPublishingTopics] author-recommendation roster read failed — recommendations omitted (ranking + handles unaffected)",
				{ projectId: o.projectId },
				error,
			);
		}
	}

	// "Why suggested" provenance (global, display-only): resolve each topic's
	// persisted provenance IDs to human titles at request time. Isolated
	// best-effort read (own try/catch) — a resolution failure degrades EVERY
	// topic's whySuggested to null WITHOUT touching handles, author-recs, or
	// ranking. Tenant-scoped: every read filters by projectId, so a stale or
	// foreign id simply doesn't resolve. Chunked IN reads bound per-query work
	// on the unpaginated list; provenance is stripped from the row (never
	// serialized) in the items map below.
	const whySuggestedById = new Map<string, PublishingWhySuggested>();
	try {
		const strArr = (v: unknown): string[] =>
			Array.isArray(v)
				? v.filter((x): x is string => typeof x === "string")
				: [];

		// Collect the deduped page-wide union per source type.
		const storyIdSet = new Set<string>();
		const docIdSet = new Set<string>();
		const meetingIdSet = new Set<string>();
		for (const r of rows) {
			const prov = (r.provenance ?? {}) as {
				storyIds?: unknown;
				docIds?: unknown;
				transcriptIds?: unknown;
			};
			for (const id of strArr(prov.storyIds)) {
				storyIdSet.add(id);
			}
			for (const id of strArr(prov.docIds)) {
				docIdSet.add(id);
			}
			for (const id of strArr(prov.transcriptIds)) {
				meetingIdSet.add(id);
			}
		}

		// Chunked, tenant-scoped resolution → one label map per type (no truncation).
		const resolveLabels = async <S extends { id: string }>(
			ids: string[],
			read: (chunk: string[]) => Promise<S[]>,
			toLabel: (row: S) => string,
		): Promise<Map<string, string>> => {
			const map = new Map<string, string>();
			for (const c of chunkIds(ids, WHY_SUGGESTED_ID_CHUNK)) {
				if (c.length === 0) {
					continue;
				}
				for (const row of await read(c)) {
					map.set(row.id, toLabel(row));
				}
			}
			return map;
		};

		const storyLabels = await resolveLabels(
			[...storyIdSet],
			(c) =>
				db.userStory.findMany({
					where: { projectId: o.projectId, id: { in: c } },
					select: { id: true, title: true },
				}),
			(row) => row.title,
		);
		const docLabels = await resolveLabels(
			[...docIdSet],
			(c) =>
				db.projectDocument.findMany({
					where: { projectId: o.projectId, id: { in: c } },
					select: { id: true, title: true },
				}),
			(row) => row.title,
		);
		const meetingLabels = await resolveLabels(
			[...meetingIdSet],
			(c) =>
				db.projectMeetingTranscript.findMany({
					where: { projectId: o.projectId, id: { in: c } },
					select: { id: true, meetingSubject: true },
				}),
			(row) => row.meetingSubject?.trim() || "",
		);

		// Compose per topic: dedupe → order stories→docs→meetings → cap.
		for (const r of rows) {
			const prov = (r.provenance ?? {}) as {
				storyIds?: unknown;
				docIds?: unknown;
				transcriptIds?: unknown;
				repoPrs?: unknown;
			};
			const named: PublishingWhySuggestedSource[] = [];
			const pushNamed = (
				ids: unknown,
				type: PublishingWhySuggestedSource["type"],
				labels: Map<string, string>,
			) => {
				for (const id of new Set(strArr(ids))) {
					const label = labels.get(id);
					if (label === undefined) {
						continue; // unresolved (deleted/foreign) — drop
					}
					named.push({ type, label });
				}
			};
			pushNamed(prov.storyIds, "story", storyLabels);
			pushNamed(prov.docIds, "document", docLabels);
			pushNamed(prov.transcriptIds, "meeting", meetingLabels);

			// Dedupe PRs by (repoFullName, prNumber), first occurrence.
			const prKeys = new Set<string>();
			if (Array.isArray(prov.repoPrs)) {
				for (const pr of prov.repoPrs) {
					if (pr && typeof pr === "object") {
						const repo = (pr as { repoFullName?: unknown })
							.repoFullName;
						const num = (pr as { prNumber?: unknown }).prNumber;
						if (
							typeof repo === "string" &&
							typeof num === "number"
						) {
							prKeys.add(`${repo}#${num}`);
						}
					}
				}
			}
			const prCount = prKeys.size;

			if (named.length === 0 && prCount === 0) {
				continue; // null — nothing to show
			}
			whySuggestedById.set(r.id, {
				named: named.slice(0, WHY_SUGGESTED_NAME_CAP),
				prCount,
				overflowCount: Math.max(
					0,
					named.length - WHY_SUGGESTED_NAME_CAP,
				),
			});
		}
	} catch (error) {
		whySuggestedById.clear(); // atomic degrade — all null; handles/recs/ranking untouched
		console.warn(
			"[listPublishingTopics] why-suggested provenance resolution failed — omitting provenance lines",
			{ projectId: o.projectId },
			error,
		);
	}

	// "Meeting participants" (global, display-only): resolve each cited meeting
	// transcript's free-text speakerNames to project members by STRICT
	// exact-normalized name match, fail-closed on ambiguity. Isolated
	// best-effort read (own try/catch) — a failure degrades EVERY topic's
	// meetingSpeakers to null WITHOUT touching whySuggested/handles/recs/ranking.
	// Tenant-scoped: transcript reads filter by projectId. NO FunctionTags gate
	// (runs whenever the suite is enabled). Heuristic name match only — an
	// external attendee sharing a member's name can false-positive; PO-accepted,
	// see spec D9 / §8.1, which is why the card label is the soft
	// "Meeting participants".
	const meetingSpeakersById = new Map<string, MeetingSpeakers>();
	try {
		const strArr = (v: unknown): string[] =>
			Array.isArray(v)
				? v.filter((x): x is string => typeof x === "string")
				: [];

		// Page-wide union of cited transcript ids; skip the whole block if none
		// (no roster/transcript reads when no topic cites a meeting).
		const transcriptIdSet = new Set<string>();
		for (const r of rows) {
			const prov = (r.provenance ?? {}) as { transcriptIds?: unknown };
			for (const id of strArr(prov.transcriptIds)) {
				transcriptIdSet.add(id);
			}
		}

		if (transcriptIdSet.size > 0) {
			// Dedicated, tenant-scoped, chunked read of speakerNames — kept
			// separate from the whySuggested meetingSubject read so the two
			// features degrade independently.
			const speakerNamesByTranscript = new Map<string, string[]>();
			for (const c of chunkIds(
				[...transcriptIdSet],
				WHY_SUGGESTED_ID_CHUNK,
			)) {
				if (c.length === 0) {
					continue;
				}
				const trs = await db.projectMeetingTranscript.findMany({
					where: { projectId: o.projectId, id: { in: c } },
					select: { id: true, speakerNames: true },
				});
				for (const t of trs) {
					speakerNamesByTranscript.set(t.id, t.speakerNames ?? []);
				}
			}

			// Roster index (distinct userIds per normalized name) for matching.
			const roster = await getProjectMembers(o.projectId);
			const rosterIndex = buildRosterIndex(roster);

			// Per topic -> set of matched member userIds across its transcripts
			// (cross-meeting dedupe via the Set), plus a page-wide union for a
			// single hydration read.
			const matchedIdsByTopic = new Map<string, Set<string>>();
			const allMatchedIds = new Set<string>();
			for (const r of rows) {
				const prov = (r.provenance ?? {}) as {
					transcriptIds?: unknown;
				};
				const ids = new Set<string>();
				for (const tid of new Set(strArr(prov.transcriptIds))) {
					for (const name of speakerNamesByTranscript.get(tid) ??
						[]) {
						const uid = matchSpeaker(name, rosterIndex);
						if (uid) {
							ids.add(uid);
							allMatchedIds.add(uid);
						}
					}
				}
				if (ids.size > 0) {
					matchedIdsByTopic.set(r.id, ids);
				}
			}

			// Hydrate display fields for every matched member in ONE read
			// (mirrors the contributor-handle hydration). A deleted user drops.
			const memberById = new Map<
				string,
				{ id: string; name: string | null; username: string | null }
			>();
			if (allMatchedIds.size > 0) {
				const users = await db.user.findMany({
					where: { id: { in: [...allMatchedIds] } },
					select: { id: true, name: true, username: true },
				});
				for (const u of users) {
					memberById.set(u.id, u);
				}
			}

			// Compose per topic: hydrate -> order/cap/overflow (pure builder).
			for (const [topicId, ids] of matchedIdsByTopic) {
				const members = [...ids]
					.map((id) => memberById.get(id))
					.filter((m): m is NonNullable<typeof m> => m != null);
				const value = buildMeetingSpeakers(members);
				if (value) {
					meetingSpeakersById.set(topicId, value);
				}
			}
		}
	} catch (error) {
		meetingSpeakersById.clear(); // atomic degrade — all null; others untouched
		console.warn(
			"[listPublishingTopics] meeting-participant resolution failed — omitting participant lines",
			{ projectId: o.projectId },
			error,
		);
	}

	const items: PublishingTopicListItem[] = rows.map((r) => {
		// Strip `provenance` from the serialized item — it is selected only to
		// drive resolution above and must never reach the client (AC-WS13).
		const {
			contributorUserIds,
			provenance,
			postTypesOverridden,
			userPostTypes: userPostTypesRaw,
			...rest
		} = r;
		void provenance;
		return {
			...rest,
			// Tri-state → single nullable wire field: null = not overridden
			// (client falls back to suggestedPostTypes); [] or a set = override.
			// `postTypesOverridden` is destructured out so it never leaks.
			userPostTypes: postTypesOverridden ? userPostTypesRaw : null,
			// FR14 default — overwritten ONLY on the successful partition path
			// (atomic graft below). Degrade paths keep this null.
			rankReason: null,
			// FR4-8 author recommendation — computed above; null when no fit,
			// flag off, or roster-read degrade. Independent of the ranking below,
			// so it survives every ranking return path (early-return, graft, catch).
			authorRecommendation: authorRecById.get(r.id) ?? null,
			whySuggested: whySuggestedById.get(r.id) ?? null,
			meetingSpeakers: meetingSpeakersById.get(r.id) ?? null,
			isSnoozed: isTopicSnoozed(r.snoozedUntil, now),
			isRead: readTopicIds.has(r.id),
			// `postTypeRecommendations` comes back as `Prisma.JsonValue`; the DB
			// guarantees the shape we wrote (persistCycleTerminal / Task 6), so a
			// typed cast at this query-layer boundary is plan-sanctioned — the
			// surface (Plan 2) stays cast-free.
			postTypeRecommendations:
				rest.postTypeRecommendations as PublishingTopicListItem["postTypeRecommendations"],
			contributors: contributorUserIds
				.map((id) => byId.get(id))
				.filter((u): u is NonNullable<typeof u> => u != null),
		};
	});

	// AC6: when handle resolution FAILED, the degrade contract is untagged AND
	// unranked — return plain recency order (the query's `createdAt desc`) and
	// skip the viewer partition entirely.
	if (!handlesResolved) {
		return { items };
	}

	// Independent best-effort read (decoupled from handle resolution): a failure
	// here degrades ONLY the role tier — never blanks handles, never throws.
	// Empty tags (flag off, read failure, OR viewer genuinely untagged)
	// collapses ranking to the 1B 2-tier contribution order.
	//
	// Gated behind the Role/Function Tags flag (#1767): when disabled, skip the
	// read entirely rather than paying for a query the flag guarantees goes
	// unused — flag-off always yields the 2-tier order.
	let viewerTags: FunctionTag[] = [];
	if (isFunctionTagsEnabled()) {
		try {
			const row = await db.projectUserFunctionTag.findUnique({
				where: {
					projectId_userId: {
						projectId: o.projectId,
						userId: o.viewerUserId,
					},
				},
				select: { tags: true },
			});
			viewerTags = row?.tags ?? [];
		} catch (error) {
			viewerTags = [];
			console.warn(
				"[listPublishingTopics] viewer function-tag read failed — role tier disabled (handles unaffected)",
				{ projectId: o.projectId },
				error,
			);
		}
	}

	// Three-tier, per-viewer ranking (1B role-aware): topics the viewer
	// contributed to first, then role-matched (not-contributed) topics, then
	// the rest — each tier keeps the `createdAt desc` order from the query
	// (stable partition). Best-effort: on any error, return plain recency
	// order.
	try {
		const viewerContributes = new Set(
			rows
				.filter((r) => r.contributorUserIds.includes(o.viewerUserId))
				.map((r) => r.id),
		);
		const viewerTagSet = new Set<FunctionTag>(viewerTags);
		const roleMatched = new Set(
			rows
				.filter(
					(r) =>
						!viewerContributes.has(r.id) &&
						r.relevantFunctionTags.some((t) => viewerTagSet.has(t)),
				)
				.map((r) => r.id),
		);
		const tier1: PublishingTopicListItem[] = [];
		const tier2: PublishingTopicListItem[] = [];
		const tier3: PublishingTopicListItem[] = [];
		for (const it of items) {
			if (viewerContributes.has(it.id)) {
				tier1.push(it);
			} else if (roleMatched.has(it.id)) {
				tier2.push(it);
			} else {
				tier3.push(it);
			}
		}
		// FR14: graft the per-viewer rank reason ATOMICALLY. Build a FRESH array
		// only after partitioning succeeded, spreading the reason onto NEW objects
		// — the `items` objects are never mutated. So the `catch` below (and the
		// `!handlesResolved` early return) return pristine, null-reason items,
		// honoring FR14.6 (Codex-caught degrade hole).
		return {
			items: [
				...tier1.map(
					(it): PublishingTopicListItem => ({
						...it,
						rankReason: { kind: "contributed" },
					}),
				),
				...tier2.map(
					(it): PublishingTopicListItem => ({
						...it,
						rankReason: {
							kind: "role_match",
							matchedTags: it.relevantFunctionTags.filter((t) =>
								viewerTagSet.has(t),
							),
						},
					}),
				),
				...tier3, // tier 3 keeps its null default
			],
		};
	} catch {
		return { items };
	}
}

export async function getLatestPublishingCycle(projectId: string): Promise<{
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
} | null> {
	return db.publishingSuggestionCycle.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
		select: { id: true, status: true, startedAt: true, completedAt: true },
	});
}

/**
 * The buckets a reader of the cycle history filters by, over the five
 * `PublishingCycleStatus` values (Fizzy #1850, Phase 1C-4a).
 *
 * `GENERATING` is deliberately in no bucket. It is not an outcome but a cycle
 * still running, so it appears under `all` and nowhere else — a "running"
 * bucket would be a filter whose contents change while it is being read.
 */
export type PublishingCycleStatusFilter = "all" | "ready" | "failed" | "empty";

const CYCLE_STATUS_BUCKETS = {
	ready: ["READY"],
	failed: ["FAILED"],
	// Two distinct causes, one meaning to a reader: the run finished and
	// produced nothing. Separating them in the filter would ask for a decision
	// nobody can act on differently.
	empty: ["NO_TOPICS", "INSUFFICIENT_CONTEXT"],
} as const satisfies Record<
	Exclude<PublishingCycleStatusFilter, "all">,
	readonly PublishingCycleStatus[]
>;

function cycleHistoryWhere(
	projectId: string,
	status: PublishingCycleStatusFilter,
) {
	return status === "all"
		? { projectId }
		: { projectId, status: { in: [...CYCLE_STATUS_BUCKETS[status]] } };
}

/**
 * One page of a project's past suggestion cycles, newest first.
 *
 * Ordered on `createdAt` THEN `id`. The tiebreak is load-bearing rather than
 * tidiness: cycles inserted in the same millisecond otherwise order arbitrarily
 * between the two statements that make up a page, which surfaces as one row
 * served on two pages while another is served on neither.
 * `@@index([projectId, createdAt])` already exists on the model and serves
 * this — no migration is needed for this reader.
 *
 * `triggeredByUserId` is selected because the caller has to tell a scheduled
 * run from a manual one. It must NOT reach a client: see the procedure, which
 * maps it to a two-value label rather than passing the id through.
 */
export async function listPublishingCycles(
	projectId: string,
	opts: {
		limit: number;
		offset: number;
		status: PublishingCycleStatusFilter;
	},
) {
	return db.publishingSuggestionCycle.findMany({
		where: cycleHistoryWhere(projectId, opts.status),
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: opts.limit,
		skip: opts.offset,
		select: {
			id: true,
			status: true,
			startedAt: true,
			completedAt: true,
			triggeredByUserId: true,
			// The cycle-level answer to "did in-app/email go out, and if not,
			// why" (§9.7). Selected here rather than aggregated from the
			// delivery ledger on purpose: the ledger cannot answer it. Six of
			// the outcomes — DISABLED, NO_RECIPIENTS, CANCELLED among them —
			// are states in which NO row is written at all, so a reader
			// counting rows sees zero for all of them and for a healthy cycle
			// that simply had nobody to notify.
			notificationOutcome: true,
			// A manually created topic carries a null cycleId, so this counts
			// exactly the topics this cycle produced.
			_count: { select: { topics: true, chatDeliveries: true } },
		},
	});
}

/**
 * Per-cycle notification reach, counted in PEOPLE rather than in ledger rows.
 *
 * The distinction is the whole reason this is a separate query. The ledger is
 * unique on `(cycleId, recipientUserId, channel)`, so one person owed both an
 * in-app notification and an email holds TWO rows — and a relation count would
 * report them as two people. Grouping by `(cycleId, recipientUserId)` collapses
 * the channels first, so `owed` and `delivered` both count humans.
 *
 * `_max.deliveredAt` is what decides `delivered`: a person counts as reached
 * when ANY of their channels landed, which matches how the cycle-level outcome
 * is derived (§9.7 step 2 — an email that arrived is a delivery as much as a
 * bell is). Somebody who got the email but not the bell has been notified.
 *
 * Cycles with no ledger rows are simply absent from the result. That is not a
 * gap: six of the nine outcomes write no row at all, so "no rows" is the
 * ordinary state for a refresh that never owed anybody anything, and the caller
 * reads a missing entry as zero.
 */
export async function countPublishingCycleRecipients(
	projectId: string,
	cycleIds: string[],
): Promise<Record<string, { owed: number; delivered: number }>> {
	if (cycleIds.length === 0) {
		return {};
	}
	const rows = await db.publishingNotificationDelivery.groupBy({
		by: ["cycleId", "recipientUserId"],
		// `projectId` as well as the ids, matching
		// `listPublishingChatDeliveriesForProjectCycle`. Today's only caller
		// derives the ids from an authorized read of this same project, so the
		// filter is redundant on that path — which is exactly why it belongs in
		// the query rather than in the caller. It makes the function safe to
		// call with ids from anywhere, instead of safe only while every caller
		// remembers where its ids came from.
		where: { projectId, cycleId: { in: cycleIds } },
		_max: { deliveredAt: true },
	});

	const byCycle: Record<string, { owed: number; delivered: number }> = {};
	for (const row of rows) {
		let entry = byCycle[row.cycleId];
		if (!entry) {
			entry = { owed: 0, delivered: 0 };
			byCycle[row.cycleId] = entry;
		}
		// One group per (cycle, person), so this counts people.
		entry.owed += 1;
		if (row._max.deliveredAt !== null) {
			entry.delivered += 1;
		}
	}
	return byCycle;
}

/**
 * Total for the SAME filter `listPublishingCycles` was called with — the two
 * have to move together, or the pager offers pages that hold nothing.
 */
export async function countPublishingCycles(
	projectId: string,
	status: PublishingCycleStatusFilter,
): Promise<number> {
	return db.publishingSuggestionCycle.count({
		where: cycleHistoryWhere(projectId, status),
	});
}

/**
 * Thrown by `createManualPublishingTopic` when the target Project row does not
 * exist under the FOR UPDATE lock. The create procedure maps it to
 * `ORPCError("NOT_FOUND")`, preserving the pre-atomic observable contract
 * (`resolveProjectTenant` returning null → NOT_FOUND).
 */
export class PublishingTopicProjectNotFoundError extends Error {
	constructor(readonly projectId: string) {
		super(`Project ${projectId} not found`);
		this.name = "PublishingTopicProjectNotFoundError";
	}
}

/**
 * Thrown by `createManualPublishingTopic` when the caller supplied a
 * POSITIVELY-WRONG non-null `clientOrganizationId` that does not match the
 * LOCKED Project's current org tuple (F2). Checked inside the transaction
 * against the freshly-locked tenant, so the guard is race-free. `null`/omitted
 * always passes (a guest on a personal-context page). The create procedure maps
 * it to `ORPCError("BAD_REQUEST")`.
 */
export class PublishingTopicTenantMismatchError extends Error {
	constructor(readonly projectId: string) {
		super(`organizationId does not match project ${projectId}`);
		this.name = "PublishingTopicTenantMismatchError";
	}
}

/**
 * Create a manual (`origin: MANUAL`, `status: SELECTED`) topic, deriving and
 * stamping its tenant columns from the Project row ATOMICALLY.
 *
 * C-High (tenant TOCTOU): the tenant tuple and the insert MUST be one indivisible
 * operation. `resolveProjectTenant` (a plain read) followed by a bare
 * `db.publishingTopic.create` is two separate DB ops — if the Project transfers
 * org A→B in the window between them, the topic is stamped with the stale org A
 * while pointing at a now-org-B project (tenant/XOR mismatch, wrong RLS tenant,
 * topic potentially invisible to its project). This helper mirrors
 * `persistCycleTerminal`'s F1 fix: open a transaction, re-lock the Project row
 * `FOR UPDATE` (Prisma has no `FOR UPDATE` on findUnique — use raw SQL), re-derive
 * the XOR-normalized tenant tuple from the LOCKED row (org → userId null; personal
 * → org null — identical normalization to `resolveProjectTenant`), validate the F2
 * client-org check against that locked tuple, and insert within the SAME
 * transaction. `FOR UPDATE` blocks a concurrent transfer from committing until this
 * tx does, closing the window rather than detecting it after the fact.
 *
 * The worker/API run BYPASSRLS, so the explicit tenant columns — not RLS — are the
 * isolation boundary; deriving them under lock is what keeps the write tenant-safe.
 */
export async function createManualPublishingTopic(i: {
	projectId: string;
	/**
	 * Raw client-supplied org, used ONLY for the F2 guard — NEVER stamped. The
	 * stamped tenant columns always come from the locked Project row. `null`/
	 * omitted passes (guest on a personal-context page); a positively-wrong
	 * non-null value throws `PublishingTopicTenantMismatchError`.
	 */
	clientOrganizationId?: string | null;
	createdById: string;
	title: string;
	description?: string | null;
}): Promise<{ topic: PublishingTopicRecord }> {
	return db.$transaction(async (tx) => {
		// Re-lock + re-read the Project's CURRENT row inside this transaction.
		// Prisma has no `FOR UPDATE` on findUnique, so use raw SQL (exactly as
		// persistCycleTerminal does). A concurrent org transfer cannot commit
		// until this tx releases the lock, so the tuple derived below is the
		// Project's tenant AT INSERT TIME.
		const rows = await tx.$queryRaw<
			{ organizationId: string | null; userId: string }[]
		>`SELECT "organizationId", "userId" FROM "project" WHERE "id" = ${i.projectId} FOR UPDATE`;
		const project = rows[0];
		if (!project) {
			// Mirrors the pre-atomic contract: resolveProjectTenant → null → NOT_FOUND.
			throw new PublishingTopicProjectNotFoundError(i.projectId);
		}

		// XOR-normalize the LOCKED row (H1): org project → userId null; personal →
		// org null. Identical to resolveProjectTenant, but derived from the row this
		// transaction holds a lock on rather than a separate, race-prone read.
		const organizationId = project.organizationId ?? null;
		const userId = organizationId ? null : project.userId;

		// F2 (race-free): reject only a POSITIVELY-WRONG non-null client org,
		// checked against the LOCKED tuple. null/omitted passes — tenant columns
		// come from the Project regardless.
		if (
			i.clientOrganizationId != null &&
			i.clientOrganizationId !== organizationId
		) {
			throw new PublishingTopicTenantMismatchError(i.projectId);
		}

		// Insert within the same transaction using the freshly-locked tenant. A
		// project-wide (projectId, dedupeKey) unique violation surfaces as the raw
		// P2002 (the tx rolls back); the create procedure maps it to CONFLICT.
		const topic = await tx.publishingTopic.create({
			data: {
				projectId: i.projectId,
				organizationId,
				userId,
				cycleId: null,
				title: i.title,
				pitch: i.description ?? null,
				status: "SELECTED",
				origin: "MANUAL",
				createdById: i.createdById,
				dedupeKey: computeDedupeKey(i.projectId, i.title),
				contributorUserIds: [i.createdById], // FR-11a / DV-8: creator is sole contributor
				suggestedPostTypes: [], // FR-11a: manual topics get no AI post types
				relevantFunctionTags: [], // 1B: manual topics carry no AI role-aware enrichment
				postTypeRecommendations: [], // 1B: manual topics carry no AI role-aware enrichment
			},
			select: TOPIC_SELECT,
		});
		return { topic };
	});
}

export async function updatePublishingTopicStatus(i: {
	id: string;
	projectId: string;
	status: string;
	declineReason?: string | null;
	publishedUrl?: string | null;
}): Promise<{ topic: PublishingTopicRecord } | null> {
	const { count } = await db.publishingTopic.updateMany({
		where: { id: i.id, projectId: i.projectId }, // project-scoped guard
		data: {
			status: i.status as never,
			// declineReason is only meaningful for DECLINED — always keep it in
			// sync with the target status so a transition OUT of DECLINED can
			// never leave a stale reason behind (Copilot).
			declineReason:
				i.status === "DECLINED" ? (i.declineReason ?? null) : null,
			// publishedUrl is only meaningful for PUBLISHED — same in-sync rule,
			// so leaving PUBLISHED clears any stale URL (FR14/FR15/DV5).
			publishedUrl:
				i.status === "PUBLISHED" ? (i.publishedUrl ?? null) : null,
		},
	});
	if (count === 0) {
		return null;
	}
	const topic = await db.publishingTopic.findFirst({
		where: { id: i.id, projectId: i.projectId },
		select: TOPIC_SELECT,
	});
	return topic ? { topic } : null;
}

/**
 * Set or reset a topic's user post-type override (1B tail). `postTypes === null`
 * resets to the AI suggestion (`postTypesOverridden=false`, `userPostTypes=[]`);
 * a non-null array (possibly empty) is an explicit override. Project-scoped like
 * `updatePublishingTopicStatus` and writes NO tenant columns, so it carries no
 * P1 risk (spec §8.1 — tenant-transfer TOCTOU is a deferred repo-wide concern,
 * NOT closed here). Dedupes defensively; the procedure enum-checks and caps.
 */
export async function updatePublishingTopicPostTypes(i: {
	id: string;
	projectId: string;
	postTypes: PublishingTopicPostType[] | null;
}): Promise<{ topic: PublishingTopicRecord } | null> {
	const data =
		i.postTypes === null
			? { postTypesOverridden: false, userPostTypes: [] }
			: {
					postTypesOverridden: true,
					userPostTypes: Array.from(new Set(i.postTypes)),
				};
	const { count } = await db.publishingTopic.updateMany({
		where: { id: i.id, projectId: i.projectId }, // project-scoped guard
		data,
	});
	if (count === 0) {
		return null;
	}
	const topic = await db.publishingTopic.findFirst({
		where: { id: i.id, projectId: i.projectId },
		select: TOPIC_SELECT,
	});
	return topic ? { topic } : null;
}

/**
 * Set or clear a topic's snooze (1D, Fizzy #2265). `preset === null` clears
 * both fields — an un-snoozed topic must not keep a rationale explaining a
 * state it is no longer in.
 *
 * The wake time is derived HERE from the preset and never accepted from the
 * caller, which is what makes FR6's "no custom durations" enforceable rather
 * than a UI convention. `now` is injectable for tests only; callers omit it.
 *
 * Project-scoped like `updatePublishingTopicStatus`, and writes no tenant
 * columns.
 */
export async function setPublishingTopicSnooze(i: {
	id: string;
	projectId: string;
	preset: PublishingSnoozePreset | null;
	reason?: string | null;
	now?: Date;
}): Promise<{ topic: PublishingTopicRecord } | null> {
	const trimmed = i.reason?.trim();
	const { count } = await db.publishingTopic.updateMany({
		where: { id: i.id, projectId: i.projectId }, // project-scoped guard
		data:
			i.preset === null
				? { snoozedUntil: null, snoozeReason: null }
				: {
						snoozedUntil: resolvePublishingSnoozeUntil(
							i.preset,
							i.now ?? new Date(),
						),
						snoozeReason: trimmed ? trimmed : null,
					},
	});
	if (count === 0) {
		return null;
	}
	const topic = await db.publishingTopic.findFirst({
		where: { id: i.id, projectId: i.projectId },
		select: TOPIC_SELECT,
	});
	return topic ? { topic } : null;
}

/**
 * Set one user's read marker for one topic (1D, Fizzy #2265). Row presence is
 * the whole state: `read: true` upserts, `read: false` deletes.
 *
 * The marker's tenant columns are copied FROM THE PARENT TOPIC ROW, never from
 * the request's ambient tenant context — a denormalized column should be
 * derived from the row it was denormalized from, or it drifts the moment an
 * access rule changes.
 *
 * Returns false only when the topic does not exist in this project. Marking an
 * already-unread topic unread is a successful no-op, not an error.
 */
export async function setPublishingTopicReadState(i: {
	id: string;
	projectId: string;
	userId: string;
	read: boolean;
}): Promise<boolean> {
	const topic = await db.publishingTopic.findFirst({
		where: { id: i.id, projectId: i.projectId }, // project-scoped guard
		select: { id: true, projectId: true, organizationId: true },
	});
	if (!topic) {
		return false;
	}
	if (!i.read) {
		await db.publishingTopicRead.deleteMany({
			where: { topicId: topic.id, userId: i.userId },
		});
		return true;
	}
	await db.publishingTopicRead.upsert({
		where: { topicId_userId: { topicId: topic.id, userId: i.userId } },
		create: {
			topicId: topic.id,
			userId: i.userId,
			projectId: topic.projectId,
			organizationId: topic.organizationId,
		},
		update: { readAt: new Date() },
	});
	return true;
}

/**
 * Resolve the Fabric user IDs whose work a topic derives from, from its
 * provenance. Only sources that carry real user FKs contribute: stories
 * (createdById + assigneeId) and documents (userId). PR authors are resolved
 * when githubAuthorIds is supplied — via a linked Account(providerId:"github",
 * accountId) in the isolated, fail-closed branch below (that read is
 * intentionally NOT project-scoped: per design decision D3 it may surface any
 * linked Fabric user). Transcript speakers (free-text names) remain
 * unresolvable and are excluded (see 1B design §4). Scoped by projectId so a
 * malformed provenance id from another project can never resolve. The worker
 * runs BYPASSRLS — projectId IS the isolation boundary here.
 */
export async function resolveProjectContributorIds(
	projectId: string,
	provenance: {
		storyIds?: string[];
		docIds?: string[];
		githubAuthorIds?: string[];
	},
): Promise<string[]> {
	const storyIds = provenance.storyIds ?? [];
	const docIds = provenance.docIds ?? [];
	const githubAuthorIds = provenance.githubAuthorIds ?? [];
	if (
		storyIds.length === 0 &&
		docIds.length === 0 &&
		githubAuthorIds.length === 0
	) {
		return [];
	}

	// Story/doc resolution — the established path. Its own failure still
	// propagates to the caller (the activity's degrade-to-[] catch), unchanged.
	const [stories, docs] = await Promise.all([
		storyIds.length > 0
			? db.userStory.findMany({
					where: { projectId, id: { in: storyIds } },
					select: { createdById: true, assigneeId: true },
				})
			: Promise.resolve([]),
		docIds.length > 0
			? db.projectDocument.findMany({
					where: { projectId, id: { in: docIds } },
					select: { userId: true },
				})
			: Promise.resolve([]),
	]);

	const ids = new Set<string>();
	for (const s of stories) {
		if (s.createdById) {
			ids.add(s.createdById);
		}
		if (s.assigneeId) {
			ids.add(s.assigneeId);
		}
	}
	for (const d of docs) {
		if (d.userId) {
			ids.add(d.userId);
		}
	}

	// FR-A2/A4/A6: PR-author resolution — ISOLATED from the story/doc set above.
	// A failure here omits ONLY PR authors (story/doc set is preserved). An
	// accountId that maps to >1 distinct userId is ambiguous → credit nobody for
	// it (fail-closed), never fan out to every linked profile. Account/User are
	// global identity tables (not tenant-RLS-scoped); the worker runs BYPASSRLS.
	if (githubAuthorIds.length > 0) {
		try {
			const accounts = await db.account.findMany({
				where: {
					providerId: "github",
					accountId: { in: githubAuthorIds },
				},
				select: { accountId: true, userId: true },
			});
			const usersByAccountId = new Map<string, Set<string>>();
			for (const a of accounts) {
				let set = usersByAccountId.get(a.accountId);
				if (!set) {
					set = new Set<string>();
					usersByAccountId.set(a.accountId, set);
				}
				set.add(a.userId);
			}
			for (const [accountId, userIds] of usersByAccountId) {
				if (userIds.size === 1) {
					for (const uid of userIds) {
						ids.add(uid);
					}
				} else {
					console.warn(
						"[publishing-suite] ambiguous github account maps to multiple Fabric users; crediting nobody (fail-closed)",
						{ projectId, accountId, userCount: userIds.size },
					);
				}
			}
		} catch (error) {
			// FR-A4 isolation: a PR-author lookup failure must never erase the
			// story/doc contributors resolved above, nor fail the cycle.
			console.warn(
				"[publishing-suite] PR-author resolution failed; keeping story/doc contributors only",
				{ projectId },
				error,
			);
		}
	}

	return [...ids];
}

// H1: resolveProjectTenant returns the XOR-NORMALIZED tenant tuple — NEVER the raw Project
// row. Project.userId is non-nullable (schema.prisma:1314), so copying it verbatim would stamp
// BOTH columns on an org project, breaking the XOR invariant (enforced DB-side by the
// publishing_topic_tenant_xor / publishing_suggestion_cycle_tenant_xor CHECK constraints) and
// disagreeing with the engine's own tuple. Style-1 stamping, identical to
// request-regeneration.ts:195-196 / sends-send-now.ts:114. Used by the create procedure
// (Task 2) to stamp tenant columns from a fresh Project read instead of trusting client input.
export async function resolveProjectTenant(
	projectId: string,
): Promise<{ organizationId: string | null; userId: string | null } | null> {
	const p = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	if (!p) {
		return null;
	}
	return {
		organizationId: p.organizationId ?? null,
		userId: p.organizationId ? null : p.userId, // org → userId null; personal → keep owner
	};
}
