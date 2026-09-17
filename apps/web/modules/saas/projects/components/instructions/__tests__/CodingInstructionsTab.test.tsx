/**
 * Important 4 (round 4). The tab polled the snapshot LIST and stopped on any
 * terminal status, but `finalizeInstructionSnapshot` writes READY one activity
 * BEFORE `publishInstructionSnapshotActivity` moves the project's published
 * pointer — and `getPublished` was invalidated only immediately after
 * `finalize` returned, normally minutes before validation finished. So a first
 * upload kept showing "nothing published" and a replacement kept showing the
 * old tree until the viewer reloaded or refocused the tab.
 *
 * These tests drive the tab's two queries through a fake clock and assert what
 * it asks the server for: that seeing READY triggers an immediate re-read of
 * the pointer, that both queries keep polling until the pointer names that
 * snapshot, and that everything stops once it does.
 *
 * The three child components are stubbed. What is under test is the tab's
 * query behaviour, and rendering the real published view would drag in the
 * file tree, the settings dialog and the folder picker for no added coverage.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Snapshot = {
	id: string;
	version: number;
	status: string;
	publishOnReady: boolean;
};

const state = vi.hoisted(() => ({
	snapshots: [] as unknown[],
	published: null as unknown,
	listCalls: 0,
	publishedCalls: 0,
}));

/**
 * One `queryOptions` stub per procedure. The key carries the procedure NAME as
 * well as the input, because the tab invalidates `getPublished` by the key it
 * builds from the same helper — a shared key would make that invalidation hit
 * the list too and the test would pass for the wrong reason.
 */
function queryOptionsStub(name: string, queryFn: () => Promise<unknown>) {
	return (o: { input: unknown }) => ({
		queryKey: [name, o.input],
		queryFn,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				list: {
					queryOptions: queryOptionsStub("list", async () => {
						state.listCalls++;
						return state.snapshots;
					}),
				},
				getPublished: {
					queryOptions: queryOptionsStub("getPublished", async () => {
						state.publishedCalls++;
						return state.published;
					}),
				},
				getSettings: {
					queryOptions: queryOptionsStub("getSettings", async () => ({
						ignoreGlobs: null,
						defaultIgnoreGlobs: [],
						sourceOfTruth: null,
					})),
				},
			},
		},
	},
}));

vi.mock("../InstructionsPublishedView", () => ({
	InstructionsPublishedView: ({
		published,
	}: {
		published: { id?: string } | null;
	}) => <div data-testid="published-id">{published?.id ?? "none"}</div>,
}));
vi.mock("../InstructionsEmptyState", () => ({
	InstructionsEmptyState: () => <div data-testid="empty" />,
}));
vi.mock("../UploadFolderDialog", () => ({
	UploadFolderDialog: () => null,
}));

import { CodingInstructionsTab } from "../CodingInstructionsTab";

const POLL_MS = 3_000;

function snapshot(id: string, status: string): Snapshot {
	return { id, version: 2, status, publishOnReady: true };
}

/**
 * Advance the fake clock and let React flush what that produced.
 *
 * `waitFor` is deliberately not used: Testing Library only auto-advances
 * JEST fake timers, so under `vi.useFakeTimers()` it waits on a clock nothing
 * is moving and times out. Driving the clock explicitly is also the point of
 * these tests — every assertion is about what happens after N polls.
 */
async function tick(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function Wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	state.snapshots = [snapshot("snap_2", "VALIDATING")];
	state.published = { id: "snap_1", version: 1, status: "READY" };
	state.listCalls = 0;
	state.publishedCalls = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CodingInstructionsTab publication convergence", () => {
	it("re-reads the published pointer on seeing READY and keeps polling until it matches", async () => {
		render(<CodingInstructionsTab projectId="p" />, { wrapper: Wrapper });
		await tick(0);
		expect(screen.getByTestId("published-id")).toHaveTextContent("snap_1");
		const publishedAfterMount = state.publishedCalls;

		// The workflow finishes validating and writes READY. The pointer has
		// NOT moved yet — the publish activity is the next step.
		state.snapshots = [snapshot("snap_2", "READY")];
		await tick(POLL_MS);

		// Seeing READY re-reads the pointer immediately rather than waiting a
		// whole further interval, because publication normally lands within a
		// second of the READY write.
		expect(state.publishedCalls).toBeGreaterThan(publishedAfterMount);

		// The pointer is still behind, so BOTH queries keep polling even
		// though the list is now entirely terminal.
		const before = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		await tick(POLL_MS);
		await tick(POLL_MS);
		expect(state.listCalls).toBeGreaterThan(before.list);
		expect(state.publishedCalls).toBeGreaterThan(before.published);

		// The publish activity moves the pointer.
		state.published = { id: "snap_2", version: 2, status: "READY" };
		await tick(POLL_MS);
		await tick(POLL_MS);
		expect(screen.getByTestId("published-id")).toHaveTextContent("snap_2");

		// Converged: nothing is polled any more.
		const settled = {
			list: state.listCalls,
			published: state.publishedCalls,
		};
		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	// The budget is what keeps this from re-creating the unbounded poll the
	// interval policy was extracted to end: a workflow that dies between the
	// READY write and the publish activity never moves the pointer, and the
	// tab must give up rather than poll that project forever, for every viewer.
	it("gives up after the bounded run of polls when publication never lands", async () => {
		render(<CodingInstructionsTab projectId="p" />, { wrapper: Wrapper });
		await tick(0);

		state.snapshots = [snapshot("snap_2", "READY")];
		// Well past INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS, with the pointer
		// left behind on snap_1 throughout.
		for (let i = 0; i < 30; i++) {
			await tick(POLL_MS);
		}
		const settled = {
			list: state.listCalls,
			published: state.publishedCalls,
		};

		for (let i = 0; i < 5; i++) {
			await tick(POLL_MS);
		}
		expect(state.listCalls).toBe(settled.list);
		expect(state.publishedCalls).toBe(settled.published);
	});

	it.each(["REJECTED", "FAILED"])(
		"stops polling on %s, which never publishes",
		async (status) => {
			render(<CodingInstructionsTab projectId="p" />, {
				wrapper: Wrapper,
			});
			await tick(0);
			expect(screen.getByTestId("published-id")).toHaveTextContent(
				"snap_1",
			);

			state.snapshots = [snapshot("snap_2", status)];
			await tick(POLL_MS);
			const settled = {
				list: state.listCalls,
				published: state.publishedCalls,
			};

			for (let i = 0; i < 5; i++) {
				await tick(POLL_MS);
			}
			expect(state.listCalls).toBe(settled.list);
			expect(state.publishedCalls).toBe(settled.published);
		},
	);
});
