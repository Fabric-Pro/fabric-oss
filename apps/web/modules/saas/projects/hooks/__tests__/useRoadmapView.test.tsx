/**
 * Behavior tests for roadmap sort **persistence** (card #1704).
 *
 * Sort used to be a live, non-persisted toolbar control that reset to the
 * default every session. It now behaves like `showClosed`: a change is written
 * to the DB immediately (no explicit save) and restored on load. These tests
 * pin both halves — the read path (a saved sort is restored) and the write path
 * (a sort change persists at once) — plus the guard that a sort change must not
 * mark the settings-menu draft dirty.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockUpdate } = vi.hoisted(() => ({
	mockGet: vi.fn<(input: unknown) => Promise<unknown>>(),
	mockUpdate: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			roadmapView: {
				get: {
					queryOptions: (options: {
						input: Record<string, unknown>;
					}) => ({
						queryKey: ["roadmapView", options.input],
						queryFn: () => mockGet(options.input),
					}),
					queryKey: (options: { input: Record<string, unknown> }) => [
						"roadmapView",
						options.input,
					],
				},
				update: {
					mutationOptions: (overrides?: Record<string, unknown>) => ({
						...overrides,
						mutationFn: (input: unknown) => mockUpdate(input),
					}),
				},
			},
		},
	},
}));

import { useRoadmapView } from "../useRoadmapView";

function renderRoadmapView(projectId = "project-1") {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return renderHook(() => useRoadmapView(projectId, null), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	mockGet.mockResolvedValue({ roadmapView: null, roadmapStoryOrder: null });
	mockUpdate.mockResolvedValue({ roadmapView: {} });
});

describe("useRoadmapView — sort persistence", () => {
	it("restores a persisted sort from the database on load", async () => {
		mockGet.mockResolvedValue({
			roadmapView: {
				mode: "plain",
				sort: { key: "created", direction: "desc" },
			},
			roadmapStoryOrder: null,
		});

		const { result } = renderRoadmapView();

		await waitFor(() =>
			expect(result.current.sort).toEqual({
				key: "created",
				direction: "desc",
			}),
		);
	});

	it("persists a sort change immediately, with no explicit save", async () => {
		const { result } = renderRoadmapView();

		act(() => {
			result.current.setSort({ key: "priority", direction: "desc" });
		});

		await waitFor(() =>
			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project-1",
					roadmapView: expect.objectContaining({
						sort: { key: "priority", direction: "desc" },
					}),
				}),
			),
		);
		// The live view reflects the new sort...
		expect(result.current.sort).toEqual({
			key: "priority",
			direction: "desc",
		});
		// ...but a sort change must never mark the gear-menu draft dirty
		// (it is an immediate control, not a Save/Cancel setting).
		expect(result.current.isViewDirty).toBe(false);
	});
});

/**
 * The layout allowlist is the single point where a persisted mode is validated.
 * A mode that survives the round-trip to the database but is silently dropped on
 * read is the failure this suite exists to prevent.
 */
describe("useRoadmapView — layout mode persistence", () => {
	it.each(["table", "board", "plain", "priority"] as const)(
		"restores the %s layout from the database",
		async (mode) => {
			mockGet.mockResolvedValue({
				roadmapView: { mode },
				roadmapStoryOrder: null,
			});

			const { result } = renderRoadmapView();

			await waitFor(() => expect(result.current.mode).toBe(mode));
		},
	);

	it("falls back to the table layout for a mode it does not recognise", async () => {
		mockGet.mockResolvedValue({
			// `showClosed` rides along purely so the assertion can wait for the
			// persisted view to actually land — otherwise "mode is table" would
			// pass against the pre-load default and prove nothing.
			roadmapView: { mode: "gantt", showClosed: true },
			roadmapStoryOrder: null,
		});

		const { result } = renderRoadmapView();

		await waitFor(() => expect(result.current.showClosed).toBe(true));
		expect(result.current.mode).toBe("table");
	});

	it("falls back to table when the priority layout is killed by its flag", async () => {
		// The rollback path: turning the flag off must not strand whoever had
		// the layout saved on a view that no longer renders.
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_PRIORITY_VIEW", "false");
		vi.resetModules();
		const { useRoadmapView: useRoadmapViewWithFlagOff } = await import(
			"../useRoadmapView"
		);

		mockGet.mockResolvedValue({
			roadmapView: { mode: "priority", showClosed: true },
			roadmapStoryOrder: null,
		});

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(
			() => useRoadmapViewWithFlagOff("project-1", null),
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={queryClient}>
						{children}
					</QueryClientProvider>
				),
			},
		);

		await waitFor(() => expect(result.current.showClosed).toBe(true));
		expect(result.current.mode).toBe("table");

		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("round-trips a layout change through save", async () => {
		const { result } = renderRoadmapView();

		act(() => {
			result.current.setMode("priority");
		});
		expect(result.current.mode).toBe("priority");
		// Layout is a draft setting: nothing is written until Save.
		expect(mockUpdate).not.toHaveBeenCalled();

		act(() => {
			result.current.commitView();
		});

		await waitFor(() =>
			expect(mockUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					roadmapView: expect.objectContaining({
						mode: "priority",
					}),
				}),
			),
		);
	});
});
