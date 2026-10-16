/**
 * `useProposalAnalysis`, its pure helpers and its actions (Fizzy #2801,
 * Fizzy #2946): the Internal Analysis is polled every five seconds while a
 * newer run is queued or in progress, and never otherwise; a refusal is
 * final — no polling and no retries; the tab indicator the page shows is
 * derived from the same answer; and confirm, answer and clear update the
 * cached analysis at once and undo it on a refusal or a stale write.
 *
 * `@tanstack/react-query` is real and its retry policy is left at the
 * client default, so the hook's own `retry` is what decides.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getAnalysis: vi.fn(),
	respondToFinding: vi.fn(),
	clearFindingResponse: vi.fn(),
	rerunAnalysis: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getAnalysis: (input: unknown) => api.getAnalysis(input),
				respondToFinding: (input: unknown) =>
					api.respondToFinding(input),
				clearFindingResponse: (input: unknown) =>
					api.clearFindingResponse(input),
				rerunAnalysis: (input: unknown) => api.rerunAnalysis(input),
			},
		},
	},
}));

import {
	analysisTabIndicator,
	awaitingAnalysisOfLatestGeneration,
	findingNeedsDecision,
	getOrpcErrorData,
	isProposalAnalysisDenied,
	PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS,
	PROPOSAL_ANALYSIS_POLL_MS,
	type ProposalAnalysis,
	proposalAnalysisPollInterval,
	proposalAnalysisQueryKey,
	useProposalAnalysis,
	useProposalAnalysisActions,
} from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import {
	analysis,
	DOCUMENT_ID,
	finding,
	newerRun,
	noAnalysis,
	noLongerRaised,
	orpcError,
	PROJECT_ID,
	RUN_ID,
	response,
	savedAnswer,
} from "./proposal-artifact-fixtures";

const running = (overrides: Parameters<typeof newerRun>[0] = {}) =>
	analysis({ newerRun: newerRun({ status: "RUNNING", ...overrides }) });

describe("proposalAnalysisPollInterval", () => {
	it("polls every five seconds while a newer run is queued or running", () => {
		expect(
			proposalAnalysisPollInterval(running({ status: "PENDING" })),
		).toBe(PROPOSAL_ANALYSIS_POLL_MS);
		expect(proposalAnalysisPollInterval(running())).toBe(5_000);
		// Also before any run completed.
		expect(
			proposalAnalysisPollInterval(
				analysis({ run: null, newerRun: newerRun() }),
			),
		).toBe(5_000);
	});

	it("stops once no newer run is in progress, or the newer one failed", () => {
		expect(proposalAnalysisPollInterval(analysis())).toBe(false);
		expect(
			proposalAnalysisPollInterval(
				running({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			),
		).toBe(false);
	});

	it("stops for a newer run the server reports as timed out", () => {
		expect(proposalAnalysisPollInterval(running({ timedOut: true }))).toBe(
			false,
		);
	});

	it("does not poll before any run or before the first answer", () => {
		expect(proposalAnalysisPollInterval(noAnalysis())).toBe(false);
		expect(proposalAnalysisPollInterval(undefined)).toBe(false);
	});

	it("stops on a refusal even when the last good answer was running", () => {
		const last = running();
		expect(proposalAnalysisPollInterval(last, orpcError("FORBIDDEN"))).toBe(
			false,
		);
		expect(proposalAnalysisPollInterval(last, orpcError("NOT_FOUND"))).toBe(
			false,
		);
		// A transient fault is not a refusal: the run is still in progress.
		expect(
			proposalAnalysisPollInterval(
				last,
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
		expect(proposalAnalysisPollInterval(noAnalysis(), null, ended(2))).toBe(
			PROPOSAL_ANALYSIS_POLL_MS,
		);
		// Only an earlier Main's run so far.
		expect(
			proposalAnalysisPollInterval(
				analysis({ isStale: true }),
				null,
				ended(2),
			),
		).toBe(PROPOSAL_ANALYSIS_POLL_MS);
		// A newer run that failed before this generation started is not its run.
		expect(
			proposalAnalysisPollInterval(
				analysis({
					isStale: true,
					newerRun: newerRun({
						status: "FAILED",
						createdAt: new Date(NOW - 60 * 60_000),
					}),
				}),
				null,
				ended(2),
			),
		).toBe(PROPOSAL_ANALYSIS_POLL_MS);
	});

	it("stops once the latest Main's run is finished", () => {
		expect(proposalAnalysisPollInterval(analysis(), null, ended(2))).toBe(
			false,
		);
	});

	it("stops once the generation's own run failed", () => {
		expect(
			proposalAnalysisPollInterval(
				analysis({
					isStale: true,
					newerRun: newerRun({
						kind: "GENERATION",
						status: "FAILED",
						errorCode: "MODEL_ERROR",
						createdAt: new Date(NOW - 60_000),
					}),
				}),
				null,
				ended(2),
			),
		).toBe(false);
	});

	it("does not ask while the generation is still running", () => {
		expect(
			proposalAnalysisPollInterval(noAnalysis(), null, {
				...ended(2),
				generationRunning: true,
			}),
		).toBe(false);
	});

	it("gives up once the window after the generation's start has passed", () => {
		const minutes = PROPOSAL_ANALYSIS_AWAIT_WINDOW_MS / 60_000 + 1;
		expect(
			proposalAnalysisPollInterval(noAnalysis(), null, ended(minutes)),
		).toBe(false);
	});

	it("does not ask for a document that never generated, or after a refusal", () => {
		expect(
			proposalAnalysisPollInterval(noAnalysis(), null, {
				generationStartedAt: null,
				generationRunning: false,
				now: NOW,
			}),
		).toBe(false);
		expect(
			proposalAnalysisPollInterval(
				noAnalysis(),
				orpcError("FORBIDDEN"),
				ended(2),
			),
		).toBe(false);
	});
});

describe("awaitingAnalysisOfLatestGeneration", () => {
	const NOW = Date.parse("2026-10-08T12:00:00.000Z");
	const expectation = {
		generationStartedAt: new Date(NOW - 2 * 60_000).toISOString(),
		generationRunning: false,
		now: NOW,
	};

	it("waits with nothing, or only a stale run, and no newer run since the start", () => {
		expect(awaitingAnalysisOfLatestGeneration(undefined, expectation)).toBe(
			true,
		);
		expect(
			awaitingAnalysisOfLatestGeneration(noAnalysis(), expectation),
		).toBe(true);
		expect(
			awaitingAnalysisOfLatestGeneration(
				analysis({ isStale: true }),
				expectation,
			),
		).toBe(true);
	});

	it("is done once a run of this generation is recorded, whatever its state", () => {
		for (const status of ["PENDING", "RUNNING", "FAILED"] as const) {
			expect(
				awaitingAnalysisOfLatestGeneration(
					analysis({
						isStale: true,
						newerRun: newerRun({
							kind: "GENERATION",
							status,
							createdAt: new Date(NOW - 60_000),
						}),
					}),
					expectation,
				),
			).toBe(false);
		}
		expect(
			awaitingAnalysisOfLatestGeneration(analysis(), expectation),
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
	it("shows nothing before any run or the first answer", () => {
		expect(analysisTabIndicator(undefined)).toEqual({
			kind: "none",
			blockingCount: 0,
		});
		expect(analysisTabIndicator(noAnalysis())).toEqual({
			kind: "none",
			blockingCount: 0,
		});
	});

	it("spins while a newer run is queued or running, over the shown run", () => {
		expect(analysisTabIndicator(running({ status: "PENDING" })).kind).toBe(
			"pending",
		);
		expect(analysisTabIndicator(running()).kind).toBe("running");
		expect(
			analysisTabIndicator(analysis({ run: null, newerRun: newerRun() }))
				.kind,
		).toBe("running");
	});

	it("counts the Blocking findings that still need a decision", () => {
		expect(
			analysisTabIndicator(
				analysis({
					findings: [
						finding({ severity: "BLOCKING" }),
						finding({
							severity: "BLOCKING",
							state: "NEEDS_REVIEW",
						}),
						finding({ severity: "BLOCKING", state: "CONFIRMED" }),
						finding({ severity: "BLOCKING", state: "RESPONDED" }),
						finding({ severity: "IMPORTANT" }),
						finding({ severity: "INFORMATIONAL" }),
					],
				}),
			),
		).toEqual({ kind: "complete", blockingCount: 2 });
		expect(analysisTabIndicator(analysis({ findings: [] }))).toEqual({
			kind: "complete",
			blockingCount: 0,
		});
	});

	it("marks a failed and a timed-out newer run as failed", () => {
		expect(
			analysisTabIndicator(
				running({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			),
		).toEqual({ kind: "failed", blockingCount: 0 });
		expect(
			analysisTabIndicator(running({ status: "PENDING", timedOut: true }))
				.kind,
		).toBe("failed");
	});
});

describe("findingNeedsDecision", () => {
	it("holds for unaddressed and needs-review findings only", () => {
		expect(findingNeedsDecision({ state: "UNADDRESSED" })).toBe(true);
		expect(findingNeedsDecision({ state: "NEEDS_REVIEW" })).toBe(true);
		expect(findingNeedsDecision({ state: "CONFIRMED" })).toBe(false);
		expect(findingNeedsDecision({ state: "RESPONDED" })).toBe(false);
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

describe("getOrpcErrorData", () => {
	it("reads a refusal's own code and a rate limit's wait", () => {
		expect(
			getOrpcErrorData(
				orpcError("CONFLICT", "x", { code: "ANALYSIS_IN_PROGRESS" }),
			),
		).toEqual({ code: "ANALYSIS_IN_PROGRESS", retryAfter: undefined });
		expect(
			getOrpcErrorData(
				orpcError("TOO_MANY_REQUESTS", "x", { retryAfter: 90 }),
			),
		).toEqual({ code: undefined, retryAfter: 90 });
	});

	it("reads nothing from a plain error or a malformed payload", () => {
		expect(getOrpcErrorData(new Error("network"))).toEqual({});
		expect(getOrpcErrorData(null)).toEqual({});
		expect(
			getOrpcErrorData(orpcError("CONFLICT", "x", { code: 7 })),
		).toEqual({ code: undefined, retryAfter: undefined });
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
		api.getAnalysis.mockResolvedValue(analysis());
		const { result } = renderAnalysis(false);
		await advance(30_000);

		expect(api.getAnalysis).not.toHaveBeenCalled();
		expect(result.current.data).toBeUndefined();
	});

	it("asks for the document's analysis", async () => {
		api.getAnalysis.mockResolvedValue(noAnalysis());
		const { result } = renderAnalysis();
		await advance(0);

		expect(api.getAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(result.current.data?.run).toBeNull();
	});

	it("polls while a newer run is in progress and stops once it completes", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(running({ status: "PENDING" }))
			.mockResolvedValueOnce(running())
			.mockResolvedValue(analysis({ run: { id: "analysis-2" } }));
		const { result } = renderAnalysis();

		await advance(0);
		expect(api.getAnalysis).toHaveBeenCalledTimes(1);
		expect(result.current.data?.newerRun?.status).toBe("PENDING");

		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);
		expect(result.current.data?.newerRun?.status).toBe("RUNNING");

		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(api.getAnalysis).toHaveBeenCalledTimes(3);
		expect(result.current.data?.run?.id).toBe("analysis-2");
		expect(result.current.data?.newerRun).toBeNull();

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(3);
	});

	it("stops polling once the newer run failed, keeping the shown run", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(running())
			.mockResolvedValue(
				running({ status: "FAILED", errorCode: "MODEL_ERROR" }),
			);
		const { result } = renderAnalysis();

		await advance(0);
		await advance(PROPOSAL_ANALYSIS_POLL_MS);
		expect(result.current.data?.newerRun?.status).toBe("FAILED");
		expect(result.current.data?.run?.id).toBe(RUN_ID);
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(2);
	});

	it("finds a run recorded after the generation ended, with no nudge", async () => {
		api.getAnalysis
			.mockResolvedValueOnce(noAnalysis())
			.mockResolvedValueOnce(noAnalysis())
			.mockResolvedValueOnce(
				analysis({
					run: null,
					newerRun: newerRun({
						kind: "GENERATION",
						status: "PENDING",
						createdAt: new Date(),
					}),
				}),
			)
			.mockResolvedValue(analysis());
		const { result } = renderAnalysis(true, {
			generationStartedAt: new Date(Date.now() - 60_000).toISOString(),
			generationRunning: false,
		});

		await advance(0);
		expect(result.current.data?.run).toBeNull();

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 3);
		expect(result.current.data?.run?.id).toBe(RUN_ID);
		expect(api.getAnalysis).toHaveBeenCalledTimes(4);

		await advance(PROPOSAL_ANALYSIS_POLL_MS * 6);
		expect(api.getAnalysis).toHaveBeenCalledTimes(4);
	});

	it("does not poll a shown run with no newer run at all", async () => {
		api.getAnalysis.mockResolvedValue(analysis());
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

describe("useProposalAnalysisActions", () => {
	let client: QueryClient;
	const key = proposalAnalysisQueryKey(PROJECT_ID, DOCUMENT_ID);

	function wrapper({ children }: { children: ReactNode }) {
		return createElement(QueryClientProvider, { client }, children);
	}

	function renderActions() {
		return renderHook(
			() =>
				useProposalAnalysisActions({
					projectId: PROJECT_ID,
					documentId: DOCUMENT_ID,
				}),
			{ wrapper },
		);
	}

	function cached(): ProposalAnalysis | undefined {
		return client.getQueryData<ProposalAnalysis>(key);
	}

	/** A promise the test settles, to look at the cache mid-write. */
	function deferred<T>() {
		let settle!: (value: T) => void;
		let fail!: (error: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		return { promise, settle, fail };
	}

	const open = finding({ id: "f-open", stableKey: "key-open" });
	const answered = finding({
		id: "f-answered",
		stableKey: "key-answered",
		state: "RESPONDED",
		response: response({ version: 4 }),
	});
	const start = analysis({
		findings: [open, answered],
		noLongerRaised: [noLongerRaised()],
	});

	beforeEach(() => {
		client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(key, start);
		for (const fn of Object.values(api)) {
			fn.mockReset();
		}
		// Every outcome refetches; the server still says what it said.
		api.getAnalysis.mockImplementation(() => new Promise(() => {}));
	});

	afterEach(() => {
		client.clear();
	});

	it("confirms at once, names the key as saving, and sends the run, finding and kind", async () => {
		const write = deferred<unknown>();
		api.respondToFinding.mockReturnValue(write.promise);
		const { result } = renderActions();

		act(() => {
			result.current.respond.mutate({
				runId: RUN_ID,
				findingId: "f-open",
				stableKey: "key-open",
				kind: "CONFIRMED",
			});
		});

		await waitFor(() =>
			expect(cached()?.findings[0]?.state).toBe("CONFIRMED"),
		);
		expect(result.current.pendingKeys.has("key-open")).toBe(true);
		expect(api.respondToFinding).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			runId: RUN_ID,
			findingId: "f-open",
			kind: "CONFIRMED",
		});

		await act(async () => {
			write.settle({
				outcome: "written",
				stableKey: "key-open",
				answeredRunId: RUN_ID,
				response: savedAnswer({
					id: "response-7",
					kind: "CONFIRMED",
					text: null,
				}),
			});
		});
		await waitFor(() =>
			expect(result.current.pendingKeys.has("key-open")).toBe(false),
		);
		expect(cached()?.findings[0]?.state).toBe("CONFIRMED");
		// The next write or clear names the answer the server saved.
		expect(cached()?.findings[0]?.response).toMatchObject({
			id: "response-7",
			version: 1,
		});
	});

	it("undoes an answer the server refuses", async () => {
		api.respondToFinding.mockRejectedValue(orpcError("FORBIDDEN"));
		const { result } = renderActions();

		await act(async () => {
			await result.current.respond
				.mutateAsync({
					runId: RUN_ID,
					findingId: "f-open",
					stableKey: "key-open",
					kind: "RESPONDED",
					text: "Our answer",
				})
				.catch(() => undefined);
		});

		expect(cached()?.findings[0]).toMatchObject({
			state: "UNADDRESSED",
			response: null,
		});
		expect(result.current.pendingKeys.size).toBe(0);
	});

	it("undoes an answer the server reports as stale", async () => {
		api.respondToFinding.mockResolvedValue({
			outcome: "stale",
			reason: "VERSION_CHANGED",
			current: savedAnswer({ version: 5 }),
		});
		const { result } = renderActions();

		await act(async () => {
			await result.current.respond.mutateAsync({
				runId: RUN_ID,
				findingId: "f-answered",
				stableKey: "key-answered",
				kind: "CONFIRMED",
				responseId: "response-1",
				version: 4,
			});
		});

		expect(cached()?.findings[1]).toMatchObject({
			state: "RESPONDED",
			response: { version: 4 },
		});
	});

	it("undoes only the refused key, keeping another key's answer still being saved", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.respondToFinding
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { result } = renderActions();

		act(() => {
			result.current.respond.mutate({
				runId: RUN_ID,
				findingId: "f-open",
				stableKey: "key-open",
				kind: "CONFIRMED",
			});
		});
		await waitFor(() =>
			expect(cached()?.findings[0]?.state).toBe("CONFIRMED"),
		);
		act(() => {
			result.current.respond.mutate({
				runId: RUN_ID,
				findingId: "f-answered",
				stableKey: "key-answered",
				kind: "RESPONDED",
				text: "A newer answer",
				responseId: "response-1",
				version: 4,
			});
		});
		await waitFor(() =>
			expect(cached()?.findings[1]?.response?.text).toBe(
				"A newer answer",
			),
		);

		await act(async () => {
			first.fail(orpcError("INTERNAL_SERVER_ERROR"));
		});
		await waitFor(() =>
			expect(result.current.pendingKeys.has("key-open")).toBe(false),
		);
		expect(cached()?.findings[0]).toMatchObject({
			state: "UNADDRESSED",
			response: null,
		});
		expect(cached()?.findings[1]).toMatchObject({
			state: "RESPONDED",
			response: { text: "A newer answer" },
		});
		expect(result.current.pendingKeys.has("key-answered")).toBe(true);

		await act(async () => {
			second.settle({
				outcome: "written",
				stableKey: "key-answered",
				answeredRunId: RUN_ID,
				response: savedAnswer({ version: 5, text: "A newer answer" }),
			});
		});
		await waitFor(() => expect(result.current.pendingKeys.size).toBe(0));
		expect(cached()?.findings[1]?.response).toMatchObject({
			version: 5,
			text: "A newer answer",
		});
		expect(cached()?.findings[0]?.state).toBe("UNADDRESSED");
	});

	it("puts a stale clear back where it was listed, keeping a clear of another key that was saved", async () => {
		client.setQueryData(
			key,
			analysis({
				findings: [open, answered],
				noLongerRaised: [
					noLongerRaised({ stableKey: "key-gone-1" }),
					noLongerRaised({ stableKey: "key-gone-2" }),
				],
			}),
		);
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.clearFindingResponse
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { result } = renderActions();

		act(() => {
			result.current.clear.mutate({
				stableKey: "key-gone-1",
				responseId: "response-1",
				version: 1,
			});
		});
		await waitFor(() => expect(cached()?.noLongerRaised).toHaveLength(1));
		act(() => {
			result.current.clear.mutate({
				stableKey: "key-gone-2",
				responseId: "response-1",
				version: 1,
			});
		});
		await waitFor(() => expect(cached()?.noLongerRaised).toEqual([]));

		await act(async () => {
			second.settle({ outcome: "cleared", stableKey: "key-gone-2" });
		});
		await act(async () => {
			first.settle({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: savedAnswer({ version: 2 }),
			});
		});
		await waitFor(() => expect(result.current.pendingKeys.size).toBe(0));
		expect(
			cached()?.noLongerRaised.map((answer) => answer.stableKey),
		).toEqual(["key-gone-1"]);
	});

	it("clears at once, from the findings or from no longer raised, and undoes a refusal", async () => {
		api.clearFindingResponse.mockResolvedValueOnce({
			outcome: "cleared",
			stableKey: "key-gone",
		});
		const { result } = renderActions();

		await act(async () => {
			await result.current.clear.mutateAsync({
				stableKey: "key-gone",
				responseId: "response-1",
				version: 1,
			});
		});
		expect(cached()?.noLongerRaised).toEqual([]);
		expect(api.clearFindingResponse).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			stableKey: "key-gone",
			responseId: "response-1",
			version: 1,
		});

		api.clearFindingResponse.mockRejectedValueOnce(
			orpcError("INTERNAL_SERVER_ERROR"),
		);
		await act(async () => {
			await result.current.clear
				.mutateAsync({
					stableKey: "key-answered",
					responseId: "response-1",
					version: 4,
				})
				.catch(() => undefined);
		});
		expect(cached()?.findings[1]?.state).toBe("RESPONDED");
	});

	it("refetches the analysis after every outcome", async () => {
		api.rerunAnalysis.mockResolvedValue({ runId: "analysis-2" });
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const { result } = renderActions();

		await act(async () => {
			await result.current.rerun.mutateAsync();
		});
		expect(api.rerunAnalysis).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
	});
});
