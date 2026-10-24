import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: ({ input }: { input: unknown }) => [
					"projects.get",
					input,
				],
			},
			documents: {
				list: {
					queryKey: ({ input }: { input: unknown }) => [
						"projects.documents.list",
						input,
					],
				},
			},
		},
	},
}));

import {
	DOCUMENT_CHANGE_REFRESH_GATHER_MS as GATHER_MS,
	useDocumentChangeRefresh,
} from "../use-document-change-refresh";
import type { DocumentChangeEvent } from "../useProjectRealtime";

const PROJECT_KEY = ["projects.get", { id: "p1", organizationId: "org-1" }];
const LIST_KEY = [
	"projects.documents.list",
	{ projectId: "p1", organizationId: "org-1" },
];
const NO_CANCEL = { cancelRefetch: false };
const COMPLETE_LIST = { documents: [{ id: "d1", status: "COMPLETE" }] };

function nudge(projectId = "p1"): DocumentChangeEvent {
	return {
		projectId,
		documentId: "d1",
		action: "updated",
		userId: "u1",
		userName: "Writer",
	};
}

type ListQueryFn = (context: { signal: AbortSignal }) => Promise<unknown>;

function setup({
	initialOrganizationId = "org-1",
	observeList,
}: {
	initialOrganizationId?: string | null;
	observeList?: ListQueryFn;
} = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const view = renderHook(
		({ organizationId }: { organizationId: string | null }) => {
			// Stands in for an open DocumentsList reading the same key.
			useQuery({
				queryKey: LIST_KEY,
				queryFn: observeList ?? (() => Promise.resolve(COMPLETE_LIST)),
				enabled: !!observeList,
			});
			return useDocumentChangeRefresh({
				projectId: "p1",
				organizationId,
			});
		},
		{ wrapper, initialProps: { organizationId: initialOrganizationId } },
	);
	const send = (event: DocumentChangeEvent = nudge()) => {
		act(() => {
			view.result.current(event);
		});
	};
	const advance = async (ms: number) => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	};
	const reads = (key: unknown[]) =>
		invalidate.mock.calls.filter(
			([filters]) =>
				JSON.stringify(filters?.queryKey) === JSON.stringify(key),
		).length;
	return { client, invalidate, view, send, advance, reads };
}

describe("useDocumentChangeRefresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads the project and its documents list again once, after the gather, for one change", async () => {
		const { invalidate, send, advance } = setup();

		send();
		await advance(GATHER_MS - 1);
		expect(invalidate).not.toHaveBeenCalled();

		await advance(1);
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledWith(
			{ queryKey: PROJECT_KEY },
			NO_CANCEL,
		);
		expect(invalidate).toHaveBeenCalledWith(
			{ queryKey: LIST_KEY },
			NO_CANCEL,
		);
	});

	it("reads each once for a burst of section nudges inside one window", async () => {
		const { send, advance, reads } = setup();

		for (let i = 0; i < 10; i++) {
			send();
			await advance(150);
		}
		await advance(GATHER_MS);

		expect(reads(PROJECT_KEY)).toBe(1);
		expect(reads(LIST_KEY)).toBe(1);
	});

	it("is not pushed back by a change that lands late in the window", async () => {
		const { send, advance, reads } = setup();

		send();
		await advance(GATHER_MS - 100);
		send();
		await advance(100);

		expect(reads(PROJECT_KEY)).toBe(1);
		expect(reads(LIST_KEY)).toBe(1);
	});

	it("reads each once per window when changes arrive in two windows", async () => {
		const { send, advance, reads } = setup();

		send();
		await advance(GATHER_MS);
		send();
		await advance(GATHER_MS);

		expect(reads(PROJECT_KEY)).toBe(2);
		expect(reads(LIST_KEY)).toBe(2);
	});

	it("drops a pending read when the page unmounts", async () => {
		const { invalidate, view, send, advance } = setup();

		send();
		view.unmount();
		await advance(GATHER_MS * 2);

		expect(invalidate).not.toHaveBeenCalled();
	});

	it("ignores a change for another project", async () => {
		const { invalidate, send, advance } = setup();

		send(nudge("p2"));
		await advance(GATHER_MS);

		expect(invalidate).not.toHaveBeenCalled();
	});

	it("keeps one callback while the organization resolves, and reads the resolved queries", async () => {
		const { invalidate, view, send, advance } = setup({
			initialOrganizationId: null,
		});
		const first = view.result.current;

		view.rerender({ organizationId: "org-1" });
		expect(view.result.current).toBe(first);

		send();
		await advance(GATHER_MS);
		expect(invalidate).toHaveBeenCalledWith(
			{ queryKey: PROJECT_KEY },
			NO_CANCEL,
		);
		expect(invalidate).toHaveBeenCalledWith(
			{ queryKey: LIST_KEY },
			NO_CANCEL,
		);
	});

	it("leaves the list to its own polling while a listed document is generating", async () => {
		const { client, send, advance, reads } = setup();
		client.setQueryData(LIST_KEY, {
			documents: [
				COMPLETE_LIST.documents[0],
				{ id: "d2", status: "GENERATING", updatedAt: new Date() },
			],
		});

		send();
		await advance(GATHER_MS);

		expect(reads(PROJECT_KEY)).toBe(1);
		expect(reads(LIST_KEY)).toBe(0);
	});

	it("does not cancel a list read in flight when the next gather ends", async () => {
		const signals: AbortSignal[] = [];
		let settle: (value: unknown) => void = () => {};
		const queryFn: ListQueryFn = ({ signal }) => {
			signals.push(signal);
			if (signals.length === 1) {
				return Promise.resolve(COMPLETE_LIST);
			}
			return new Promise((resolve) => {
				settle = resolve;
			});
		};
		const { send, advance } = setup({ observeList: queryFn });
		await advance(0);
		expect(signals).toHaveLength(1);

		// The first gather starts a list read that is still running when the
		// second gather ends.
		send();
		await advance(GATHER_MS);
		expect(signals).toHaveLength(2);

		send();
		await advance(GATHER_MS);
		expect(signals).toHaveLength(2);
		expect(signals[1]?.aborted).toBe(false);

		await act(async () => {
			settle(COMPLETE_LIST);
		});
	});
});
