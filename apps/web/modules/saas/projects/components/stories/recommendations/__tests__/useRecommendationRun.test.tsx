/**
 * `useRecommendationRun` (Fizzy #2208, FR36–FR40): one case per run outcome.
 *
 * next-intl echoes keys, so FR37 and FR39 are pinned against en.json
 * directly and the hook is asserted to use exactly those keys.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generate: vi.fn(),
	status: vi.fn(),
	replace: vi.fn(),
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				generateRecommendations: (...args: unknown[]) =>
					mocks.generate(...args),
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			backlog: {
				recommendationStatus: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["recommendation-status", input],
						queryFn: () => mocks.status(input),
					}),
				},
			},
		},
	},
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: mocks.replace }),
	usePathname: () => "/app/example-org/projects/p1",
	useSearchParams: () => new URLSearchParams("tab=roadmap"),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import {
	RecommendationStartError,
	startErrorToast,
	useRecommendationRun,
} from "../useRecommendationRun";

const here = path.dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(
	readFileSync(
		path.resolve(
			here,
			"../../../../../../../../../packages/i18n/translations/en.json",
		),
		"utf8",
	),
);

const FR37 =
	"Fabric doesn’t have enough project context to recommend features yet. Add more project context, connect a source, or pull work items from your project management system, then try again.";
const FR39 =
	"Fabric couldn’t generate feature recommendations. Please try again. If the problem continues, check project context, connected sources, or background job status before retrying.";

function setup(enabled = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() => useRecommendationRun({ projectId: "p1", enabled }),
		{ wrapper },
	);
	return { ...hook, client, invalidate };
}

function completed(outcome: string, extra: Record<string, unknown> = {}) {
	return {
		state: "completed",
		outcome,
		proposalId: null,
		changeCount: 0,
		entryPoint: "MATURE_ROADMAP",
		...extra,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.status.mockResolvedValue({ state: "idle" });
	mocks.generate.mockResolvedValue({
		workflowId: "roadmap-recommendation-p1",
		alreadyRunning: false,
	});
});

describe("copy (FR37, FR39, FR40)", () => {
	it("pins FR37 in its two homes and FR39 verbatim", () => {
		const roadmapReasons = en.projects.capabilityGates.reason.roadmap;
		expect(roadmapReasons.recommend["context-insufficient"].body).toBe(
			FR37,
		);
		// Do both's context half says FR37 exactly too (the lead's copy call:
		// the missing half is named in the title, the body stays approved).
		expect(roadmapReasons["do-both"]["needs-context"].body).toBe(FR37);
		expect(en.projects.recommendations.generationFailed).toBe(FR39);
		expect(JSON.stringify(en).split(FR37)).toHaveLength(3);
	});
});

describe("useRecommendationRun", () => {
	it("starts with the project and entry point only — no organization", async () => {
		const { result } = setup();
		await act(() => result.current.start("MATURE_ROADMAP"));
		expect(mocks.generate).toHaveBeenCalledWith({
			projectId: "p1",
			entryPoint: "MATURE_ROADMAP",
		});
		expect(mocks.toast.success).toHaveBeenCalledWith("started", {
			description: "startedDescription",
		});
	});

	it("says a run is already in flight instead of starting another", async () => {
		mocks.generate.mockResolvedValue({
			workflowId: "roadmap-recommendation-p1",
			alreadyRunning: true,
		});
		const { result } = setup();
		await act(() => result.current.start("EMPTY_ROADMAP"));
		expect(mocks.toast.info).toHaveBeenCalledWith("alreadyRunning");
	});

	it("rejects a failed start with FR39 and toasts nothing itself", async () => {
		mocks.generate.mockRejectedValue(new Error("boom"));
		const { result } = setup();
		await expect(result.current.start("EMPTY_ROADMAP")).rejects.toThrow(
			"generationFailed",
		);
		expect(mocks.toast.error).not.toHaveBeenCalled();
	});

	it("rejects a gate refusal with the gate's title and body kept apart (FR37)", async () => {
		mocks.generate.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "refused",
				data: {
					gate: {
						capabilityKey: "roadmap.recommend-features",
						state: "SOFT_BLOCK",
						reasonKey: "roadmap.recommend.context-insufficient",
						blockingDependency: "project context",
						remedy: "ADD_CONTEXT",
						retry: null,
						suppressed: false,
						fingerprint: "f",
					},
				},
			}),
		);
		const { result } = setup();
		const error = await result.current
			.start("EMPTY_ROADMAP")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RecommendationStartError);
		// The body alone is the message, so it shows FR37 exactly; the
		// headline travels separately and is never joined onto it.
		expect((error as RecommendationStartError).message).toBe(
			"reason.roadmap.recommend.context-insufficient.body",
		);
		expect((error as RecommendationStartError).title).toBe(
			"reason.roadmap.recommend.context-insufficient.title",
		);
	});

	it("startErrorToast uses the gate headline as the toast title", () => {
		expect(
			startErrorToast(
				new RecommendationStartError("body", "Headline"),
				"startFailed",
				"generationFailed",
			),
		).toEqual({ title: "Headline", description: "body" });
		expect(
			startErrorToast(
				new RecommendationStartError("generationFailed", null),
				"startFailed",
				"generationFailed",
			),
		).toEqual({ title: "startFailed", description: "generationFailed" });
	});

	it("GENERATED: announces the count and opens the inbox on the batch", async () => {
		const { result, invalidate } = setup();
		await waitFor(() => expect(mocks.status).toHaveBeenCalled());
		mocks.status.mockResolvedValue(
			completed("GENERATED", { proposalId: "batch-1", changeCount: 27 }),
		);
		await act(() => result.current.start("MATURE_ROADMAP"));

		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith("generated", {
				description: "generatedDescription",
			}),
		);
		expect(mocks.replace).toHaveBeenCalledWith(
			"/app/example-org/projects/p1?tab=roadmap&proposal=batch-1",
			{ scroll: false },
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["capability-gates"],
		});
		expect(result.current.isRunning).toBe(false);
	});

	it("INSUFFICIENT_CONTEXT: shows FR37 from the capability-gate copy and opens nothing", async () => {
		const { result } = setup();
		await waitFor(() => expect(mocks.status).toHaveBeenCalled());
		mocks.status.mockResolvedValue(completed("INSUFFICIENT_CONTEXT"));
		await act(() => result.current.start("EMPTY_ROADMAP"));

		await waitFor(() =>
			expect(mocks.toast.warning).toHaveBeenCalledWith(
				"reason.roadmap.recommend.context-insufficient.title",
				{
					description:
						"reason.roadmap.recommend.context-insufficient.body",
				},
			),
		);
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("NO_RECOMMENDATIONS: says none were created", async () => {
		const { result } = setup();
		await waitFor(() => expect(mocks.status).toHaveBeenCalled());
		mocks.status.mockResolvedValue(completed("NO_RECOMMENDATIONS"));
		await act(() => result.current.start("MATURE_ROADMAP"));

		await waitFor(() =>
			expect(mocks.toast.info).toHaveBeenCalledWith("noRecommendations"),
		);
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("failed run: shows FR39", async () => {
		const { result } = setup();
		await waitFor(() => expect(mocks.status).toHaveBeenCalled());
		mocks.status.mockResolvedValue({ state: "failed" });
		await act(() => result.current.start("MATURE_ROADMAP"));

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith("generationFailed"),
		);
	});

	it("picks up a run already in flight on mount and reports how it ends", async () => {
		mocks.status.mockResolvedValue({
			state: "running",
			phase: "generating",
			entryPoint: "EMPTY_ROADMAP",
		});
		const { result, client } = setup();
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		mocks.status.mockResolvedValue(completed("NO_RECOMMENDATIONS"));
		await act(() => client.refetchQueries());
		await waitFor(() =>
			expect(mocks.toast.info).toHaveBeenCalledWith("noRecommendations"),
		);
	});

	it("stays silent about a run that finished before the page loaded", async () => {
		mocks.status.mockResolvedValue(
			completed("GENERATED", { proposalId: "old", changeCount: 3 }),
		);
		const { client } = setup();
		await waitFor(() => expect(mocks.status).toHaveBeenCalled());
		await act(() => client.refetchQueries());
		expect(mocks.toast.success).not.toHaveBeenCalled();
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("reads nothing while disabled", async () => {
		setup(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.status).not.toHaveBeenCalled();
	});
});
