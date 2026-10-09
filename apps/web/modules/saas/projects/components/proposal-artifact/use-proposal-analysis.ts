"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { getOrpcCode } from "../field-mapping/orpc-error";

/** What `projects.proposalArtifact.getAnalysis` returns: null before the first run. */
type ProposalAnalysisResult = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.getAnalysis>
>;
export type ProposalAnalysis = NonNullable<ProposalAnalysisResult>;
export type ProposalAnalysisFinding = ProposalAnalysis["findings"][number];

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
 * A generation ended recently and its analysis is not here yet: no run at
 * all, or only one for an earlier Main (`isStale`). Until it is recorded
 * the page cannot rely on a nudge to learn about it, since realtime delivery
 * is best-effort, so it asks.
 */
export function awaitingAnalysisOfLatestGeneration(
	data: ProposalAnalysisResult | undefined,
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
	return !data || data.isStale;
}

/**
 * How long to wait before asking about the analysis again, or `false` to
 * stop. A queued or running run changes on its own. So does a run that has
 * not appeared yet for a generation that just ended, within a bounded
 * window. A finished run of the latest Main changes only when a new
 * generation starts another. A run the server reports as timed out has
 * stopped updating, so polling it would only repeat the same answer.
 */
export function proposalAnalysisPollInterval(
	data: ProposalAnalysisResult | undefined,
	error: unknown = null,
	expectation?: ProposalAnalysisExpectation,
): number | false {
	if (error && isProposalAnalysisDenied(error)) {
		return false;
	}
	if (
		data &&
		!data.timedOut &&
		(data.status === "PENDING" || data.status === "RUNNING")
	) {
		return PROPOSAL_ANALYSIS_POLL_MS;
	}
	if (data?.timedOut) {
		return false;
	}
	return awaitingAnalysisOfLatestGeneration(data, expectation)
		? PROPOSAL_ANALYSIS_POLL_MS
		: false;
}

/**
 * The Internal Analysis of a Proposal (Fizzy #2801), polled while its run is
 * queued or in progress. Organization members only: the page passes
 * `enabled: false` for a project guest, so no request is ever made for one.
 *
 * A refusal ends both polling and retries: the last good answer may still
 * say RUNNING, but a server that stopped answering for this caller will not
 * start again by being asked every few seconds.
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

type AnalysisTabIndicator = {
	kind: "none" | "pending" | "running" | "complete" | "failed";
	/** BLOCKING findings of a complete run; 0 otherwise. */
	blockingCount: number;
};

/**
 * What the Internal Analysis tab trigger shows beside its label: nothing
 * before the first run, a spinner while queued or running, the Blocking
 * count once complete, and an error mark when the run failed or stopped
 * responding.
 */
export function analysisTabIndicator(
	data: ProposalAnalysisResult | undefined,
): AnalysisTabIndicator {
	if (!data) {
		return { kind: "none", blockingCount: 0 };
	}
	if (data.status === "FAILED" || data.timedOut) {
		return { kind: "failed", blockingCount: 0 };
	}
	if (data.status === "PENDING") {
		return { kind: "pending", blockingCount: 0 };
	}
	if (data.status === "RUNNING") {
		return { kind: "running", blockingCount: 0 };
	}
	return {
		kind: "complete",
		blockingCount: data.findings.filter(
			(finding) => finding.severity === "BLOCKING",
		).length,
	};
}
