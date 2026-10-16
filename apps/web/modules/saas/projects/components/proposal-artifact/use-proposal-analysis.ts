"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";

/**
 * What `projects.proposalArtifact.getAnalysis` returns: the run the tab
 * shows (null before any run completed), whether it is stale, the status of
 * any newer run, the shown run's findings and the answers to findings it no
 * longer raises.
 */
export type ProposalAnalysis = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.getAnalysis>
>;
export type ProposalAnalysisFinding = ProposalAnalysis["findings"][number];
export type ProposalAnalysisFindingState = ProposalAnalysisFinding["state"];
export type ProposalAnalysisResponse = NonNullable<
	ProposalAnalysisFinding["response"]
>;
export type ProposalAnalysisEvidence =
	ProposalAnalysisFinding["evidence"][number];
export type ProposalNoLongerRaised = ProposalAnalysis["noLongerRaised"][number];
export type ProposalNewerRun = NonNullable<ProposalAnalysis["newerRun"]>;

type RespondInput = Parameters<
	typeof orpcClient.projects.proposalArtifact.respondToFinding
>[0];
type ClearInput = Parameters<
	typeof orpcClient.projects.proposalArtifact.clearFindingResponse
>[0];
type RespondToFindingResult = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.respondToFinding>
>;
/** An answer as saved, as a stale write reports the one saved meanwhile. */
export type ProposalSavedAnswer = NonNullable<
	Extract<RespondToFindingResult, { outcome: "stale" }>["current"]
>;

/**
 * The refusal code a re-run answers when no analysis prompt is bound.
 * Mirrors the temporal package's constant, which the browser must not
 * import.
 */
export const PROPOSAL_PROMPT_NOT_BOUND_CODE = "PROPOSAL_PROMPT_NOT_BOUND";

/** Cadence while a run is queued or in progress. */
export const PROPOSAL_ANALYSIS_POLL_MS = 5_000;

/**
 * A refusal, not a fault: the gate is off, the document is gone, or the
 * caller is not a member of the owning organization. Asking again cannot
 * change the answer.
 */
const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

export function isProposalAnalysisDenied(error: unknown): boolean {
	return DENIED_CODES.has(getOrpcCode(error) ?? "");
}

/**
 * The machine-readable fields a procedure puts in an error's `data`: a
 * refusal's own code (`ANALYSIS_IN_PROGRESS`, `FINDING_NOT_KEYED`, …) and a
 * rate limit's `retryAfter` seconds. Read defensively; never the message.
 */
export function getOrpcErrorData(error: unknown): {
	code?: string;
	retryAfter?: number;
} {
	if (typeof error !== "object" || error === null || !("data" in error)) {
		return {};
	}
	const data = (error as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) {
		return {};
	}
	const { code, retryAfter } = data as {
		code?: unknown;
		retryAfter?: unknown;
	};
	return {
		code: typeof code === "string" ? code : undefined,
		retryAfter:
			typeof retryAfter === "number" && Number.isFinite(retryAfter)
				? retryAfter
				: undefined,
	};
}

export function proposalAnalysisQueryKey(
	projectId: string,
	documentId: string,
) {
	return [
		"projects",
		"proposalArtifact",
		"analysis",
		projectId,
		documentId,
	] as const;
}

/** A newer run is queued or running and still updating. */
export function isNewerRunInProgress(
	data: ProposalAnalysis | undefined,
): boolean {
	const newer = data?.newerRun;
	return (
		!!newer &&
		!newer.timedOut &&
		(newer.status === "PENDING" || newer.status === "RUNNING")
	);
}

/** A newer run failed, or stopped updating, without completing. */
export function isNewerRunFailed(data: ProposalAnalysis | undefined): boolean {
	const newer = data?.newerRun;
	return !!newer && (newer.status === "FAILED" || newer.timedOut);
}

/**
 * How long after a generation starts the page keeps looking for its
 * analysis. The run is recorded only after the generation's save, version
 * and embedding, so it appears some time after the page sees the
 * generation end; past this window a missing or stale analysis is taken as
 * the answer.
 */
export const PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS = 30 * 60_000;

/** What the page knows about the document's latest generation. */
export type ProposalAnalysisExpectation = {
	/** `ProjectDocument.generationStartedAt`; absent when it never ran. */
	generationStartedAt?: string | Date | null;
	/** A generation is queued or writing right now. */
	generationRunning: boolean;
	now?: number;
};

/**
 * A generation ended recently and its analysis is not here yet: nothing at
 * all, or only a run of an earlier Main (`isStale`), and no run recorded
 * since the generation started. A newer run recorded since then is that
 * generation's: while it is queued or running the regular poll follows it,
 * and once it failed the failure is the answer. Until it is recorded the
 * page cannot rely on a nudge to learn about it, since realtime delivery is
 * best-effort, so it asks.
 */
export function awaitingAnalysisOfLatestGeneration(
	data: ProposalAnalysis | undefined,
	expectation: ProposalAnalysisExpectation | undefined,
): boolean {
	if (!expectation || expectation.generationRunning) {
		return false;
	}
	const startedAt = expectation.generationStartedAt
		? new Date(expectation.generationStartedAt).getTime()
		: Number.NaN;
	if (Number.isNaN(startedAt)) {
		return false;
	}
	const now = expectation.now ?? Date.now();
	if (now - startedAt > PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS) {
		return false;
	}
	if (!data) {
		return true;
	}
	const newer = data.newerRun;
	if (newer && new Date(newer.createdAt).getTime() >= startedAt) {
		return false;
	}
	return data.run === null || data.isStale;
}

/**
 * How long to wait before asking about the analysis again, or `false` to
 * stop. A newer run that is queued or running changes on its own. So does a
 * run that has not appeared yet for a generation that just ended, within a
 * bounded window. A shown run changes only when a newer run completes, and
 * a newer run that failed or stopped updating will not change by being
 * asked again.
 */
export function proposalAnalysisPollInterval(
	data: ProposalAnalysis | undefined,
	error: unknown = null,
	expectation?: ProposalAnalysisExpectation,
): number | false {
	if (error && isProposalAnalysisDenied(error)) {
		return false;
	}
	if (isNewerRunInProgress(data)) {
		return PROPOSAL_ANALYSIS_POLL_MS;
	}
	return awaitingAnalysisOfLatestGeneration(data, expectation)
		? PROPOSAL_ANALYSIS_POLL_MS
		: false;
}

/**
 * The Internal Analysis of a Proposal (Fizzy #2801, Fizzy #2946), polled
 * while a newer run is queued or in progress. Organization members only: the
 * page passes `enabled: false` for a project guest, so no request is ever
 * made for one.
 *
 * A refusal ends both polling and retries: the last good answer may still
 * say a run is in progress, but a server that stopped answering for this
 * caller will not start again by being asked every few seconds.
 */
export function useProposalAnalysis({
	projectId,
	documentId,
	enabled,
	generationStartedAt,
	generationRunning = false,
}: {
	projectId: string;
	documentId: string;
	enabled: boolean;
	/** The document's latest generation start, to wait for its analysis. */
	generationStartedAt?: string | Date | null;
	generationRunning?: boolean;
}) {
	return useQuery({
		queryKey: proposalAnalysisQueryKey(projectId, documentId),
		queryFn: () =>
			orpcClient.projects.proposalArtifact.getAnalysis({
				projectId,
				documentId,
			}),
		enabled,
		refetchInterval: (query) =>
			proposalAnalysisPollInterval(
				query.state.data,
				query.state.status === "error" ? query.state.error : null,
				{ generationStartedAt, generationRunning },
			),
		retry: (failureCount, error) =>
			!isProposalAnalysisDenied(error) && failureCount < 2,
	});
}

/**
 * A finding still waits for a member's decision: nobody answered it, or its
 * answer needs review.
 */
export function findingNeedsDecision(finding: {
	state: ProposalAnalysisFindingState;
}): boolean {
	return finding.state === "UNADDRESSED" || finding.state === "NEEDS_REVIEW";
}

type AnalysisTabIndicator = {
	kind: "none" | "pending" | "running" | "complete" | "failed";
	/** Blocking findings of the shown run still waiting for a decision. */
	blockingCount: number;
};

/**
 * What the Internal Analysis tab trigger shows beside its label: nothing
 * before any run, a spinner while a newer run is queued or running, an
 * error mark when it failed or stopped responding, and otherwise how many
 * Blocking findings of the shown run still wait for a decision — an
 * answered one no longer counts, one whose answer needs review does.
 */
export function analysisTabIndicator(
	data: ProposalAnalysis | undefined,
): AnalysisTabIndicator {
	if (!data) {
		return { kind: "none", blockingCount: 0 };
	}
	if (isNewerRunFailed(data)) {
		return { kind: "failed", blockingCount: 0 };
	}
	if (isNewerRunInProgress(data)) {
		return {
			kind: data.newerRun?.status === "PENDING" ? "pending" : "running",
			blockingCount: 0,
		};
	}
	if (!data.run) {
		return { kind: "none", blockingCount: 0 };
	}
	return {
		kind: "complete",
		blockingCount: data.findings.filter(
			(finding) =>
				finding.severity === "BLOCKING" &&
				findingNeedsDecision(finding),
		).length,
	};
}

/** What a member asks for when confirming or answering a finding. */
export type RespondToFindingRequest = Omit<
	RespondInput,
	"projectId" | "documentId"
> & {
	/** The finding's stable key, to update it in place while the write runs. */
	stableKey: string;
};

/**
 * What a member asks for when clearing an answer: its stable key and the
 * answer they saw, by id and version.
 */
type ClearFindingResponseRequest = Omit<ClearInput, "projectId" | "documentId">;

/** The finding with this key as the write is expected to leave it. */
function withOptimisticAnswer(
	data: ProposalAnalysis,
	request: RespondToFindingRequest,
): ProposalAnalysis {
	return {
		...data,
		findings: data.findings.map((finding) =>
			finding.stableKey === request.stableKey
				? {
						...finding,
						state: request.kind,
						reason: null,
						response: {
							// The answer's id and version, like its author, come
							// from the server once the write lands. Nothing acts on
							// these meanwhile: every control of a key being saved
							// is disabled.
							id: finding.response?.id ?? "",
							kind: request.kind,
							text: request.text?.trim() || null,
							version: finding.response?.version ?? 0,
							// The panel shows the key as saving meanwhile.
							author: null,
							updatedAt: new Date(),
							settledSkipReason: null,
							versionUnknown: false,
						},
					}
				: finding,
		),
	};
}

/** The finding with this key carrying the answer the server saved. */
function withSavedAnswer(
	data: ProposalAnalysis,
	stableKey: string,
	saved: ProposalSavedAnswer,
): ProposalAnalysis {
	return {
		...data,
		findings: data.findings.map((finding) =>
			finding.stableKey === stableKey && finding.response
				? {
						...finding,
						response: { ...finding.response, ...saved },
					}
				: finding,
		),
	};
}

/** The analysis as it reads once the answer for this key is cleared. */
function withoutAnswer(
	data: ProposalAnalysis,
	stableKey: string,
): ProposalAnalysis {
	return {
		...data,
		findings: data.findings.map((finding) =>
			finding.stableKey === stableKey
				? {
						...finding,
						state: "UNADDRESSED",
						reason: null,
						response: null,
					}
				: finding,
		),
		noLongerRaised: data.noLongerRaised.filter(
			(answer) => answer.stableKey !== stableKey,
		),
	};
}

/**
 * The analysis with the answer for this key put back as it was before a
 * write, leaving every other key as it reads now. The finding is matched by
 * key, not id, since a newer run may raise the same key under another id;
 * an answer no longer raised returns to where it was listed.
 */
function withAnswerRestored(
	data: ProposalAnalysis,
	stableKey: string,
	before: {
		finding: ProposalAnalysisFinding | undefined;
		noLongerRaised: ProposalNoLongerRaised | undefined;
		noLongerRaisedIndex: number;
	},
): ProposalAnalysis {
	const prior = before.finding;
	const findings = prior
		? data.findings.map((finding) =>
				finding.stableKey === stableKey
					? {
							...finding,
							state: prior.state,
							reason: prior.reason,
							response: prior.response,
						}
					: finding,
			)
		: data.findings;
	let noLongerRaised = data.noLongerRaised;
	const restored = before.noLongerRaised;
	if (restored) {
		noLongerRaised = data.noLongerRaised.some(
			(answer) => answer.stableKey === stableKey,
		)
			? data.noLongerRaised.map((answer) =>
					answer.stableKey === stableKey ? restored : answer,
				)
			: [
					...data.noLongerRaised.slice(0, before.noLongerRaisedIndex),
					restored,
					...data.noLongerRaised.slice(before.noLongerRaisedIndex),
				];
	}
	return { ...data, findings, noLongerRaised };
}

/**
 * Apply an optimistic change to one key's answer in the cached analysis and
 * return its undo. Any read in flight is cancelled first, so a poll landing
 * mid-write cannot overwrite the optimistic state with the answer from
 * before it.
 *
 * The undo puts back only this key's answer, into the analysis as it reads
 * when the undo runs: a write to another key, still in flight or already
 * saved, keeps its own state when this one is refused.
 */
async function applyOptimistic(
	queryClient: QueryClient,
	queryKey: ReturnType<typeof proposalAnalysisQueryKey>,
	stableKey: string,
	change: (data: ProposalAnalysis) => ProposalAnalysis,
): Promise<() => void> {
	await queryClient.cancelQueries({ queryKey });
	const previous = queryClient.getQueryData<ProposalAnalysis>(queryKey);
	if (!previous) {
		return () => {};
	}
	const noLongerRaisedIndex = previous.noLongerRaised.findIndex(
		(answer) => answer.stableKey === stableKey,
	);
	const before = {
		finding: previous.findings.find(
			(finding) => finding.stableKey === stableKey,
		),
		noLongerRaised:
			noLongerRaisedIndex === -1
				? undefined
				: previous.noLongerRaised[noLongerRaisedIndex],
		noLongerRaisedIndex,
	};
	queryClient.setQueryData<ProposalAnalysis>(queryKey, change(previous));
	return () => {
		queryClient.setQueryData<ProposalAnalysis>(queryKey, (current) =>
			current ? withAnswerRestored(current, stableKey, before) : current,
		);
	};
}

/**
 * Confirm, answer and clear a finding's answer, and re-run the analysis
 * (Fizzy #2946). Confirm, answer and clear show their result at once and
 * undo it when the server refuses or reports a stale write — a stale write
 * is a successful call with `outcome: "stale"`, not an error. Every outcome
 * refetches the analysis, since each answer's derived state, and why the
 * settled-decisions feed skips it, come only from the server.
 *
 * `pendingKeys` names the stable keys whose write is still in flight, so
 * the panel can say "saving" instead of inventing an author.
 */
export function useProposalAnalysisActions({
	projectId,
	documentId,
}: {
	projectId: string;
	documentId: string;
}) {
	const queryClient = useQueryClient();
	const queryKey = proposalAnalysisQueryKey(projectId, documentId);
	const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	const markPending = useCallback((stableKey: string, pending: boolean) => {
		setPendingKeys((current) => {
			const next = new Set(current);
			if (pending) {
				next.add(stableKey);
			} else {
				next.delete(stableKey);
			}
			return next;
		});
	}, []);

	// Not awaited: the write's own outcome is final once it answers, and the
	// refetch only brings the states derived from it.
	const refetch = () => {
		void queryClient.invalidateQueries({ queryKey });
	};

	const respond = useMutation({
		mutationFn: ({
			stableKey: _stableKey,
			...request
		}: RespondToFindingRequest) =>
			orpcClient.projects.proposalArtifact.respondToFinding({
				projectId,
				documentId,
				...request,
			}),
		onMutate: async (request) => {
			markPending(request.stableKey, true);
			const undo = await applyOptimistic(
				queryClient,
				queryKey,
				request.stableKey,
				(data) => withOptimisticAnswer(data, request),
			);
			return { undo };
		},
		onSuccess: (result, request, context) => {
			if (result.outcome === "stale") {
				context?.undo();
				return;
			}
			// The saved answer, with its author and version, until the
			// refetch brings its derived state.
			queryClient.setQueryData<ProposalAnalysis>(queryKey, (data) =>
				data
					? withSavedAnswer(data, request.stableKey, result.response)
					: data,
			);
		},
		onError: (_error, _request, context) => {
			context?.undo();
		},
		onSettled: (_result, _error, request) => {
			markPending(request.stableKey, false);
			refetch();
		},
	});

	const clear = useMutation({
		mutationFn: (request: ClearFindingResponseRequest) =>
			orpcClient.projects.proposalArtifact.clearFindingResponse({
				projectId,
				documentId,
				...request,
			}),
		onMutate: async (request) => {
			markPending(request.stableKey, true);
			const undo = await applyOptimistic(
				queryClient,
				queryKey,
				request.stableKey,
				(data) => withoutAnswer(data, request.stableKey),
			);
			return { undo };
		},
		onSuccess: (result, _request, context) => {
			if (result.outcome === "stale") {
				context?.undo();
			}
		},
		onError: (_error, _request, context) => {
			context?.undo();
		},
		onSettled: (_result, _error, request) => {
			markPending(request.stableKey, false);
			refetch();
		},
	});

	const rerun = useMutation({
		mutationFn: () =>
			orpcClient.projects.proposalArtifact.rerunAnalysis({
				projectId,
				documentId,
			}),
		// A refusal for a run already in progress, or a generation, also
		// means the analysis changed: show what is running.
		onSettled: () => {
			refetch();
		},
	});

	return { respond, clear, rerun, pendingKeys };
}

export type ProposalAnalysisActions = ReturnType<
	typeof useProposalAnalysisActions
>;
