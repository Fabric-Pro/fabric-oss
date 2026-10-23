/**
 * Recurring-error scan for one project: find problems that keep happening and
 * put each one in the review inbox as a BUG proposal, once.
 *
 * Two sources feed it:
 *   - LOG: application errors grouped by the project's log source over the
 *     project's window. Groups seen fewer times than its threshold are
 *     ignored entirely.
 *   - INCIDENT: open bug reports in Fabric that the duplicate detector judged
 *     to describe the same problem, in clusters of at least the threshold.
 *
 * Each problem is a `RecurringErrorSignature` keyed by fingerprint, and what
 * its earlier filing became decides what a recurrence does:
 *   - still awaiting review   -> refresh that proposal's evidence;
 *   - approved, bug still open -> add the new occurrences to the bug as a note;
 *   - rejected or parked       -> nothing (a person already decided);
 *   - nothing open             -> draft and file a new proposal, unless the
 *     log error is already tracked (`match-open-bug.ts`): by an open bug
 *     someone filed, and then the occurrences go on that bug and the
 *     signature follows it, as if a proposal had become it; or by a pending
 *     proposal for another error group of the same problem, which it joins.
 *
 * Notes on open bugs are written once per bug at the end of the scan, so a
 * problem that logs several distinct messages makes one comment, not several.
 *
 * Failures are visible, never silent: each one writes an audit row and the
 * project's last-scan error, which the settings toggle shows. One failing
 * group does not stop the others.
 */
import { runWithAiJobType } from "@repo/ai/lib/job-context";
import {
	CONFIDENCE_THRESHOLD,
	createPendingBacklogProposal,
	createStoryComment,
	db,
	ensureFabricSystemUser,
	FABRIC_SYSTEM_USER_ID,
	findRecurringErrorSignatures,
	isRecurringErrorScanEnabled,
	linkRecurringErrorSignature,
	listRecurringErrorSignatures,
	type Prisma,
	type RecurringErrorObservation,
	type RecurringErrorSignature,
	recordAudit,
	recordRecurringErrorScanOutcome,
	refreshRecurringErrorProposalEvidence,
	resolveSignatureTracking,
	type SignatureTrackingState,
	upsertRecurringErrorSignature,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { type DraftSubject, draftRecurringBugReport } from "./draft-bug-report";
import {
	type BugReportDraft,
	buildRecurringBugProposal,
	fallbackIncidentDraft,
	fallbackLogDraft,
	type IncidentCluster,
	incidentReasoning,
	logReasoning,
	type RedactedErrorGroup,
	redactErrorGroup,
	renderIncidentEvidence,
	renderLogEvidence,
} from "./evidence";
import {
	fingerprintCluster,
	matchClusterToSignature,
	mergeErrorGroups,
} from "./fingerprint";
import { findOpenBugClusters } from "./incident-clusters";
import { createOpenBugMatcher, type OpenBugCheck } from "./match-open-bug";
import { resolveRecurringErrorSource } from "./resolve-error-source";

const RECURRING_ERROR_REPORTER_NAME = "Fabric recurring-error scan";

/** Groups one scan may file or refresh — the most frequent first. */
const MAX_GROUPS_PER_SCAN = 25;

export interface ScanRecurringErrorsInput {
	projectId: string;
	organizationId: string | null;
	/** Project owner: the attributed user for proposals the scan files. */
	userId: string;
	threshold: number;
	windowHours: number;
	/**
	 * Minimum verifier confidence for two errors, or an error and an open bug,
	 * to count as the same problem. Optional only for scans started before it
	 * was configurable; those use the former fixed value.
	 */
	similarityThreshold?: number;
}

export interface ScanRecurringErrorsResult {
	status: "disabled" | "completed" | "completed-with-errors";
	/** Whether a log source the scan can read is configured. */
	logSourceConfigured: boolean;
	groupsAboveThreshold: number;
	clusters: number;
	filed: number;
	refreshed: number;
	/** Error groups added to a pending proposal for the same problem. */
	grouped: number;
	notedOnStory: number;
	suppressed: number;
	failures: number;
}

type Outcome =
	| "filed"
	| "refreshed"
	| "grouped"
	| "notedOnStory"
	| "suppressed";

interface ScanContext extends ScanRecurringErrorsInput {
	similarityThreshold: number;
	scannedAt: Date;
	errors: string[];
	/** Occurrences to note on each open bug, written once when the scan ends. */
	storyNotes: Map<
		string,
		{
			organizationId: string | null;
			sections: string[];
			fingerprints: string[];
			/** The verdicts that put matched errors here, for review. */
			matches: Array<{
				fingerprint: string;
				confidence: number;
				similarityThreshold: number;
			}>;
		}
	>;
}

/** How sure the judge was, against the bar it had to clear. */
function matchLine(confidence: number, similarityThreshold: number): string {
	return `Judged the same problem with confidence ${confidence.toFixed(2)}; this project groups at ${similarityThreshold.toFixed(2)} or above.`;
}

/** A short, credential-free reason, safe for the settings UI and the audit row. */
function failureReason(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/\s+/g, " ").slice(0, 200);
}

function recordFailure(
	ctx: ScanContext,
	stage:
		| "log-source"
		| "incidents"
		| "proposal"
		| "open-bug-match"
		| "story-note",
	err: unknown,
	extra: Record<string, unknown> = {},
): void {
	const reason = failureReason(err);
	ctx.errors.push(`${stage}: ${reason}`);
	logger.warn("[RecurringErrors] scan step failed", {
		projectId: ctx.projectId,
		stage,
		reason,
		...extra,
	});
	recordAudit({
		action: "backlog.recurring_errors.scan_failed",
		category: "backlog",
		severity: "warning",
		outcome: "failure",
		actor: { type: "system", nameSnapshot: "recurring-error-scan" },
		organizationId: ctx.organizationId,
		projectId: ctx.projectId,
		resource: { type: "project", id: ctx.projectId },
		metadata: { stage, reason, ...extra },
	});
}

interface ProblemToFile {
	source: "LOG" | "INCIDENT";
	fingerprint: string;
	existing: RecurringErrorSignature | null;
	observation: RecurringErrorObservation;
	evidence: string;
	reasoning: string;
	sourceContext: "application_logs" | "bug_reports";
	subject: DraftSubject;
	fallback: BugReportDraft;
	recurringError: Prisma.InputJsonObject;
	/** The problem's headline, used where its evidence sits beside others'. */
	title: string;
	/** Whether a linked open story should hear about this recurrence. */
	hasNewEvidence: boolean;
	/** What the previous scan recorded, said when the problem recurs. */
	previously?: string;
	/**
	 * An open bug or pending proposal already tracking this problem, looked up
	 * before filing.
	 */
	findOpenBug?: () => Promise<OpenBugCheck>;
	/** Told about the proposal filed for this problem. */
	onFiled?: (proposalId: string, title: string) => void;
}

async function trackingOf(
	existing: RecurringErrorSignature | null,
): Promise<SignatureTrackingState> {
	return existing ? resolveSignatureTracking(existing) : { state: "none" };
}

type SignatureUpsert = (
	client?: Prisma.TransactionClient,
) => ReturnType<typeof upsertRecurringErrorSignature>;

/**
 * Point the signature at an open bug and queue the occurrences for it. The
 * note is written once per bug when the scan ends (`postStoryNotes`), so
 * several error groups of one problem make one comment, not one each.
 */
async function noteOnStory(
	ctx: ScanContext,
	problem: ProblemToFile,
	upsert: SignatureUpsert,
	note: {
		storyId: string;
		organizationId: string | null;
		lead: string;
		comment: boolean;
		/** Set when the matcher, not an earlier link, put the error here. */
		matchConfidence?: number;
	},
): Promise<"notedOnStory"> {
	const signature = await upsert();
	await linkRecurringErrorSignature(signature.id, { storyId: note.storyId });
	if (note.comment) {
		const queued = ctx.storyNotes.get(note.storyId) ?? {
			organizationId: note.organizationId,
			sections: [],
			fingerprints: [],
			matches: [],
		};
		const { matchConfidence } = note;
		queued.sections.push(
			[
				note.lead,
				matchConfidence === undefined
					? undefined
					: matchLine(matchConfidence, ctx.similarityThreshold),
				problem.previously,
				"",
				problem.evidence,
			]
				.filter((line) => line !== undefined)
				.join("\n"),
		);
		queued.fingerprints.push(problem.fingerprint);
		if (matchConfidence !== undefined) {
			queued.matches.push({
				fingerprint: problem.fingerprint,
				confidence: matchConfidence,
				similarityThreshold: ctx.similarityThreshold,
			});
		}
		ctx.storyNotes.set(note.storyId, queued);
	}
	return "notedOnStory";
}

/** One comment per bug the scan added occurrences to. */
async function postStoryNotes(ctx: ScanContext): Promise<void> {
	if (ctx.storyNotes.size === 0) {
		return;
	}
	await ensureFabricSystemUser();
	for (const [storyId, note] of ctx.storyNotes) {
		const content =
			note.sections.length === 1
				? (note.sections[0] ?? "")
				: [
						`Fabric's recurring-error scan found ${note.sections.length} recurring errors for this bug.`,
						...note.sections,
					].join("\n\n---\n\n");
		try {
			await createStoryComment({
				storyId,
				authorId: FABRIC_SYSTEM_USER_ID,
				authorType: "AGENT",
				content,
				organizationId: note.organizationId,
				metadata: {
					source: "recurring_error_scan",
					fingerprints: note.fingerprints,
					...(note.matches.length > 0
						? { matches: note.matches }
						: {}),
				},
			});
		} catch (err) {
			recordFailure(ctx, "story-note", err, { storyId });
		}
	}
}

/**
 * Add a problem's evidence to a pending proposal for the same problem, and
 * point the signature at it. False when the proposal is no longer pending.
 */
async function joinProposal(
	problem: ProblemToFile,
	upsert: SignatureUpsert,
	proposalId: string,
): Promise<boolean> {
	const joined = await refreshRecurringErrorProposalEvidence(proposalId, {
		fingerprint: problem.fingerprint,
		title: problem.title,
		recurringError: problem.recurringError,
		transcript: problem.evidence,
	});
	if (joined) {
		const signature = await upsert();
		await linkRecurringErrorSignature(signature.id, {
			pendingProposalId: proposalId,
			storyId: null,
		});
	}
	return joined;
}

/**
 * The open bugs checked for this problem and the one that tracks it, if any.
 * A failed lookup is recorded and treated as no match, so the problem is
 * still filed.
 */
async function findOpenBug(
	ctx: ScanContext,
	problem: ProblemToFile,
): Promise<OpenBugCheck | null> {
	if (!problem.findOpenBug) {
		return null;
	}
	try {
		return await problem.findOpenBug();
	} catch (err) {
		recordFailure(ctx, "open-bug-match", err, {
			source: problem.source,
			fingerprint: problem.fingerprint,
		});
		return null;
	}
}

/**
 * Apply one problem's outcome. Filing is the only branch that creates
 * anything, and the proposal and the signature's link to it commit together,
 * so a retried activity cannot leave a proposal no signature points at.
 */
async function settleProblem(
	ctx: ScanContext,
	problem: ProblemToFile,
): Promise<Outcome> {
	const tracking = await trackingOf(problem.existing);
	const upsert: SignatureUpsert = (client) =>
		upsertRecurringErrorSignature(
			{
				projectId: ctx.projectId,
				source: problem.source,
				fingerprint: problem.fingerprint,
				observation: problem.observation,
				scannedAt: ctx.scannedAt,
			},
			client,
		);

	switch (tracking.state) {
		case "pending": {
			const signature = await upsert();
			await refreshRecurringErrorProposalEvidence(tracking.proposalId, {
				fingerprint: problem.fingerprint,
				title: problem.title,
				recurringError: problem.recurringError,
				transcript: problem.evidence,
			});
			await linkRecurringErrorSignature(signature.id, {
				pendingProposalId: tracking.proposalId,
			});
			return "refreshed";
		}
		case "open-story":
			return noteOnStory(ctx, problem, upsert, {
				storyId: tracking.storyId,
				organizationId: tracking.organizationId ?? null,
				lead: "This problem is still recurring.",
				comment: problem.hasNewEvidence,
			});
		case "declined":
			await upsert();
			return "suppressed";
		case "none": {
			const check = await findOpenBug(ctx, problem);
			const match = check?.match;
			if (match?.kind === "story") {
				return noteOnStory(ctx, problem, upsert, {
					storyId: match.storyId,
					organizationId: ctx.organizationId,
					lead: "Fabric's recurring-error scan matched these errors to this bug, so it added them here instead of proposing a new one.",
					comment: true,
					matchConfidence: match.confidence,
				});
			}
			if (
				match?.kind === "proposal" &&
				(await joinProposal(
					{
						...problem,
						// Kept with the joined evidence, so a reviewer can see why
						// this error was grouped into the proposal.
						recurringError: {
							...problem.recurringError,
							matchConfidence: match.confidence,
						},
					},
					upsert,
					match.proposalId,
				))
			) {
				return "grouped";
			}
			const draft =
				(await draftRecurringBugReport({
					projectId: ctx.projectId,
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					subject: problem.subject,
					evidence: problem.evidence,
				})) ?? problem.fallback;
			const proposal = buildRecurringBugProposal({
				draft,
				reasoning: problem.reasoning,
				sourceContext: problem.sourceContext,
				fingerprint: problem.fingerprint,
			});
			const proposalId = await db.$transaction(async (tx) => {
				const signature = await upsert(tx);
				const pending = await createPendingBacklogProposal(
					{
						projectId: ctx.projectId,
						source:
							problem.source === "LOG"
								? "LOG_MONITOR"
								: "INCIDENT_CLUSTER",
						proposal,
						summary: draft.title,
						changeCount: proposal.changes.length,
						sourceMetadata: {
							recurringError: check
								? {
										...problem.recurringError,
										// What was ruled out before filing, so a reviewer
										// can see why this is not a note on an open bug or
										// part of another proposal.
										openBugCheck: check.checked.map(
											(bug) => ({
												...bug,
											}),
										),
									}
								: problem.recurringError,
							// Read by the approve path as the drafting step's
							// additional context, like a monitored thread's text.
							transcript: problem.evidence,
							// The approved bug's reporter, as a thread's author
							// would be for a monitored-channel proposal.
							reporterName: RECURRING_ERROR_REPORTER_NAME,
						},
						userId: ctx.userId,
						organizationId: ctx.organizationId ?? undefined,
					},
					tx,
				);
				await linkRecurringErrorSignature(
					signature.id,
					{ pendingProposalId: pending.id, storyId: null },
					tx,
				);
				return pending.id;
			});
			problem.onFiled?.(proposalId, draft.title);
			return "filed";
		}
		default: {
			const unreachable: never = tracking;
			throw new Error(`Unhandled tracking state: ${String(unreachable)}`);
		}
	}
}

function logProblem(
	ctx: ScanContext,
	group: RedactedErrorGroup,
	existing: RecurringErrorSignature | null,
	reach: string,
	sourceLabel: string,
): ProblemToFile {
	const detectedAt = (existing?.detectedAt ?? ctx.scannedAt).toISOString();
	const evidence = renderLogEvidence(group, ctx.windowHours, detectedAt);
	return {
		source: "LOG",
		fingerprint: group.fingerprint,
		existing,
		observation: {
			title: group.title,
			occurrenceCount: group.occurrences,
			affectedUsers: group.affectedUsers,
			components: group.components,
			firstSeenAt: new Date(group.firstSeen),
			lastSeenAt: new Date(group.lastSeen),
			sampleExcerpts: group.excerpts,
		},
		evidence,
		reasoning: logReasoning(group, ctx.windowHours),
		sourceContext: "application_logs",
		subject: { source: "logs", group, windowHours: ctx.windowHours },
		fallback: fallbackLogDraft(group, evidence),
		recurringError: {
			source: "LOG",
			fingerprint: group.fingerprint,
			sourceLabel,
			reach,
			occurrences: group.occurrences,
			windowHours: ctx.windowHours,
			threshold: ctx.threshold,
			similarityThreshold: ctx.similarityThreshold,
			affectedUsers: group.affectedUsers,
			components: group.components,
			exceptionType: group.exceptionType ?? null,
			firstSeen: group.firstSeen,
			lastSeen: group.lastSeen,
			detectedAt,
			excerpts: group.excerpts,
		},
		title: group.title,
		hasNewEvidence:
			!existing || new Date(group.lastSeen) > existing.lastSeenAt,
		previously: existing
			? `The previous scan recorded ${existing.occurrenceCount} occurrences, last seen ${existing.lastSeenAt.toISOString()}.`
			: undefined,
	};
}

async function scanLogs(
	ctx: ScanContext,
	tally: Record<Outcome, number>,
): Promise<{ configured: boolean; groups: number }> {
	let source: Awaited<ReturnType<typeof resolveRecurringErrorSource>>;
	let groups: ReturnType<typeof mergeErrorGroups>;
	try {
		source = await resolveRecurringErrorSource(ctx);
		if (!source) {
			return { configured: false, groups: 0 };
		}
		groups = mergeErrorGroups(
			await source.summarize({
				lookbackMinutes: ctx.windowHours * 60,
				minOccurrences: ctx.threshold,
				maxGroups: MAX_GROUPS_PER_SCAN,
			}),
		)
			// Merging can only raise a count, but the platform filter is not
			// trusted to have applied the threshold: below it, nothing happens.
			.filter((group) => group.occurrences >= ctx.threshold)
			.slice(0, MAX_GROUPS_PER_SCAN);
	} catch (err) {
		recordFailure(ctx, "log-source", err);
		return { configured: true, groups: 0 };
	}

	const existing = new Map(
		(
			await findRecurringErrorSignatures(
				ctx.projectId,
				"LOG",
				groups.map((group) => group.fingerprint),
			)
		).map((signature) => [signature.fingerprint, signature]),
	);
	const matcher = createOpenBugMatcher(ctx);
	for (const raw of groups) {
		heartbeat(`recurring-errors: log group ${raw.fingerprint}`);
		const group = redactErrorGroup(raw);
		try {
			const outcome = await settleProblem(ctx, {
				...logProblem(
					ctx,
					group,
					existing.get(group.fingerprint) ?? null,
					source.reach,
					source.label,
				),
				findOpenBug: () => matcher.check(group),
				onFiled: (proposalId, title) =>
					matcher.remember(group, proposalId, title),
			});
			tally[outcome]++;
		} catch (err) {
			recordFailure(ctx, "proposal", err, {
				source: "LOG",
				fingerprint: group.fingerprint,
			});
		}
	}
	return { configured: true, groups: groups.length };
}

async function scanIncidents(
	ctx: ScanContext,
	tally: Record<Outcome, number>,
): Promise<number> {
	let clusters: Awaited<ReturnType<typeof findOpenBugClusters>>;
	let signatures: RecurringErrorSignature[];
	try {
		signatures = await listRecurringErrorSignatures(
			ctx.projectId,
			"INCIDENT",
		);
		clusters = await findOpenBugClusters({
			projectId: ctx.projectId,
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			minSize: ctx.threshold,
			minConfidence: ctx.similarityThreshold,
			// A consolidated bug this scan filed is itself an open bug; leaving
			// it in would make it a member of the cluster it consolidates.
			excludeStoryIds: new Set(
				signatures.flatMap((signature) =>
					signature.storyId ? [signature.storyId] : [],
				),
			),
		});
	} catch (err) {
		recordFailure(ctx, "incidents", err);
		return 0;
	}

	for (const stories of clusters) {
		const members = stories.map((story) => story.id);
		const existing = matchClusterToSignature(members, signatures);
		const cluster: IncidentCluster = {
			fingerprint: existing?.fingerprint ?? fingerprintCluster(members),
			stories,
		};
		heartbeat(`recurring-errors: incident cluster ${cluster.fingerprint}`);
		const detectedAt = (
			existing?.detectedAt ?? ctx.scannedAt
		).toISOString();
		const evidence = renderIncidentEvidence(cluster, detectedAt);
		const previousMembers = new Set(existing?.sourceStoryIds ?? []);
		try {
			const outcome = await settleProblem(ctx, {
				source: "INCIDENT",
				fingerprint: cluster.fingerprint,
				existing,
				observation: {
					title: stories[0]?.title ?? "Related bug reports",
					occurrenceCount: stories.length,
					affectedUsers: 0,
					components: [],
					firstSeenAt: existing?.firstSeenAt ?? ctx.scannedAt,
					lastSeenAt: ctx.scannedAt,
					sampleExcerpts: stories.map(
						(story) => `${story.identifier}: ${story.title}`,
					),
					sourceStoryIds: members,
				},
				evidence,
				reasoning: incidentReasoning(cluster),
				sourceContext: "bug_reports",
				subject: { source: "incidents", cluster },
				fallback: fallbackIncidentDraft(cluster, evidence),
				recurringError: {
					source: "INCIDENT",
					fingerprint: cluster.fingerprint,
					threshold: ctx.threshold,
					similarityThreshold: ctx.similarityThreshold,
					detectedAt,
					stories: stories.map((story) => ({
						id: story.id,
						identifier: story.identifier,
						title: story.title,
					})),
				},
				title: stories[0]?.title ?? "Related bug reports",
				hasNewEvidence: members.some((id) => !previousMembers.has(id)),
			});
			tally[outcome]++;
		} catch (err) {
			recordFailure(ctx, "proposal", err, {
				source: "INCIDENT",
				fingerprint: cluster.fingerprint,
			});
		}
	}
	return clusters.length;
}

async function scan(
	input: ScanRecurringErrorsInput,
): Promise<ScanRecurringErrorsResult> {
	const tally: Record<Outcome, number> = {
		filed: 0,
		refreshed: 0,
		grouped: 0,
		notedOnStory: 0,
		suppressed: 0,
	};
	// Re-read at use time: the sweep listed this project minutes ago, and an
	// admin who has since switched the scan off must not get one more run.
	if (!(await isRecurringErrorScanEnabled(input.projectId))) {
		return {
			status: "disabled",
			logSourceConfigured: false,
			groupsAboveThreshold: 0,
			clusters: 0,
			failures: 0,
			...tally,
		};
	}

	const ctx: ScanContext = {
		...input,
		similarityThreshold: input.similarityThreshold ?? CONFIDENCE_THRESHOLD,
		scannedAt: new Date(),
		errors: [],
		storyNotes: new Map(),
	};
	const logs = await scanLogs(ctx, tally);
	const clusters = await scanIncidents(ctx, tally);
	await postStoryNotes(ctx);
	await recordRecurringErrorScanOutcome(input.projectId, {
		at: ctx.scannedAt,
		error: ctx.errors.length > 0 ? ctx.errors.join("; ") : null,
	});

	logger.info("[RecurringErrors] project scanned", {
		projectId: input.projectId,
		logSourceConfigured: logs.configured,
		groups: logs.groups,
		clusters,
		failures: ctx.errors.length,
		...tally,
	});
	return {
		status: ctx.errors.length > 0 ? "completed-with-errors" : "completed",
		logSourceConfigured: logs.configured,
		groupsAboveThreshold: logs.groups,
		clusters,
		failures: ctx.errors.length,
		...tally,
	};
}

/**
 * Temporal activity. Every model call it makes is this scan's, so usage is
 * attributed to the job rather than to the project owner it runs as.
 */
export async function scanRecurringErrorsForProject(
	input: ScanRecurringErrorsInput,
): Promise<ScanRecurringErrorsResult> {
	return runWithAiJobType("recurring-error-scan", () => scan(input));
}
