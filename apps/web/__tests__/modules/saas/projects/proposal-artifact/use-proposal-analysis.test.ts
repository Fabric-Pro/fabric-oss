/**
 * `useProposalAnalysis` and its pure helpers (Fizzy #2801): the Internal
 * Analysis is polled every five seconds while its run is queued or in
 * progress, and never otherwise; a refusal is final — no polling and no
 * retries; and the tab indicator the page shows is derived from the same
 * answer.
 *
 * `@tanstack/react-query` is real and its retry policy is left at the
 * client default, so the hook's own `retry` is what decides.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getAnalysis: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getAnalysis: (input: unknown) => api.getAnalysis(input),
			},
		},
	},
}));

import {
	analysisTabIndicator,
	isProposalAnalysisDenied,
	PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS,
	PROPOSAL_ANALYSIS_POLL_MS,
	proposalAnalysisPollInterval,
	proposalAnalysisQueryKey,
	useProposalAnalysis,
} from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import {
	analysisRun,
	DOCUMENT_ID,
	finding,
	orpcError,
	PROJECT_ID,
} from "./proposal-artifact-fixtures";

describe("proposalAnalysisPollInterval", () => {
	it("polls every five seconds while the run is queued or running", () => {
		expect(
			proposalAnalysisPollInterval(analysisRun({ status: "PENDING" })),
		).toBe(PROPOSAL_ANALYSIS_POLL_MS);
		expect(
			proposalAnalysisPollInterval(analysisRun({ status: "RUNNING" })),
		).toBe(5_000);
	});

	it("stops once the run is complete or failed", () => {
		expect(
			proposalAnalysisPollInterval(analysisRun({ status: "COMPLETE" })),
		).toBe(false);
		expect(
			proposalAnalysisPollInterval(
				analysisRun({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			),
		).toBe(false);
	});

	it("stops for a run the server reports as timed out", () => {
		expect(
			proposalAnalysisPollInterval(
				analysisRun({ status: "RUNNING", timedOut: true }),
			),
		).toBe(false);
	});

	it("does not poll before the first run or before the first answer", () => {
		expect(proposalAnalysisPollInterval(null)).toBe(false);
		expect(proposalAnalysisPollInterval(undefined)).toBe(false);
	});

	it("stops on a refusal even when the last good answer was running", () => {
		const running = analysisRun({ status: "RUNNING" });
		expect(
			proposalAnalysisPollInterval(running, orpcError("FORBIDDEN")),
		).toBe(false);
		expect(
			proposalAnalysisPollInterval(running, orpcError("NOT_FOUND")),
		).toBe(false);
		// A transient fault is not a refusal: the run is still in progress.
		expect(
			proposalAnalysisPollInterval(
				running,
				orpcError("INTERNAL_SERVER_ERROR"),
			),
		).toBe(5_000);
	});
});

describe("proposalAnalysisPollInterval — after a generation ends", () => {
	const NOW = Date.parse("2026-10-08T12:00:00.000Z");
	const ended = (minutesAgo: number) => ({
		generationStartedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
		generationRunning: false,
		now: NOW,
	});

	it("keeps asking until the latest generation's run appears", () => {
		expect(proposalAnalysisPollInterval(null, null, ended(2))).toBe(
			PROPOSAL_ANALYSIS_POLL_MS,
		);
		// Only an earlier Main's run so far.
		expect(
			proposalAnalysisPollInterval(
				analysisRun({ status: "COMPLETE", isStale: true }),
				null,
				ended(2),
			),
		).toBe(PROPOSAL_ANALYSIS_POLL_MS);
	});

	it("stops once the latest Main's run is finished", () => {
		expect(
			proposalAnalysisPollInterval(
				analysisRun({ status: "COMPLETE", isStale: false }),
				null,
				ended(2),
			),
		).toBe(false);
	});

	it("does not ask while the generation is still running", () => {
		expect(
			proposalAnalysisPollInterval(null, null, {
				...ended(2),
				generationRunning: true,
			}),
		).toBe(false);
	});

	it("gives up once the window after the generation's start has passed", () => {
		const minutes = PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS / 60_000 + 1;
		expect(proposalAnalysisPollInterval(null, null, ended(minutes))).toBe(
			false,
		);
	});

	it("does not ask for a document that never generated, or after a refusal", () => {
		expect(
			proposalAnalysisPollInterval(null, null, {
				generationStartedAt: null,
				generationRunning: false,
				now: NOW,
			}),
		).toBe(false);
		expect(
			proposalAnalysisPollInterval(
				null,
				orpcError("FORBIDDEN"),
				ended(2),
			),
		).toBe(false);
	});
});

describe("isProposalAnalysisDenied", () => {
	it("treats FORBIDDEN, NOT_FOUND and UNAUTHORIZED as final", () => {
		expect(isProposalAnalysisDenied(orpcError("FORBIDDEN"))).toBe(true);
		expect(isProposalAnalysisDenied(orpcError("NOT_FOUND"))).toBe(true);
		expect(isProposalAnalysisDenied(orpcError("UNAUTHORIZED"))).toBe(true);
	});

	it("does not treat a fault or a plain error as a refusal", () => {
		expect(
			isProposalAnalysisDenied(orpcError("INTERNAL_SERVER_ERROR")),
		).toBe(false);
		expect(isProposalAnalysisDenied(new Error("network"))).toBe(false);
		expect(isProposalAnalysisDenied(null)).toBe(false);
	});
});

describe("analysisTabIndicator", () => {
	it("shows nothing before the first run or the first answer", () => {
		expect(analysisTabIndicator(undefined)).toEqual({
			kind: "none",
			blockingCount: 0,
		});
		expect(analysisTabIndicator(null)).toEqual({
			kind: "none",
			blockingCount: 0,
		});
	});

	it("follows a queued and a running run", () => {
		expect(
			analysisTabIndicator(analysisRun({ status: "PENDING" })).kind,
		).toBe("pending");
		expect(
			analysisTabIndicator(analysisRun({ status: "RUNNING" })).kind,
		).toBe("running");
	});

	it("counts only Blocking findings of a complete run", () => {
		expect(
			analysisTabIndicator(
				analysisRun({
					findings: [
						finding({ severity: "BLOCKING" }),
						finding({ severity: "IMPORTANT" }),
						finding({ severity: "BLOCKING" }),
						finding({ severity: "INFORMATIONAL" }),
					],
				}),
			),
		).toEqual({ kind: "complete", blockingCount: 2 });
		expect(analysisTabIndicator(analysisRun({ findings: [] }))).toEqual({
			kind: "complete",
			blockingCount: 0,
		});
	});

	it("marks a failed and a timed-out run as failed", () => {
		expect(
			analysisTabIndicator(
				analysisRun({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			),
		).toEqual({ kind: "failed", blockingCount: 0 });
		expect(
			analysisTabIndicator(
				analysisRun({ status: "PENDING", timedOut: true }),
			).kind,
		).toBe("failed");
	});
});

describe("proposalAnalysisQueryKey", () => {
	it("is scoped to the project and the document", () => {
		expect(proposalAnalysisQueryKey(PROJECT_ID, DOCUMENT_ID)).toEqual([
			"projects",
			"proposalArtifact",
			"analysis",
			PROJECT_ID,
			DOCUMENT_ID,
		]);
	});
});

describe("useProposalAnalysis", () => {
	let client: QueryClient;

	function wrapper({ children }: { children: ReactNode }) {
		return createElement(QueryClientProvider, { client }, children);
	}

	function renderAnalysis(
		enabled = true,
		generation?: {
			generationStartedAt: string;
			generationRunning: boolean;
		},
	) {
		return renderHook(
			() =>
				useProposalAnalysis({
					projectId: PROJECT_ID,
					documentId: DOCUMENT_ID,
					enabled,
					...generation,
				}),
			{ wrapper },
		);
	}

	/**
	 * Let timers and the promise queue run, inside act. A poll fires at the
	 * very end of a five-second window, so a few short trailing steps let
	 * its answer settle and reach the hook before anything is asserted.
	 */
	async function advance(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
			for (let step = 0; step < 5; step++) {
				await vi.advanceTimersByTimeAsync(10);
			}
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		client = new QueryClient();
		api.getAnalysis.mockReset();
	});

	afterEach(() => {
		client.clear();
		vi.useRealTimers();
	});

	it("never asks when disabled — a project guest's page fires no request", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun());
		const { result } = renderAnalysis(false);
		await advance(30_000);

		expect(api.getAnalysis).not.toHaveBeenCalled();
		expect(result.current.data).toBeUndefined();
	});

	it("asks for the document's analysis", async () => {
		api.getAnalysis.mockResolvedValue(null);
		const { result } = renderAnalysis();
		await advance(0);

		expect(api.getAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(result.current.data).toBeNull();
	});

	it("polls while running and stops at COMPLETE", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(analysisRun({ status: "PENDING" }))
			.mockResolvedValueOnce(analysisRun({ status: "RUNNING" }))
			.mockResolvedValue(analysisRun({ status: "COMPLETE" }));
		const { result } = renderAnalysis();

		await advance(0);
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
		expect(result.current.data?.status).toBe("PENDING");

		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);
		expect(result.current.data?.status).toBe("RUNNING");

		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(api.getAnalysis).toHaveBeenCalledTimes(3);
		expect(result.current.data?.status).toBe("COMPLETE");

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(3);
	});

	it("stops polling at FAILED", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(analysisRun({ status: "RUNNING" }))
			.mockResolvedValue(
				analysisRun({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			);
		const { result } = renderAnalysis();

		await advance(0);
		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(result.current.data?.status).toBe("FAILED");
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);
	});

	it("finds a run recorded after the generation ended, with no nudge", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(analysisRun({ status: "PENDING" }))
			.mockResolvedValue(analysisRun({ status: "COMPLETE" }));
		const { result } = renderAnalysis(true, {
			generationStartedAt: new Date(Date.now() - 60_000).toISOString(),
			generationRunning: false,
		});

		await advance(0);
		expect(result.current.data).toBeNull();

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 3);
		expect(result.current.data?.status).toBe("COMPLETE");
		expect(api.getAnalysis).toHaveBeenCalledTimes(4);

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(4);
	});

	it("does not poll a complete run at all", async () => {
		api.getAnalysis.mockResolvedValue(analysisRun({ status: "COMPLETE" }));
		renderAnalysis();

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
	});

	it("treats FORBIDDEN as final: one request, no retries, no polling", async () => {
		api.getAnalysis.mockRejectedValue(orpcError("FORBIDDEN"));
		const { result } = renderAnalysis();

		await advance(60_000);
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
		expect(result.current.isError).toBe(true);
		expect(isProposalAnalysisDenied(result.current.error)).toBe(true);
	});

	it("treats NOT_FOUND as final too", async () => {
		api.getAnalysis.mockRejectedValue(orpcError("NOT_FOUND"));
		renderAnalysis();

		await advance(60_000);
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
	});

	it("retries a fault a bounded number of times", async () => {
		api.getAnalysis.mockRejectedValue(orpcError("INTERNAL_SERVER_ERROR"));
		const { result } = renderAnalysis();

		await advance(60_000);
		// The first attempt and two retries.
		expect(api.getAnalysis).toHaveBeenCalledTimes(3);
		expect(result.current.isError).toBe(true);
	});
});
