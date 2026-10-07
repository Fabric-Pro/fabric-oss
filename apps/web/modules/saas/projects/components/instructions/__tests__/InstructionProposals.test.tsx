import { INSTRUCTION_PULL_REQUEST_FAILURE_CODES } from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		return node && typeof node === "object"
			? (node as Record<string, unknown>)[key]
			: undefined;
	}, en);
}

function makeT(namespace: string) {
	return (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		return Object.entries(values ?? {}).reduce(
			(out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
			raw,
		);
	};
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
}));

const state = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	detail: null as Record<string, unknown> | null,
	filePage: null as Record<string, unknown> | null,
	nextCursor: null as string | null,
	listError: null as Error | null,
	approve: vi.fn(),
	reject: vi.fn(),
	cancel: vi.fn(),
	approveError: null as Error | null,
	/** What `cancel` answers for the pull request (Fizzy #2563 spec §12). */
	cancelPullRequest: null as "canceled" | "close_requested" | null,
	refresh: vi.fn(),
	refreshError: null as Error | null,
	finalize: vi.fn(),
	listCalls: 0,
	navigate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
	/** The member branch panel's own data (Fizzy #2738 spec §10 "Tab"); empty unless a test needs it. */
	branches: [] as Array<Record<string, unknown>>,
	/**
	 * Spy on the `myBranch` queryFn — a reviewer panel now takes its owner's
	 * view straight off `state.branchOwners` via `data`, never through this
	 * query (round-3 finding: duplicate queries), so an integration test can
	 * assert it only ever runs once, for the caller's own ownerless panel.
	 */
	myBranchQueryFn: vi.fn(),
	/**
	 * `proposals.branches`'s answer, one page at a time: every OTHER member
	 * with a tracked branch, for a reviewer — independent of `state.rows`'
	 * own pagination (Fizzy #2738 spec §10 "Reviewers see every member's
	 * branches read-only"). Each entry already carries its full per-owner
	 * view (`branch`/`liveChanges`/`files`/`branches`), exactly the shape
	 * `InstructionProposalBranchPanel` takes as `data` — the aggregate read
	 * builds it once, reviewer-side, so the panel never re-queries
	 * `myBranch({userId})` for it (round-3 finding: duplicate queries).
	 * `branchOwnersPageSize` bounds how many of these one page returns,
	 * cursor-keyed on `userId` — a test proving pagination sets it below
	 * `branchOwners.length`; every other test leaves it large enough that
	 * everything comes back on page one, same as before this finding.
	 */
	branchOwners: [] as Array<Record<string, unknown> & { userId: string }>,
	branchOwnersPageSize: Number.POSITIVE_INFINITY,
	branchOwnersError: null as Error | null,
	retryConflict: vi.fn(),
	retryConflictError: null as Error | null,
	proposeAgain: vi.fn(),
	proposeAgainError: null as Error | null,
	closeBranch: vi.fn(),
	refreshBranch: vi.fn(),
	startOverBranch: vi.fn(),
	retryBranch: vi.fn(),
	stopTrackingBranch: vi.fn(),
	branchCommandError: null as Error | null,
}));

function queryOptions(name: string, getData: (input: unknown) => unknown) {
	return ({ input }: { input: unknown }) => ({
		queryKey: [name, input],
		queryFn: async () => {
			if (name === "list") {
				state.listCalls += 1;
			}
			if (state.listError && name === "list") {
				throw state.listError;
			}
			return getData(input);
		},
	});
}

/**
 * `proposals.branches`'s bounded page for one cursor: `state.branchOwners`
 * ordered by `userId`, sliced to `state.branchOwnersPageSize` starting after
 * `cursor`, with `nextCursor` set only when more remain — the same shape the
 * real cursor-paginated procedure answers.
 */
function branchOwnersPage(input: unknown): {
	owners: Array<Record<string, unknown>>;
	nextCursor: string | null;
} {
	const cursor = (input as { cursor?: string } | undefined)?.cursor;
	const all = state.branchOwners;
	const startIndex = cursor
		? all.findIndex((owner) => owner.userId === cursor) + 1
		: 0;
	const pageSize = state.branchOwnersPageSize;
	const owners = all.slice(startIndex, startIndex + pageSize);
	const nextCursor =
		startIndex + pageSize < all.length
			? (owners.at(-1)?.userId ?? null)
			: null;
	return { owners, nextCursor };
}

function mutationOptions(fn: (input: unknown) => Promise<unknown>) {
	return (
		options: Record<string, ((...args: never[]) => void) | undefined> = {},
	) => ({
		mutationFn: fn,
		...options,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getPublished: {
					queryOptions: queryOptions("published", () => null),
				},
				proposals: {
					list: {
						key: () => ["list"],
						queryOptions: queryOptions("list", () => ({
							items: state.rows,
							nextCursor: state.nextCursor,
						})),
					},
					get: {
						key: () => ["get"],
						queryOptions: queryOptions("get", () => state.detail),
					},
					file: {
						queryOptions: queryOptions(
							"file",
							() => state.filePage,
						),
					},
					approve: {
						mutationOptions: mutationOptions(async (input) => {
							state.approve(input);
							if (state.approveError) {
								throw state.approveError;
							}
							return {
								approved: true,
								published: true,
								version: 8,
							};
						}),
					},
					reject: {
						mutationOptions: mutationOptions(async (input) => {
							state.reject(input);
							return { rejected: true };
						}),
					},
					cancel: {
						mutationOptions: mutationOptions(async (input) => {
							state.cancel(input);
							return {
								canceled: true,
								pullRequest: state.cancelPullRequest,
							};
						}),
					},
					refreshPullRequest: {
						mutationOptions: mutationOptions(async (input) => {
							state.refresh(input);
							if (state.refreshError) {
								throw state.refreshError;
							}
							return { refreshed: true };
						}),
					},
					myBranch: {
						key: () => ["myBranch"],
						queryOptions: queryOptions("myBranch", (input) => {
							state.myBranchQueryFn(input);
							return {
								branch: state.branches[0] ?? null,
								liveChanges: 0,
								files: [],
								branches: state.branches,
							};
						}),
					},
					/**
					 * `infiniteOptions`, written out rather than stubbed, the
					 * same technique `TodoListPage.test.tsx` uses: `queryKey`
					 * carries `input(pageParam)` so a cursor change is a
					 * DIFFERENT key (an append via `fetchNextPage`, not a
					 * fresh page-1 list), and `queryFn` receives the live
					 * `pageParam` TanStack Query is asking for.
					 */
					branches: {
						key: () => ["branches"],
						infiniteOptions: (options: {
							input: (cursor: string | undefined) => unknown;
							initialPageParam: string | undefined;
							getNextPageParam: (lastPage: {
								nextCursor: string | null;
							}) => unknown;
						}) => ({
							queryKey: [
								"branches",
								{
									input: options.input(
										options.initialPageParam,
									),
									type: "infinite",
								},
							],
							queryFn: async ({
								pageParam,
							}: {
								pageParam: string | undefined;
							}) => {
								if (state.branchOwnersError) {
									throw state.branchOwnersError;
								}
								return branchOwnersPage(
									options.input(pageParam),
								);
							},
							initialPageParam: options.initialPageParam,
							getNextPageParam: options.getNextPageParam,
						}),
					},
					retryConflict: {
						mutationOptions: mutationOptions(async (input) => {
							state.retryConflict(input);
							if (state.retryConflictError) {
								throw state.retryConflictError;
							}
							return { state: "QUEUED", attempt: 1 };
						}),
					},
					proposeAgain: {
						mutationOptions: mutationOptions(async (input) => {
							state.proposeAgain(input);
							if (state.proposeAgainError) {
								throw state.proposeAgainError;
							}
							return { branchId: "branch_1", sequence: 2 };
						}),
					},
					closeBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.closeBranch(input);
							if (state.branchCommandError) {
								throw state.branchCommandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
					refreshBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.refreshBranch(input);
							if (state.branchCommandError) {
								throw state.branchCommandError;
							}
							return { refreshed: true, pending: false };
						}),
					},
					startOverBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.startOverBranch(input);
							if (state.branchCommandError) {
								throw state.branchCommandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
					retryBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.retryBranch(input);
							if (state.branchCommandError) {
								throw state.branchCommandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
					stopTrackingBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.stopTrackingBranch(input);
							if (state.branchCommandError) {
								throw state.branchCommandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
				},
				finalize: {
					mutationOptions: mutationOptions(async (input) => {
						state.finalize(input);
						return { status: "VALIDATING" };
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => state.toastSuccess(...a),
		error: (...a: unknown[]) => state.toastError(...a),
		info: (...a: unknown[]) => state.toastInfo(...a),
	},
}));

vi.mock("../../settings-tab-navigation", () => ({
	navigateToProjectSettingsTab: (...a: unknown[]) => state.navigate(...a),
}));

// The app's confirmation dialog is mounted once in the (saas) layout and is
// absent here. `confirmMock` records what each action asked and, unless a test
// says otherwise, confirms, as pressing the dialog's button would.
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

import { InstructionProposals } from "../InstructionProposals";

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "proposal-8",
		version: 8,
		baseVersion: 7,
		status: "READY",
		proposalStatus: "PENDING",
		createdAt: new Date(),
		readyAt: new Date(),
		proposer: { id: "reader", name: "Reader" },
		reviewer: null,
		reviewedAt: null,
		isStale: false,
		canCancel: false,
		isProposer: false,
		...overrides,
	};
}

/**
 * One `state.branchOwners` entry: `proposals.branches`' per-owner view,
 * already the exact shape `InstructionProposalBranchPanel` takes as `data` —
 * `userId`/`userName` plus its full `branch`/`liveChanges`/`files`/`branches`
 * (round-3 finding: the panel never re-queries `myBranch({userId})` for it).
 */
function branchOwner(
	userId: string,
	userName: string | null,
	entries: Array<{ branch: Record<string, unknown>; liveChanges: number }>,
) {
	return {
		userId,
		userName,
		branch: entries[0]?.branch ?? null,
		liveChanges: entries[0]?.liveChanges ?? 0,
		files: [],
		branches: entries,
	};
}

beforeEach(() => {
	confirmMock.mockReset();
	confirmMock.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
	state.rows = [row()];
	state.detail = {
		...row(),
		changes: [
			{
				path: "CLAUDE.md",
				op: "edit",
				before: "# Before",
				after: "# After",
				binary: false,
				beforeOmitted: null,
				afterOmitted: null,
				beforeSize: 8,
				afterSize: 7,
			},
		],
	};
	state.listError = null;
	state.filePage = null;
	state.nextCursor = null;
	state.approve.mockReset();
	state.reject.mockReset();
	state.cancel.mockReset();
	state.approveError = null;
	state.cancelPullRequest = null;
	state.refresh.mockReset();
	state.refreshError = null;
	state.finalize.mockReset();
	state.listCalls = 0;
	state.branches = [];
	state.myBranchQueryFn.mockReset();
	state.branchOwners = [];
	state.branchOwnersPageSize = Number.POSITIVE_INFINITY;
	state.branchOwnersError = null;
	state.retryConflict.mockReset();
	state.retryConflictError = null;
	state.proposeAgain.mockReset();
	state.proposeAgainError = null;
	state.closeBranch.mockReset();
	state.startOverBranch.mockReset();
	state.retryBranch.mockReset();
	state.stopTrackingBranch.mockReset();
	state.branchCommandError = null;
	state.navigate.mockReset();
	state.toastSuccess.mockReset();
	state.toastError.mockReset();
	state.toastInfo.mockReset();
});

describe("InstructionProposals", () => {
	it("shows a validated before-and-after diff and approves it", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={onChanged}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		// A unified diff, not two panes: the removed line carries a "-"
		// gutter and the added line a "+".
		expect(await screen.findByText("- # Before")).toBeInTheDocument();
		expect(screen.getByText("+ # After")).toBeInTheDocument();
		expect(screen.getByText("+1 −1")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Approve and publish" }),
		);

		await waitFor(() =>
			expect(state.approve).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			}),
		);
		expect(onChanged).toHaveBeenCalled();
	});

	it("asks in the app's own dialog, destructively, before rejecting a proposal", async () => {
		const user = userEvent.setup();
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		await user.click(await screen.findByRole("button", { name: "Reject" }));

		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.rejectConfirmTitle,
				message: reviewCopy.rejectConfirmBody,
				confirmLabel: reviewCopy.reject,
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(state.reject).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			}),
		);
	});

	it("rejects nothing when the dialog is dismissed", async () => {
		confirmMock.mockImplementation(() => undefined);
		const user = userEvent.setup();
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		await user.click(await screen.findByRole("button", { name: "Reject" }));

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(state.reject).not.toHaveBeenCalled();
	});

	it("withholds review actions for a stale proposal", async () => {
		const user = userEvent.setup();
		state.rows = [row({ isStale: true })];
		state.detail = { ...row({ isStale: true }), changes: [] };
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The published version changed after this proposal was submitted",
		);
		expect(
			screen.queryByRole("button", { name: "Approve and publish" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Reject" }),
		).toBeInTheDocument();
	});

	it("keeps review actions unavailable while validation is still running", async () => {
		const user = userEvent.setup();
		state.rows = [row({ status: "VALIDATING" })];
		state.detail = { ...row({ status: "VALIDATING" }), changes: null };
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByText(/The proposal is still being checked/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Approve and publish" }),
		).toBeNull();
	});

	it("shows an error when the proposal list cannot be loaded", async () => {
		state.listError = new Error("offline");
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load proposals",
		);
	});

	it("shows explicit notice when text is omitted by the response budget", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "large.md",
					op: "add",
					before: null,
					after: null,
					binary: false,
					beforeOmitted: null,
					afterOmitted: "FILE_TOO_LARGE",
					beforeSize: null,
					afterSize: 300_000,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Some file text is not shown here",
		);
		expect(
			screen.getByText("This side is too large to show inline."),
		).toBeInTheDocument();
	});

	it("loads an omitted side through the paged reviewer file endpoint", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "large.md",
					op: "add",
					before: null,
					after: null,
					binary: false,
					beforeOmitted: null,
					afterOmitted: "FILE_TOO_LARGE",
					beforeSize: null,
					afterSize: 300_000,
				},
			],
		};
		state.filePage = {
			path: "large.md",
			side: "after",
			body: "paged body",
			offset: 0,
			nextOffset: null,
			truncated: false,
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		await user.click(
			screen.getByRole("button", { name: "View full text" }),
		);
		expect(await screen.findByText("paged body")).toBeInTheDocument();
	});

	it("clears the selected detail when moving to another proposal page", async () => {
		const user = userEvent.setup();
		state.nextCursor = "page-2";
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(await screen.findByText("- # Before")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Next" }));
		await waitFor(() =>
			expect(screen.queryByText("- # Before")).toBeNull(),
		);
	});

	it("clears an open file page when selecting a different proposal", async () => {
		const user = userEvent.setup();
		state.rows = [row(), row({ id: "proposal-9", version: 9 })];
		state.detail = {
			...row(),
			changes: [
				{
					path: "large.md",
					op: "add",
					before: null,
					after: null,
					binary: false,
					beforeOmitted: null,
					afterOmitted: "FILE_TOO_LARGE",
					beforeSize: null,
					afterSize: 300_000,
				},
			],
		};
		state.filePage = {
			path: "large.md",
			side: "after",
			body: "old proposal page",
			offset: 0,
			nextOffset: null,
			truncated: false,
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		await user.click(
			screen.getByRole("button", { name: "View full text" }),
		);
		expect(
			await screen.findByText("old proposal page"),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Proposal version 9" }),
		);
		await waitFor(() =>
			expect(screen.queryByText("old proposal page")).toBeNull(),
		);
	});

	it("refreshes proposal and published state after a stale approval conflict", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		state.approveError = new Error(
			"The published instructions changed. Resubmit this proposal.",
		);
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={onChanged}
			/>,
			{ wrapper: Wrapper },
		);
		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Approve and publish" }),
		);

		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(state.approve).toHaveBeenCalledOnce();
	});

	/**
	 * A reviewer decides on the CHANGE, not on two full files side by side.
	 * The review pane used to print both bodies whole, so a one-line edit in
	 * a 400-line rule file made the reviewer find the difference by eye.
	 */
	it("renders an added file as all + lines and never a before pane", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "notes.md",
					op: "add",
					before: null,
					after: "alpha\nbeta\n",
					binary: false,
					beforeOmitted: null,
					afterOmitted: null,
					beforeSize: null,
					afterSize: 11,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		const diff = await screen.findByText(/\+ alpha/);
		expect(diff).toHaveTextContent("+ beta");
		expect(diff.textContent).not.toContain("- ");
		expect(screen.getByText("+2 \u22120")).toBeInTheDocument();
		// No "Before"/"After" pane headings survive for a diffable change.
		expect(screen.queryByText("Before")).toBeNull();
		expect(screen.queryByText("After")).toBeNull();
	});

	it("renders a deleted file as all \u2212 lines", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "notes.md",
					op: "delete",
					before: "alpha\nbeta\n",
					after: null,
					binary: false,
					beforeOmitted: null,
					afterOmitted: null,
					beforeSize: 11,
					afterSize: null,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		const diff = await screen.findByText(/- alpha/);
		expect(diff).toHaveTextContent("- beta");
		expect(diff.textContent).not.toContain("+ ");
		expect(screen.getByText("+0 \u22122")).toBeInTheDocument();
	});

	/**
	 * An absent side and an EMPTY side are not the same thing. Treating both
	 * as "" made an added or deleted empty file report that its text "did not
	 * change" — the opposite of what the proposal does to it.
	 */
	it.each([
		["add", null, ""],
		["delete", "", null],
	] as const)(
		"says an empty file is empty rather than unchanged for an %s",
		async (op, before, after) => {
			const user = userEvent.setup();
			state.detail = {
				...row(),
				changes: [
					{
						path: "placeholder.md",
						op,
						before,
						after,
						binary: false,
						beforeOmitted: null,
						afterOmitted: null,
						beforeSize: before === null ? null : 0,
						afterSize: after === null ? null : 0,
					},
				],
			};
			render(
				<InstructionProposals
					projectId="p"
					open
					onOpenChange={() => undefined}
					onChanged={() => undefined}
				/>,
				{ wrapper: Wrapper },
			);

			await user.click(
				await screen.findByRole("button", {
					name: "Proposal version 8",
				}),
			);
			expect(
				await screen.findByText("This file is empty."),
			).toBeInTheDocument();
			expect(
				screen.queryByText("The text of this file did not change."),
			).toBeNull();
		},
	);

	it("still reports two present, equal sides as unchanged text", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "mode-only.md",
					op: "edit",
					before: "# Same\n",
					after: "# Same\n",
					binary: false,
					beforeOmitted: null,
					afterOmitted: null,
					beforeSize: 7,
					afterSize: 7,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByText("The text of this file did not change."),
		).toBeInTheDocument();
		expect(screen.queryByText("This file is empty.")).toBeNull();
	});

	/**
	 * `diffLines` leaves the terminating newline on the part that owns the
	 * line, so a file whose last line has none yields parts that do not close
	 * themselves. Concatenated, the removed and added line ran together as
	 * one row showing text present in neither version.
	 */
	it("keeps a changed final line without a trailing newline on its own row", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "no-newline.md",
					op: "edit",
					before: "old",
					after: "new",
					binary: false,
					beforeOmitted: null,
					afterOmitted: null,
					beforeSize: 3,
					afterSize: 3,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		// The whole <pre>, not the one span: the defect was the two spans
		// running together, which only the concatenation shows.
		const pre = (await screen.findByText(/- old/)).closest("pre");
		expect(pre?.textContent).toBe("- old\n+ new");
		expect(pre?.textContent).not.toContain("- old+ new");
	});

	it("keeps the binary message instead of diffing bytes", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: [
				{
					path: "logo.png",
					op: "edit",
					before: null,
					after: null,
					binary: true,
					beforeOmitted: "BINARY",
					afterOmitted: "BINARY",
					beforeSize: 90,
					afterSize: 120,
				},
			],
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByText(
				"This binary file changed. Download the applicable version to inspect it.",
			),
		).toBeInTheDocument();
		// A binary change has no line count to claim.
		expect(screen.queryByText(/^\+\d+ \u2212\d+$/)).toBeNull();
	});

	/**
	 * A large proposal opens as a list of what it touches rather than a wall
	 * of diffs the approve/reject buttons sit below.
	 */
	it("starts a large proposal collapsed and expands one section on demand", async () => {
		const user = userEvent.setup();
		state.detail = {
			...row(),
			changes: Array.from({ length: 6 }, (_, index) => ({
				path: `file-${index}.md`,
				op: "edit" as const,
				before: `old ${index}\n`,
				after: `new ${index}\n`,
				binary: false,
				beforeOmitted: null,
				afterOmitted: null,
				beforeSize: 6,
				afterSize: 6,
			})),
		};
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByRole("button", { name: /file-0\.md/ }),
		).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("- old 0")).toBeNull();
		// The header still says how big each change is without opening it.
		expect(screen.getAllByText("+1 \u22121")).toHaveLength(6);

		await user.click(screen.getByRole("button", { name: /file-0\.md/ }));
		expect(await screen.findByText("- old 0")).toBeInTheDocument();
		expect(screen.queryByText("- old 1")).toBeNull();
	});

	it("lets a reader cancel their own stable proposal without loading its diff", async () => {
		const user = userEvent.setup();
		state.rows = [row({ status: "FAILED", canCancel: true })];
		render(
			<InstructionProposals
				projectId="p"
				open
				canReview={false}
				onOpenChange={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(
			await screen.findByRole("button", { name: "Cancel proposal" }),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.cancelConfirmTitle,
				message: reviewCopy.cancelConfirmBody,
				confirmLabel: reviewCopy.cancel,
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(state.cancel).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// A suggestion that opens a pull request (Fizzy #2563 spec §12)
// ---------------------------------------------------------------------------

const prCopy = en.projects.codingInstructions.proposalReview.pullRequest;
/** The Refresh button while it is held, as it reads to a screen reader. */
function refreshIn(seconds: number) {
	return prCopy.refreshIn.replace("{seconds}", String(seconds));
}
const reviewCopy = en.projects.codingInstructions.proposalReview;

type Failure = {
	phase: string;
	code: string;
	retryable: boolean;
	at: string;
	params: Record<string, unknown>;
};

function prFailure(code: string, overrides: Partial<Failure> = {}): Failure {
	return {
		phase: "create",
		code,
		retryable: true,
		at: new Date().toISOString(),
		params: {},
		...overrides,
	};
}

function pullRequest(overrides: Record<string, unknown> = {}) {
	return {
		operationId: "op_1",
		state: "QUEUED",
		url: null,
		externalId: null,
		failure: null,
		lastCheckedAt: null,
		attempt: 3,
		observation: null,
		mergeSync: null,
		...overrides,
	};
}

function repositoryRow(
	pr: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
) {
	return row({
		destination: "REPOSITORY",
		note: { title: "Tighten the lint rule" },
		pullRequest: pullRequest(pr),
		...overrides,
	});
}

function renderList(props: Record<string, unknown> = {}) {
	const onOpenChange = vi.fn();
	render(
		<InstructionProposals
			projectId="p"
			open
			onOpenChange={onOpenChange}
			onChanged={() => undefined}
			canReview={false}
			repositoryBacked
			{...props}
		/>,
		{ wrapper: Wrapper },
	);
	return { onOpenChange };
}

async function tick(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	// React Query batches its notifications on a zero-delay timer, which the
	// fake clock treats as one millisecond and only runs once moved again.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
}

describe("InstructionProposals — pull-request suggestions (Fizzy #2563 spec §12)", () => {
	it.each([
		[{ state: "QUEUED" }, "VALIDATING", prCopy.states.QUEUED],
		[{ state: "OPENING" }, "READY", prCopy.states.OPENING],
		[{ state: "OPEN" }, "READY", prCopy.states.OPEN],
		[{ state: "CLOSE_REQUESTED" }, "READY", prCopy.states.CLOSE_REQUESTED],
		[
			{ state: "BLOCKED", failure: prFailure("BRANCH_WRITE_REFUSED") },
			"READY",
			prCopy.states.BLOCKED,
		],
		[{ state: "MERGED" }, "READY", prCopy.states.MERGED],
		[
			{
				state: "MERGED",
				mergeSync: {
					requestedAt: new Date().toISOString(),
					runId: null,
					runStatus: null,
				},
			},
			"READY",
			prCopy.states.mergedSyncing,
		],
		[
			{
				state: "MERGED",
				mergeSync: {
					requestedAt: null,
					runId: "run_1",
					runStatus: "SUCCEEDED",
				},
			},
			"READY",
			prCopy.mergeSyncOutcomes.SUCCEEDED,
		],
		[
			{
				state: "MERGED",
				failure: prFailure("MERGE_SYNC_FAILED", {
					phase: "merge_sync",
					retryable: false,
				}),
			},
			"READY",
			prCopy.failures.MERGE_SYNC_FAILED,
		],
		[
			{
				state: "MERGED",
				observation: {
					targetRef: "release",
					targetMismatch: true,
					mergedAt: null,
					closedAt: null,
				},
			},
			"READY",
			"Merged into release, a different branch; Fabric did not sync it",
		],
		[{ state: "CLOSED" }, "READY", prCopy.states.CLOSED],
		[{ state: "CANCELED" }, "READY", prCopy.states.CANCELED],
		[
			{
				state: "CANCELED",
				failure: prFailure("VALIDATION_REJECTED", {
					phase: "validation",
					retryable: false,
				}),
			},
			"REJECTED",
			prCopy.states.rejectedByValidation,
		],
		[
			{
				state: "QUEUED",
				failure: prFailure("VALIDATION_FAILED", {
					phase: "validation",
				}),
			},
			"FAILED",
			prCopy.failures.VALIDATION_FAILED,
		],
	] as const)(
		"%#: shows the card state of %o",
		async (pr, status, expected) => {
			state.rows = [repositoryRow(pr, { status })];
			renderList();
			expect(await screen.findByText(expected)).toBeInTheDocument();
		},
	);

	it.each([...INSTRUCTION_PULL_REQUEST_FAILURE_CODES])(
		"shows a BLOCKED card's %s failure with its copy from en.json",
		async (code) => {
			state.rows = [
				repositoryRow({ state: "BLOCKED", failure: prFailure(code) }),
			];
			renderList();
			expect(
				await screen.findByText(
					prCopy.failures[code as keyof typeof prCopy.failures],
				),
			).toBeInTheDocument();
		},
	);

	it("links an open pull request and says when it was last checked", async () => {
		state.rows = [
			repositoryRow({
				state: "OPEN",
				url: "https://github.com/example-org/example-repo/pull/7",
				lastCheckedAt: new Date().toISOString(),
			}),
		];
		renderList();
		const link = await screen.findByRole("link", {
			name: prCopy.viewPullRequest,
		});
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/example-org/example-repo/pull/7",
		);
		expect(link).toHaveAttribute(
			"rel",
			expect.stringContaining("noopener"),
		);
		expect(screen.getByText(/^Checked /)).toBeInTheDocument();
	});

	it("shows the suggestion's title on its card", async () => {
		state.rows = [repositoryRow({ state: "OPEN" })];
		renderList();
		expect(
			await screen.findByText("Tighten the lint rule"),
		).toBeInTheDocument();
	});

	it("keeps polling an OPEN card until it shows MERGED and then the sync outcome", async () => {
		vi.useFakeTimers();
		try {
			state.rows = [repositoryRow({ state: "OPEN" })];
			renderList();
			await tick(0);
			expect(screen.getByText(prCopy.states.OPEN)).toBeInTheDocument();

			state.rows = [
				repositoryRow(
					{
						state: "MERGED",
						mergeSync: {
							requestedAt: new Date().toISOString(),
							runId: "run_1",
							runStatus: null,
						},
					},
					{ proposalStatus: "MERGED" },
				),
			];
			await tick(10_000);
			expect(
				screen.getByText(prCopy.states.mergedSyncing),
			).toBeInTheDocument();

			state.rows = [
				repositoryRow(
					{
						state: "MERGED",
						mergeSync: {
							requestedAt: null,
							runId: "run_1",
							runStatus: "SUCCEEDED",
						},
					},
					{ proposalStatus: "MERGED" },
				),
			];
			await tick(10_000);
			expect(
				screen.getByText(prCopy.mergeSyncOutcomes.SUCCEEDED),
			).toBeInTheDocument();

			// Settled: the list is not read again.
			const settled = state.listCalls;
			await tick(10_000);
			await tick(10_000);
			expect(state.listCalls).toBe(settled);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not poll a list of settled suggestions", async () => {
		vi.useFakeTimers();
		try {
			state.rows = [
				repositoryRow(
					{ state: "CLOSED" },
					{ proposalStatus: "CLOSED" },
				),
			];
			renderList();
			await tick(0);
			const first = state.listCalls;
			await tick(10_000);
			await tick(10_000);
			expect(state.listCalls).toBe(first);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-reads the suggestions, the branch view and the reviewer branches after a suggestion Refresh, and again once the backend settles", async () => {
		vi.useFakeTimers();
		const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
		try {
			state.rows = [repositoryRow({ state: "OPEN" })];
			renderList();
			await tick(0);
			await act(async () => {
				screen.getByRole("button", { name: prCopy.refresh }).click();
			});
			await tick(0);
			const invalidatedKeys = () =>
				invalidate.mock.calls.map(([filters]) =>
					JSON.stringify(filters?.queryKey),
				);
			for (const key of [
				'["list"]',
				'["get"]',
				'["myBranch"]',
				'["branches"]',
			]) {
				expect(invalidatedKeys()).toContain(key);
			}
			const afterAnswer = invalidate.mock.calls.length;
			await tick(3_000);
			expect(invalidate.mock.calls.length).toBeGreaterThan(afterAnswer);
		} finally {
			invalidate.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reads the suggestions again whenever the dialog opens, never serving the earlier read", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
		});
		const dialog = (open: boolean) => (
			<QueryClientProvider client={client}>
				<InstructionProposals
					projectId="p"
					open={open}
					onOpenChange={() => undefined}
					onChanged={() => undefined}
					canReview={false}
					repositoryBacked
				/>
			</QueryClientProvider>
		);
		const view = render(dialog(true));
		await waitFor(() => expect(state.listCalls).toBe(1));
		view.rerender(dialog(false));
		view.rerender(dialog(true));
		await waitFor(() => expect(state.listCalls).toBe(2));
		view.unmount();
		render(dialog(true));
		await waitFor(() => expect(state.listCalls).toBe(3));
	});

	// The server admits one Refresh per pull request a minute and answers
	// any other with TOO_MANY_REQUESTS; the button holds for the same minute
	// so a press it offers is one the server takes.
	it("refreshes an unsettled card, then holds Refresh for the server's one-minute ration", async () => {
		vi.useFakeTimers();
		try {
			state.rows = [repositoryRow({ state: "OPEN" })];
			renderList();
			await tick(0);
			const refresh = screen.getByRole("button", {
				name: prCopy.refresh,
			});
			await act(async () => {
				refresh.click();
			});
			await tick(0);
			expect(state.refresh).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			});
			// Held, and the button says for how long. The countdown sits
			// outside the card's live region, which carries only the status,
			// so a screen reader is not read a number every second.
			const held = screen.getByRole("button", { name: refreshIn(60) });
			expect(held).toBeDisabled();
			expect(held.closest("[aria-live]")).toBeNull();
			expect(
				screen.getByText(prCopy.states.OPEN).closest("[aria-live]"),
			).not.toBeNull();
			await tick(30_000);
			expect(
				screen.getByRole("button", { name: refreshIn(30) }),
			).toBeDisabled();
			await tick(30_000);
			expect(
				screen.getByRole("button", { name: prCopy.refresh }),
			).toBeEnabled();
		} finally {
			vi.useRealTimers();
		}
	});

	// The server is the boundary (spec §12). A refused Refresh
	// is TOO_MANY_REQUESTS with `retryAfter` in seconds, and the button
	// waits exactly that long, whether it is shorter than the client's own
	// hold (another tab pressed first) or longer (a provider's backoff).
	it.each([
		["PULL_REQUEST_REFRESH_COOLDOWN", 45],
		["PULL_REQUEST_PROVIDER_RATE_LIMITED", 150],
	] as const)(
		"waits out the server's %s refusal, counting its retryAfter down on the button",
		async (reason, retryAfter) => {
			vi.useFakeTimers();
			try {
				state.refreshError = Object.assign(
					new Error("Too many requests"),
					{
						code: "TOO_MANY_REQUESTS",
						data: { reason, retryAfter },
					},
				);
				state.rows = [repositoryRow({ state: "OPEN" })];
				renderList();
				await tick(0);
				await act(async () => {
					screen
						.getByRole("button", { name: prCopy.refresh })
						.click();
				});
				await tick(0);
				expect(state.toastError).toHaveBeenCalledWith(
					prCopy.refusals[reason].replace(
						"{seconds}",
						String(retryAfter),
					),
				);
				expect(
					screen.getByRole("button", { name: refreshIn(retryAfter) }),
				).toBeDisabled();
				await tick(1_000);
				expect(
					screen.getByRole("button", {
						name: refreshIn(retryAfter - 1),
					}),
				).toBeDisabled();
				await tick((retryAfter - 2) * 1_000);
				expect(
					screen.getByRole("button", { name: refreshIn(1) }),
				).toBeDisabled();
				await tick(1_000);
				expect(
					screen.getByRole("button", { name: prCopy.refresh }),
				).toBeEnabled();
			} finally {
				vi.useRealTimers();
			}
		},
	);

	// Phase C: a proposal the caller may not see (an invited guest who
	// neither proposed nor reviews it) answers NOT_FOUND on refresh, exactly
	// as a missing one does. The card treats it as absent: the same neutral
	// copy, and a re-read that drops it.
	it("treats a suggestion the server no longer shows as absent when refresh answers NOT_FOUND", async () => {
		const user = userEvent.setup();
		const notFound = Object.assign(new Error("Proposal not found"), {
			code: "NOT_FOUND",
		});
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("PR_CREATION_REFUSED", {
					retryable: false,
				}),
			}),
		];
		state.refreshError = notFound;
		state.refresh.mockImplementation(() => {
			state.rows = [];
		});
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.refresh }),
		);
		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				prCopy.refusals.NOT_FOUND,
			),
		);
		await waitFor(() =>
			expect(
				screen.queryByText(prCopy.states.blockedFinal),
			).not.toBeInTheDocument(),
		);
	});

	it("offers no Refresh on a settled card", async () => {
		state.rows = [
			repositoryRow({ state: "CLOSED" }, { proposalStatus: "CLOSED" }),
		];
		renderList();
		await screen.findByText(prCopy.states.CLOSED);
		expect(
			screen.queryByRole("button", { name: prCopy.refresh }),
		).not.toBeInTheDocument();
	});

	// #2563's Retry opening, for a suggestion on no branch, was retired with
	// that per-proposal path (Fizzy #2748): no failure such a card can show
	// offers it. A member branch's own Retry opening is the branch panel's.
	it.each([
		["PR_CREATION_REFUSED", false, prCopy.failures.PR_CREATION_REFUSED],
		["REMOTE_REF_CONFLICT", false, prCopy.failures.REMOTE_REF_CONFLICT],
		["CREATE_OUTCOME_UNKNOWN", false, prCopy.createOutcomeUnknownFinal],
		[
			"CREATE_OUTCOME_UNKNOWN",
			true,
			prCopy.failures.CREATE_OUTCOME_UNKNOWN,
		],
	] as const)(
		"offers no Retry opening on a suggestion on no branch, BLOCKED %s (retryable %s)",
		async (code, retryable, copy) => {
			state.rows = [
				repositoryRow({
					state: "BLOCKED",
					failure: prFailure(code, { retryable }),
				}),
			];
			renderList();
			await screen.findByText(copy);
			expect(
				screen.queryByRole("button", { name: /retry opening/i }),
			).not.toBeInTheDocument();
		},
	);

	it("offers Reconnect for an authentication failure and opens the repository settings", async () => {
		const user = userEvent.setup();
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("AUTHENTICATION_FAILED"),
			}),
		];
		const { onOpenChange } = renderList({ repositoryProvider: "GITHUB" });
		await user.click(
			await screen.findByRole("button", { name: prCopy.reconnect }),
		);
		expect(state.navigate).toHaveBeenCalledWith("p", "development");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("sends an Azure DevOps connection to its settings rather than promising a reconnect", async () => {
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("AUTHENTICATION_FAILED"),
			}),
		];
		renderList({ repositoryProvider: "AZURE_DEVOPS" });
		expect(
			await screen.findByRole("button", {
				name: prCopy.openRepositorySettings,
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: prCopy.reconnect }),
		).not.toBeInTheDocument();
	});

	it("runs the checks again from a QUEUED card whose validation could not finish", async () => {
		const user = userEvent.setup();
		state.rows = [
			repositoryRow(
				{
					state: "QUEUED",
					failure: prFailure("VALIDATION_FAILED", {
						phase: "validation",
					}),
				},
				{ status: "FAILED", canCancel: true },
			),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.tryAgain }),
		);
		await waitFor(() =>
			expect(state.finalize).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			}),
		);
	});

	it("withdraws a suggestion and says Fabric is closing its pull request", async () => {
		const user = userEvent.setup();
		state.cancelPullRequest = "close_requested";
		state.rows = [repositoryRow({ state: "OPEN" }, { canCancel: true })];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: reviewCopy.withdraw }),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.withdrawConfirmTitle,
				message: reviewCopy.withdrawConfirmBody,
				confirmLabel: reviewCopy.withdraw,
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith(
				reviewCopy.withdrawClosing,
			),
		);
	});

	it("offers no Withdraw on a card whose closing is already requested", async () => {
		state.rows = [
			repositoryRow(
				{
					state: "CLOSE_REQUESTED",
					failure: prFailure("CLOSE_REFUSED", { phase: "close" }),
				},
				{ canCancel: false },
			),
		];
		renderList();
		expect(
			await screen.findByText(prCopy.failures.CLOSE_REFUSED),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: reviewCopy.withdraw }),
		).not.toBeInTheDocument();
	});

	it("never offers Approve or Reject on a repository card, even to a reviewer", async () => {
		const user = userEvent.setup();
		state.rows = [repositoryRow({ state: "OPEN" })];
		state.detail = {
			...repositoryRow({ state: "OPEN" }),
			changes: [],
		};
		renderList({ canReview: true, canDecide: true });
		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByText(reviewCopy.repositoryProposalBody),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: reviewCopy.approve }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: reviewCopy.reject }),
		).not.toBeInTheDocument();
	});

	it("keeps Approve and Reject on a FABRIC card for a reviewer who may decide", async () => {
		const user = userEvent.setup();
		render(
			<InstructionProposals
				projectId="p"
				open
				onOpenChange={() => undefined}
				onChanged={() => undefined}
				canReview
				canDecide
			/>,
			{ wrapper: Wrapper },
		);
		await user.click(
			await screen.findByRole("button", { name: "Proposal version 8" }),
		);
		expect(
			await screen.findByRole("button", { name: reviewCopy.approve }),
		).toBeInTheDocument();
	});

	it("titles the dialog for suggestions on a repository-backed project", async () => {
		state.rows = [repositoryRow({ state: "OPEN" })];
		renderList();
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(reviewCopy.repositoryTitle),
		).toBeInTheDocument();
	});
});

describe("member proposal branches (Fizzy #2738 spec §10)", () => {
	const branchCopy = en.projects.codingInstructions.proposalReview.branch;
	const memberBranch = {
		id: "branch_1",
		ref: "fabric/instructions/members/reader-ab12/1",
	};

	it.each([
		["QUEUED", "READY", prCopy.states.queuedForBranch],
		["OPENING", "READY", prCopy.states.addingToBranch],
		["OPEN", "READY", prCopy.states.onBranch],
		["CLOSE_REQUESTED", "READY", prCopy.states.withdrawingFromBranch],
	] as const)(
		"a branch proposal's %s card reads %s, not the #2563 copy",
		async (prState, status, expected) => {
			state.rows = [
				repositoryRow(
					{ state: prState, branch: memberBranch },
					{ status },
				),
			];
			renderList();
			expect(await screen.findByText(expected)).toBeInTheDocument();
		},
	);

	it("a branch proposal's BLOCKED card shows only the failure's own sentence, with its paths, and offers Try again", async () => {
		const user = userEvent.setup();
		state.rows = [
			repositoryRow(
				{
					state: "BLOCKED",
					branch: memberBranch,
					failure: prFailure("BRANCH_CONFLICT", {
						phase: "append",
						retryable: false,
						params: { paths: "CLAUDE.md, AGENTS.md", count: 2 },
					}),
					attempt: 5,
				},
				{ canCancel: true },
			),
		];
		renderList();
		expect(
			await screen.findByText(
				"Files on your branch were changed outside Fabric: CLAUDE.md, AGENTS.md. Fabric does not overwrite them while this pull request is open. Make this change on your branch in the repository, or wait until the pull request merges.",
			),
		).toBeInTheDocument();
		// The generic v1 "Pull request not opened yet" headline never shows.
		expect(
			screen.queryByText(prCopy.states.BLOCKED),
		).not.toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: prCopy.tryAgain }),
		);
		await waitFor(() =>
			expect(state.retryConflict).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
				expectedAttempt: 5,
			}),
		);
	});

	it("offers no Try again for a branch failure that is not one of the conflict codes", async () => {
		state.rows = [
			repositoryRow(
				{
					state: "BLOCKED",
					branch: memberBranch,
					failure: prFailure("WITHDRAW_CONFLICT", {
						phase: "revert",
						retryable: false,
					}),
				},
				{ canCancel: true },
			),
		];
		renderList();
		await screen.findByText(prCopy.failures.WITHDRAW_CONFLICT);
		expect(
			screen.queryByRole("button", { name: prCopy.tryAgain }),
		).not.toBeInTheDocument();
	});

	it("reads CANCELED as already-on-branch or withdrawn-from-branch by the append's outcome", async () => {
		state.rows = [
			repositoryRow({
				state: "CANCELED",
				branch: memberBranch,
				append: {
					outcome: "already_on_branch",
					commitSha: null,
					membership: null,
				},
			}),
		];
		renderList();
		expect(
			await screen.findByText(prCopy.states.alreadyOnBranch),
		).toBeInTheDocument();
	});

	it("shows 'Withdrawn from your branch' once the change was appended before it was withdrawn", async () => {
		state.rows = [
			repositoryRow({
				state: "CANCELED",
				branch: memberBranch,
				append: {
					outcome: "appended",
					commitSha: "abc",
					membership: "included",
				},
			}),
		];
		renderList();
		expect(
			await screen.findByText(prCopy.states.withdrawnFromBranch),
		).toBeInTheDocument();
	});

	it("MERGED with an unverified append shows the unverified note and offers Propose again to its owner", async () => {
		const user = userEvent.setup();
		state.rows = [
			repositoryRow(
				{
					state: "MERGED",
					branch: memberBranch,
					append: {
						outcome: "appended",
						commitSha: "abc",
						membership: "unverified",
					},
				},
				// Production-consistent terminal row: `canCancel` is false
				// once the branch proposal's pull request has settled
				// (`proposalStatus` is then derived from `pullRequestState`,
				// never `PENDING`). "Propose again" is gated on `isProposer`
				// instead (Fizzy #2738 spec Decision 14), which stays true.
				{ canCancel: false, isProposer: true },
			),
		];
		renderList();
		expect(
			await screen.findByText(branchCopy.unverifiedNotice),
		).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", {
				name: branchCopy.proposeAgain,
			}),
		);
		await waitFor(() =>
			expect(state.proposeAgain).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
			}),
		);
	});

	it("offers no Propose again to a non-owner viewing another member's unverified branch proposal", async () => {
		state.rows = [
			repositoryRow(
				{
					state: "MERGED",
					branch: memberBranch,
					append: {
						outcome: "appended",
						commitSha: "abc",
						membership: "unverified",
					},
				},
				// A reviewer or another member sees the same terminal,
				// unverified row but is never its proposer.
				{ canCancel: false, isProposer: false },
			),
		];
		renderList({ canReview: true });
		expect(
			await screen.findByText(branchCopy.unverifiedNotice),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: branchCopy.proposeAgain }),
		).not.toBeInTheDocument();
	});

	it("offers no Propose again once the append is confirmed included", async () => {
		state.rows = [
			repositoryRow(
				{
					state: "MERGED",
					branch: memberBranch,
					append: {
						outcome: "appended",
						commitSha: "abc",
						membership: "included",
					},
				},
				{ canCancel: false, isProposer: true },
			),
		];
		renderList();
		await screen.findByText("Merged");
		expect(
			screen.queryByText(branchCopy.unverifiedNotice),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: branchCopy.proposeAgain }),
		).not.toBeInTheDocument();
	});

	it("confirms Withdraw with the pending-append text before a branch proposal has been added to the branch", async () => {
		const user = userEvent.setup();
		confirmMock.mockImplementation(() => undefined);
		state.rows = [
			repositoryRow(
				{ state: "QUEUED", branch: memberBranch, append: null },
				{ canCancel: true },
			),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: reviewCopy.withdraw }),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.withdrawConfirmTitle,
				message: branchCopy.withdrawConfirmPending,
				destructive: true,
			}),
		);
	});

	it("confirms Withdraw with the post-append text once the change is on the branch", async () => {
		const user = userEvent.setup();
		confirmMock.mockImplementation(() => undefined);
		state.rows = [
			repositoryRow(
				{
					state: "OPEN",
					branch: memberBranch,
					append: {
						outcome: "appended",
						commitSha: "abc",
						membership: "included",
					},
				},
				{ canCancel: true },
			),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: reviewCopy.withdraw }),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.withdrawConfirmTitle,
				message: branchCopy.withdrawConfirmAppended,
				destructive: true,
			}),
		);
	});

	it("still confirms Withdraw with the #2563 text for a non-branch repository proposal", async () => {
		const user = userEvent.setup();
		confirmMock.mockImplementation(() => undefined);
		state.rows = [repositoryRow({ state: "OPEN" }, { canCancel: true })];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: reviewCopy.withdraw }),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: reviewCopy.withdrawConfirmTitle,
				message: reviewCopy.withdrawConfirmBody,
				destructive: true,
			}),
		);
	});

	it("shows the 'Your branch' panel above the list once the member has a branch", async () => {
		state.branches = [
			{
				branch: {
					id: "branch_1",
					ref: "fabric/instructions/members/reader-ab12/1",
					state: "OPEN",
					foreignCommits: false,
					membership: "done",
					failure: null,
					retired: false,
					// Production never returns OPEN with no pull request:
					// the branch only reaches OPEN once one exists.
					pullRequest: {
						url: "https://github.com/example-org/example-repo/pull/9",
						externalId: "9",
						state: "OPEN",
						lastCheckedAt: new Date().toISOString(),
					},
				},
				liveChanges: 2,
			},
		];
		renderList();
		expect(
			await screen.findByText(
				"Branch fabric/instructions/members/reader-ab12/1",
			),
		).toBeInTheDocument();
	});

	/**
	 * Spec §10: "Reviewers see every member's branches read-only, with
	 * owner-or-reviewer visibility as `authorizedProposal`." The panel used
	 * to call `myBranch` with no `userId`, so a reviewer only ever saw their
	 * OWN branch (or none) — never the branches of the members whose
	 * proposals they were reviewing.
	 *
	 * Round 2 review finding: owner discovery then moved to deriving the
	 * distinct proposers from `state.rows`, capped at the proposal list's own
	 * page size — so a member whose proposals were not on the CURRENT page
	 * still got no panel. `proposals.branches` (`state.branchOwners` here) is
	 * a separate, reviewer-only aggregate read, independent of that
	 * pagination; these tests prove the panel now follows IT, not the rows.
	 *
	 * Round 3 review finding: that aggregate read used to load every tracked
	 * branch and cap the owner list at 50 in memory, with the cap's
	 * `truncated` flag never read by the UI — silently dropping the 51st
	 * owner. It is now cursor-paginated, bounded in the database, with a
	 * "Show more branches" button while `nextCursor` keeps coming back; the
	 * pagination and visible-error-state tests below cover that, and each
	 * owner's per-panel view now arrives pre-built as `data` rather than
	 * through a second, discarded `myBranch({userId})` query per panel
	 * (finding: duplicate queries).
	 */
	describe("reviewer visibility across members' branches", () => {
		it("shows another member's branch read-only beside the reviewer's own, even when that member has no proposal on the current page", async () => {
			// Deliberately NOT this member's proposal — a different row
			// entirely, proving the panel does not come from the visible
			// page of proposals.
			state.rows = [row({ id: "proposal-unrelated", version: 3 })];
			state.branchOwners = [
				branchOwner("member_2", "Case Worker", [
					{
						branch: {
							id: "branch_2",
							ref: "fabric/instructions/members/case-worker-cd34/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							failure: null,
							retired: false,
							// Production never returns OPEN with no pull
							// request: the branch only reaches OPEN once one
							// exists.
							pullRequest: {
								url: "https://github.com/example-org/example-repo/pull/9",
								externalId: "9",
								state: "OPEN",
								lastCheckedAt: new Date().toISOString(),
							},
						},
						liveChanges: 1,
					},
				]),
			];
			renderList({ canReview: true, repositoryBacked: true });
			expect(
				await screen.findByText(
					"Branch fabric/instructions/members/case-worker-cd34/1",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText("Case Worker's branch"),
			).toBeInTheDocument();
			// Read-only headline, never the owner's "Your branch's pull
			// request is open".
			expect(
				screen.getByText("The branch's pull request is open"),
			).toBeInTheDocument();
			// The panel rendered straight from `data` — never its own
			// `myBranch({userId})` query (round-3 finding: duplicate
			// queries). `repositoryBacked` also renders the caller's own
			// ownerless panel above it, which legitimately queries
			// `myBranch` once for ITS OWN branch — so proving no duplicate
			// per-owner query is exactly one call total, not zero.
			expect(state.myBranchQueryFn).toHaveBeenCalledTimes(1);
		});

		it("keeps re-reading another member's in-flight branch until it settles", async () => {
			// Reviewer panels render from the aggregate and never poll on
			// their own, so the aggregate itself must poll while a loaded
			// branch is still in flight.
			vi.useFakeTimers();
			try {
				const opening = {
					id: "branch_2",
					ref: "fabric/instructions/members/case-worker-cd34/1",
					state: "OPENING",
					foreignCommits: false,
					membership: null,
					failure: null,
					retired: false,
					pullRequest: null,
				};
				state.branchOwners = [
					branchOwner("member_2", "Case Worker", [
						{ branch: opening, liveChanges: 1 },
					]),
				];
				renderList({ canReview: true, repositoryBacked: true });
				await tick(0);
				expect(
					screen.getByText("Opening the branch's pull request"),
				).toBeInTheDocument();

				state.branchOwners = [
					branchOwner("member_2", "Case Worker", [
						{
							branch: {
								...opening,
								state: "MERGED",
								membership: "done",
								pullRequest: {
									url: "https://github.com/example-org/example-repo/pull/9",
									externalId: "9",
									state: "MERGED",
									lastCheckedAt: null,
								},
							},
							liveChanges: 0,
						},
					]),
				];
				await tick(10_000);
				expect(
					screen.queryByText("Opening the branch's pull request"),
				).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("shows no other member's branch panel for a non-reviewer, even when the aggregate would name one", async () => {
			state.branchOwners = [
				branchOwner("member_2", "Case Worker", [
					{
						branch: {
							id: "branch_2",
							ref: "fabric/instructions/members/case-worker-cd34/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							failure: null,
							retired: false,
							pullRequest: {
								url: "https://github.com/example-org/example-repo/pull/9",
								externalId: "9",
								state: "OPEN",
								lastCheckedAt: new Date().toISOString(),
							},
						},
						liveChanges: 1,
					},
				]),
			];
			renderList({ canReview: false, repositoryBacked: true });
			await screen.findByRole("button", { name: "Proposal version 8" });
			expect(
				screen.queryByText("Case Worker's branch"),
			).not.toBeInTheDocument();
		});

		it("renders no other member's branch panel when the reviewer aggregate names none", async () => {
			// The server already excludes the viewer's own branch from this
			// read (`readProposalBranchesForReviewer`), so an empty list here
			// is the ordinary case for a reviewer with no one else's branch
			// to show, including their own proposal rows.
			state.branchOwners = [];
			renderList({ canReview: true, repositoryBacked: true });
			await screen.findByRole("button", { name: "Proposal version 8" });
			expect(screen.queryByText(/'s branch$/)).not.toBeInTheDocument();
		});

		it("shows a visible error state when the reviewer aggregate read fails", async () => {
			state.branchOwnersError = new Error("offline");
			renderList({ canReview: true, repositoryBacked: true });
			await screen.findByRole("button", { name: "Proposal version 8" });
			expect(await screen.findByRole("alert")).toHaveTextContent(
				branchCopy.other.listLoadError,
			);
		});

		/**
		 * Round-3 MUST-FIX: the aggregate used to load every tracked branch
		 * and cap owners at 50 in memory, silently dropping the 51st. This
		 * proves the replacement instead — three owners, a page size of two —
		 * renders the first page, a "Show more branches" click loads the
		 * next, and every owner ends up on screen with none missing.
		 */
		it("pages through more owners than fit on one page with Show more branches, and drops none", async () => {
			state.branchOwnersPageSize = 2;
			state.branchOwners = [
				branchOwner("member_1", "Member One", [
					{
						branch: {
							id: "branch_1",
							ref: "fabric/instructions/members/member-one-aa11/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							failure: null,
							retired: false,
							pullRequest: {
								url: "https://github.com/example-org/example-repo/pull/21",
								externalId: "21",
								state: "OPEN",
								lastCheckedAt: null,
							},
						},
						liveChanges: 1,
					},
				]),
				branchOwner("member_2", "Member Two", [
					{
						branch: {
							id: "branch_2",
							ref: "fabric/instructions/members/member-two-bb22/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							failure: null,
							retired: false,
							pullRequest: {
								url: "https://github.com/example-org/example-repo/pull/22",
								externalId: "22",
								state: "OPEN",
								lastCheckedAt: null,
							},
						},
						liveChanges: 1,
					},
				]),
				branchOwner("member_3", "Member Three", [
					{
						branch: {
							id: "branch_3",
							ref: "fabric/instructions/members/member-three-cc33/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							failure: null,
							retired: false,
							pullRequest: {
								url: "https://github.com/example-org/example-repo/pull/23",
								externalId: "23",
								state: "OPEN",
								lastCheckedAt: null,
							},
						},
						liveChanges: 1,
					},
				]),
			];
			const user = userEvent.setup();
			renderList({ canReview: true, repositoryBacked: true });
			expect(
				await screen.findByText(
					"Branch fabric/instructions/members/member-one-aa11/1",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					"Branch fabric/instructions/members/member-two-bb22/1",
				),
			).toBeInTheDocument();
			expect(
				screen.queryByText(
					"Branch fabric/instructions/members/member-three-cc33/1",
				),
			).not.toBeInTheDocument();
			const showMore = screen.getByRole("button", {
				name: branchCopy.other.showMoreBranches,
			});
			await user.click(showMore);
			expect(
				await screen.findByText(
					"Branch fabric/instructions/members/member-three-cc33/1",
				),
			).toBeInTheDocument();
			// The first page's owners are still there — appended to, not
			// replaced.
			expect(
				screen.getByText(
					"Branch fabric/instructions/members/member-one-aa11/1",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					"Branch fabric/instructions/members/member-two-bb22/1",
				),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", {
					name: branchCopy.other.showMoreBranches,
				}),
			).not.toBeInTheDocument();
			// Every owner rendered from `data` — no panel fell back to its
			// own `myBranch({userId})` query; the caller's own ownerless
			// panel above them still queries once, for its own branch.
			expect(state.myBranchQueryFn).toHaveBeenCalledTimes(1);
		});

		it("refreshes the aggregate's other-member panels after Stop tracking on one of them", async () => {
			const user = userEvent.setup();
			state.branchOwners = [
				branchOwner("member_2", "Case Worker", [
					{
						branch: {
							id: "branch_2",
							ref: "fabric/instructions/members/case-worker-cd34/1",
							state: "OPEN",
							foreignCommits: false,
							membership: "done",
							// Stop tracking (Decision 19) is only offered on
							// REPOSITORY_CHANGED.
							failure: {
								code: "REPOSITORY_CHANGED",
								retryable: false,
							},
							retired: false,
							attempt: 3,
							pullRequest: null,
						},
						liveChanges: 1,
					},
				]),
			];
			renderList({ canReview: true, repositoryBacked: true });
			await user.click(
				await screen.findByRole("button", {
					name: branchCopy.stopTracking,
				}),
			);
			// `onChanged` fans out to `refreshState`, which refetches the
			// aggregate (`branchOwners.refetch()`) — proven here by the list
			// re-querying, since the mock's `queryFn` re-reads
			// `state.branchOwners` fresh each time.
			await waitFor(() =>
				expect(state.stopTrackingBranch).toHaveBeenCalled(),
			);
		});
	});
});
