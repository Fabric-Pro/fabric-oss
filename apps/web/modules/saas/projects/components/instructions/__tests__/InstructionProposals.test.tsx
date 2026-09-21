import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
}));

function queryOptions(name: string, getData: (input: unknown) => unknown) {
	return ({ input }: { input: unknown }) => ({
		queryKey: [name, input],
		queryFn: async () => {
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
							return { canceled: true };
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
