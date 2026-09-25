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
	retry: vi.fn(),
	retryError: null as Error | null,
	refreshError: null as Error | null,
	finalize: vi.fn(),
	listCalls: 0,
	navigate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
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
						queryOptions: queryOptions("list", () => ({
							items: state.rows,
							nextCursor: state.nextCursor,
						})),
					},
					get: {
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
					retryPullRequest: {
						mutationOptions: mutationOptions(async (input) => {
							state.retry(input);
							if (state.retryError) {
								throw state.retryError;
							}
							return { retried: true };
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
		...overrides,
	};
}

beforeEach(() => {
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
	state.retry.mockReset();
	state.retryError = null;
	state.refreshError = null;
	state.finalize.mockReset();
	state.listCalls = 0;
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
		vi.spyOn(window, "confirm").mockReturnValue(true);
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
	// neither proposed nor reviews it) answers NOT_FOUND on refresh and
	// retry, exactly as a missing one does. The card treats it as absent:
	// the same neutral copy, and a re-read that drops it.
	it.each([["refresh"], ["retry"]] as const)(
		"treats a suggestion the server no longer shows as absent when %s answers NOT_FOUND",
		async (action) => {
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
			const gone = () => {
				state.rows = [];
			};
			if (action === "refresh") {
				state.refreshError = notFound;
				state.refresh.mockImplementation(gone);
			} else {
				state.retryError = notFound;
				state.retry.mockImplementation(gone);
			}
			renderList();
			await user.click(
				await screen.findByRole("button", {
					name:
						action === "refresh"
							? prCopy.refresh
							: prCopy.retryOpening,
				}),
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
			confirm.mockRestore();
		},
	);

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

	it("retries opening only after the confirmation, naming the attempt the card showed", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				attempt: 5,
				failure: prFailure("PR_CREATION_REFUSED", { retryable: false }),
			}),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.retryOpening }),
		);
		expect(confirm).toHaveBeenCalledWith(prCopy.retryConfirm);
		await waitFor(() =>
			expect(state.retry).toHaveBeenCalledWith({
				projectId: "p",
				snapshotId: "proposal-8",
				expectedAttempt: 5,
			}),
		);
		expect(state.toastSuccess).toHaveBeenCalledWith(prCopy.retrySuccess);
		confirm.mockRestore();
	});

	it("does not retry when the confirmation is declined", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("REMOTE_REF_CONFLICT", { retryable: false }),
			}),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.retryOpening }),
		);
		expect(state.retry).not.toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("offers no Retry opening while Fabric is still retrying by itself", async () => {
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("CREATE_OUTCOME_UNKNOWN", {
					retryable: true,
				}),
			}),
		];
		renderList();
		await screen.findByText(prCopy.failures.CREATE_OUTCOME_UNKNOWN);
		expect(
			screen.queryByRole("button", { name: prCopy.retryOpening }),
		).not.toBeInTheDocument();
	});

	it("re-reads and re-renders the card when a retry is refused because the pull request changed", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		state.retryError = Object.assign(new Error("changed"), {
			data: { reason: "PULL_REQUEST_CHANGED" },
		});
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("PR_CREATION_REFUSED", { retryable: false }),
			}),
		];
		// Someone else retried between the read and this request: the row is
		// OPENING at a newer attempt by the time the refusal comes back.
		state.retry.mockImplementation(() => {
			state.rows = [repositoryRow({ state: "OPENING", attempt: 4 })];
		});
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.retryOpening }),
		);
		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				prCopy.refusals.PULL_REQUEST_CHANGED,
			),
		);
		expect(
			await screen.findByText(prCopy.states.OPENING),
		).toBeInTheDocument();
		confirm.mockRestore();
	});

	it("names a busy or unstartable retry with its own copy", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		state.retryError = Object.assign(new Error("busy"), {
			data: { reason: "PULL_REQUEST_BUSY" },
		});
		state.rows = [
			repositoryRow({
				state: "BLOCKED",
				failure: prFailure("REMOTE_REF_CONFLICT", { retryable: false }),
			}),
		];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: prCopy.retryOpening }),
		);
		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				prCopy.refusals.PULL_REQUEST_BUSY,
			),
		);
		confirm.mockRestore();
	});

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
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		state.cancelPullRequest = "close_requested";
		state.rows = [repositoryRow({ state: "OPEN" }, { canCancel: true })];
		renderList();
		await user.click(
			await screen.findByRole("button", { name: reviewCopy.withdraw }),
		);
		expect(confirm).toHaveBeenCalledWith(reviewCopy.withdrawConfirm);
		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith(
				reviewCopy.withdrawClosing,
			),
		);
		confirm.mockRestore();
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
