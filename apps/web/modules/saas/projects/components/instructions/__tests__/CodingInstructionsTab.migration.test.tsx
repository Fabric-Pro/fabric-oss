/**
 * The tab's handling of a move of uploaded instructions into a repository
 * (Fizzy #2878 §9): it reads the move only while the sync state says one is
 * open, hands what it reads to the view, and re-reads the sync state once the
 * move is gone, leaving a notice behind when the move ended without its files
 * landing.
 *
 * The published view is a stub that shows what the tab hands it. What is under
 * test is the tab's own reads and the controls it builds.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const state = vi.hoisted(() => ({
	sync: null as unknown,
	migration: null as unknown,
	syncCalls: 0,
	migrationCalls: 0,
}));

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
				repository: {
					getState: {
						queryOptions: queryOptionsStub(
							"repository-getState",
							async () => ({
								availability: "UPLOAD",
							}),
						),
					},
				},
				list: {
					queryOptions: queryOptionsStub("list", async () => []),
				},
				getPublished: {
					queryOptions: queryOptionsStub(
						"getPublished",
						async () => ({
							id: "snap_1",
							version: 1,
							status: "READY",
						}),
					),
				},
				getSettings: {
					queryOptions: queryOptionsStub("getSettings", async () => ({
						ignoreGlobs: null,
						defaultIgnoreGlobs: [],
						sourceOfTruth: "UPLOAD",
					})),
				},
				proposals: {
					list: {
						queryOptions: queryOptionsStub(
							"proposals-list",
							async () => [],
						),
					},
				},
				repositorySync: {
					get: {
						queryOptions: queryOptionsStub(
							"repositorySync-get",
							async () => {
								state.syncCalls++;
								return state.sync;
							},
						),
					},
					listRuns: {
						queryOptions: queryOptionsStub(
							"repositorySync-listRuns",
							async () => ({ runs: [] }),
						),
					},
					getMigration: {
						queryOptions: queryOptionsStub(
							"repositorySync-getMigration",
							async () => {
								state.migrationCalls++;
								return state.migration;
							},
						),
					},
					syncNow: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: async () => ({ started: true }),
							...opts,
						}),
					},
				},
			},
		},
	},
}));

vi.mock("../ConfigureRepositorySyncDialog", () => ({
	ConfigureRepositorySyncDialog: () => null,
}));
vi.mock("../InstructionsEmptyState", () => ({
	InstructionsEmptyState: () => <div data-testid="empty" />,
}));
vi.mock("../UploadFolderDialog", () => ({ UploadFolderDialog: () => null }));
const moveDialog = vi.hoisted(() => ({
	started: null as (() => void) | null,
	integrations: [] as Array<{ id: string }>,
}));
vi.mock("../MoveInstructionsDialog", () => ({
	MoveInstructionsDialog: ({
		integrations,
		onStarted,
	}: {
		integrations: Array<{ id: string }>;
		onStarted: () => void;
	}) => {
		moveDialog.started = onStarted;
		moveDialog.integrations = integrations;
		return <div data-testid="move-dialog" />;
	},
}));
vi.mock("../InstructionsPublishedView", () => ({
	InstructionsPublishedView: ({
		repositorySync,
	}: {
		repositorySync?: {
			state: { migration?: { state: string } | null };
			onMove?: () => void;
			migration?: {
				read?: { migration: { state: string } | null } | undefined;
				endedNotice: { pullRequest: string | null } | null;
				onDismissEndedNotice: () => void;
			};
		};
	}) => (
		<>
			<div data-testid="pointer">
				{repositorySync?.state.migration?.state ?? "none"}
			</div>
			<div data-testid="read">
				{repositorySync?.migration?.read === undefined
					? "unread"
					: (repositorySync.migration.read.migration?.state ??
						"gone")}
			</div>
			<div data-testid="notice">
				{repositorySync?.migration?.endedNotice
					? `#${repositorySync.migration.endedNotice.pullRequest}`
					: "none"}
			</div>
			<button
				type="button"
				onClick={() =>
					repositorySync?.migration?.onDismissEndedNotice()
				}
			>
				dismiss
			</button>
			<button type="button" onClick={() => repositorySync?.onMove?.()}>
				move
			</button>
		</>
	),
}));

import { CodingInstructionsTab } from "../CodingInstructionsTab";

const CONFIGURED = {
	syncId: "sync_1",
	repositoryIntegrationId: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	repositoryUrl: "https://github.com/example-org/instructions.git",
	integrationStatus: "ACTIVE",
	ref: "main",
	rootPath: "docs/instructions",
	automatic: true,
	automaticPausedReason: "MIGRATING",
	automaticPausedAt: null,
	delegateName: null,
};

const INTEGRATION = {
	id: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "main",
};

function sync(migration: { state: string } | null) {
	return {
		sourceOfTruth: "UPLOAD",
		canConfigure: true,
		running: false,
		configured: migration ? CONFIGURED : null,
		latestRun: null,
		availableIntegrations: [INTEGRATION],
		migration,
	};
}

function read(migrationState: string | null) {
	return {
		migration: migrationState && {
			state: migrationState,
			closing: false,
			startedAt: "2026-10-02T10:00:00.000Z",
			startedByUserId: "user-1",
			snapshotId: "snap-1",
			branchId: "branch-1",
			syncId: "sync_1",
			pullRequest: {
				url: "https://example.com/pull/12",
				externalId: "12",
				state: migrationState === "ABANDONED" ? "CLOSED" : "OPEN",
			},
			targetMismatch: false,
			failure: null,
		},
		repository: migrationState && {
			provider: "GITHUB",
			owner: "example-org",
			name: "instructions",
			ref: "main",
			folder: "docs/instructions",
		},
	};
}

/**
 * Advances the fake clock, then lets what that produced settle: a poll's
 * answer is delivered to React on a zero-delay timer of its own, and the
 * re-read it causes needs the same again.
 */
async function tick(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	for (let settle = 0; settle < 5; settle++) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
	}
}

function Wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderTab() {
	render(
		<CodingInstructionsTab projectId="p" projectName="Checkout Rewrite" />,
		{
			wrapper: Wrapper,
		},
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	state.sync = sync(null);
	state.migration = read(null);
	state.syncCalls = 0;
	state.migrationCalls = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CodingInstructionsTab and a move into a repository", () => {
	it("does not read a move while the sync state names none", async () => {
		renderTab();
		await tick(0);

		expect(screen.getByTestId("pointer")).toHaveTextContent("none");
		expect(screen.getByTestId("read")).toHaveTextContent("unread");
		expect(state.migrationCalls).toBe(0);
	});

	it("reads the move once the sync state names one, and hands the read to the view", async () => {
		state.sync = sync({ state: "PROPOSING" });
		state.migration = read("OPEN");
		renderTab();
		await tick(0);

		expect(screen.getByTestId("pointer")).toHaveTextContent("PROPOSING");
		expect(screen.getByTestId("read")).toHaveTextContent("OPEN");
		expect(state.migrationCalls).toBeGreaterThan(0);
	});

	it("re-reads the sync state once the move is gone", async () => {
		state.sync = sync({ state: "PROPOSING" });
		state.migration = read("OPEN");
		renderTab();
		await tick(0);
		const before = state.syncCalls;

		state.sync = sync(null);
		state.migration = read(null);
		await tick(31_000);

		expect(state.syncCalls).toBeGreaterThan(before);
		expect(screen.getByTestId("pointer")).toHaveTextContent("none");
	});

	it("leaves a notice naming the pull request when it ended without merging, until it is dismissed", async () => {
		state.sync = sync({ state: "PROPOSING" });
		state.migration = read("ABANDONED");
		renderTab();
		await tick(0);

		state.sync = sync(null);
		state.migration = read(null);
		await tick(30_000);

		expect(screen.getByTestId("notice")).toHaveTextContent("#12");

		fireEvent.click(screen.getByRole("button", { name: "dismiss" }));

		expect(screen.getByTestId("notice")).toHaveTextContent("none");
	});

	it("leaves no notice for a move that completed", async () => {
		state.sync = sync({ state: "SWITCHING" });
		state.migration = read("SWITCHING");
		renderTab();
		await tick(0);

		state.sync = { ...sync(null), sourceOfTruth: "REPOSITORY" };
		state.migration = read(null);
		await tick(30_000);

		expect(screen.getByTestId("notice")).toHaveTextContent("none");
	});
});

describe("CodingInstructionsTab and starting a move", () => {
	it("opens the move over the repositories connected to the project, and only when asked", async () => {
		renderTab();
		await tick(0);
		expect(screen.queryByTestId("move-dialog")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "move" }));
		await tick(0);

		expect(screen.getByTestId("move-dialog")).toBeInTheDocument();
		expect(moveDialog.integrations).toEqual([INTEGRATION]);
	});

	it("re-reads the sync state once the move has started, so the tab shows it", async () => {
		renderTab();
		await tick(0);
		fireEvent.click(screen.getByRole("button", { name: "move" }));
		await tick(0);
		const before = state.syncCalls;

		state.sync = sync({ state: "PROPOSING" });
		state.migration = read("PROPOSING");
		await act(async () => {
			moveDialog.started?.();
		});
		await tick(0);

		expect(state.syncCalls).toBeGreaterThan(before);
		expect(screen.getByTestId("pointer")).toHaveTextContent("PROPOSING");
		expect(screen.queryByTestId("move-dialog")).not.toBeInTheDocument();
	});
});
