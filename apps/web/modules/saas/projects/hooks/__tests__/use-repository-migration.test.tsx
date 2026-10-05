/**
 * The tab's read of a move of uploaded instructions into a repository (Fizzy
 * #2878 §9): it is read only while the sync state says a move is open, and it
 * tells the tab when the move is gone, with a notice when it was one that
 * ended without its files landing.
 */
import type {
	RepositoryMigrationRead,
	RepositoryMigrationView,
} from "@saas/projects/lib/instructions-migration";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositoryMigration } from "../use-repository-migration";

const mocks = vi.hoisted(() => ({
	read: { current: null as unknown },
	calls: { current: 0 },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repositorySync: {
					getMigration: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["getMigration", o.input],
							queryFn: async () => {
								mocks.calls.current++;
								return mocks.read.current;
							},
						}),
					},
				},
			},
		},
	},
}));

function move(
	overrides: Partial<RepositoryMigrationView> = {},
): RepositoryMigrationRead {
	return {
		migration: {
			state: "OPEN",
			closing: false,
			startedAt: "2026-10-02T10:00:00.000Z",
			startedByUserId: "user-1",
			snapshotId: "snap-1",
			branchId: "branch-1",
			syncId: "sync-1",
			pullRequest: {
				url: "https://example.com/pull/12",
				externalId: "12",
				state: "OPEN",
			},
			targetMismatch: false,
			failure: null,
			...overrides,
		},
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			name: "instructions",
			ref: "main",
			folder: "docs/instructions",
		},
	};
}

const GONE: RepositoryMigrationRead = { migration: null, repository: null };

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function setup(enabled: boolean, onGone = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		(props: { enabled: boolean }) =>
			useRepositoryMigration({
				projectId: "project-1",
				enabled: props.enabled,
				onGone,
			}),
		{ wrapper: wrapperFor(client), initialProps: { enabled } },
	);
	return { ...hook, client, onGone };
}

beforeEach(() => {
	mocks.read.current = move();
	mocks.calls.current = 0;
});

describe("useRepositoryMigration", () => {
	it("does not ask while no move is open", async () => {
		const { result } = setup(false);

		await act(async () => {
			await Promise.resolve();
		});

		expect(mocks.calls.current).toBe(0);
		expect(result.current.read).toBeUndefined();
	});

	it("reads the move and the repository it moves into", async () => {
		const { result } = setup(true);

		await waitFor(() => expect(result.current.read).toBeDefined());

		expect(result.current.read?.migration?.state).toBe("OPEN");
		expect(result.current.read?.repository?.name).toBe("instructions");
	});

	it("tells the tab once when the move is gone", async () => {
		const { result, onGone, client } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());

		mocks.read.current = GONE;
		await act(async () => {
			await client.invalidateQueries();
		});

		await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
	});

	it("leaves a notice when the move ended without its files landing", async () => {
		mocks.read.current = move({
			state: "ABANDONED",
			pullRequest: {
				url: "https://example.com/pull/12",
				externalId: "12",
				state: "CLOSED",
			},
		});
		const { result, client } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());

		mocks.read.current = GONE;
		await act(async () => {
			await client.invalidateQueries();
		});

		await waitFor(() =>
			expect(result.current.endedNotice).toEqual({
				pullRequest: "12",
				repository: "example-org/instructions",
			}),
		);
	});

	it("says a pull request merged into another branch when the move that ended was that", async () => {
		mocks.read.current = move({
			state: "ABANDONED",
			targetMismatch: true,
			pullRequest: {
				url: "https://example.com/pull/12",
				externalId: "12",
				state: "MERGED",
			},
		});
		const { result, client } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());

		mocks.read.current = GONE;
		await act(async () => {
			await client.invalidateQueries();
		});

		await waitFor(() =>
			expect(result.current.endedNotice).toEqual({
				pullRequest: "12",
				repository: "example-org/instructions",
				mergedElsewhere: true,
			}),
		);
	});

	it("takes the notice away once it is dismissed", async () => {
		mocks.read.current = move({ state: "ABANDONED" });
		const { result, client } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());
		mocks.read.current = GONE;
		await act(async () => {
			await client.invalidateQueries();
		});
		await waitFor(() => expect(result.current.endedNotice).not.toBeNull());

		act(() => result.current.dismissEndedNotice());

		expect(result.current.endedNotice).toBeNull();
	});

	it("leaves no notice for a move that completed", async () => {
		mocks.read.current = move({ state: "SWITCHING" });
		const { result, onGone, client } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());

		mocks.read.current = GONE;
		await act(async () => {
			await client.invalidateQueries();
		});

		await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
		expect(result.current.endedNotice).toBeNull();
	});

	it("treats the sync state clearing its pointer as the move being gone", async () => {
		mocks.read.current = move({ state: "ABANDONED" });
		const { result, rerender, onGone } = setup(true);
		await waitFor(() => expect(result.current.read).toBeDefined());

		rerender({ enabled: false });

		await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
		expect(result.current.endedNotice).toEqual({
			pullRequest: "12",
			repository: "example-org/instructions",
		});
	});
});
