/**
 * "Your branch" panel (Fizzy #2738 spec §10 "Tab"): ref, pull-request
 * link/state/age, live change count, the foreign-commits and unverified
 * notices, failure copy, and the actions each branch state offers.
 *
 * Real `en.json` copy is resolved (not the key echoed back), the same
 * technique `InstructionFileView.test.tsx` uses, so the failure copy
 * assertions prove the panel reads `pullRequest.failures.*` rather than a
 * key under its own `branch` namespace.
 */
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
	branches: [] as Array<Record<string, unknown>>,
	listError: null as Error | null,
	/**
	 * Spy on the `myBranch` queryFn itself (round-3 finding: duplicate
	 * queries) — a read-only panel now takes its owner's view via `data`, so
	 * this must stay uncalled whenever `userId` is set, since `useQuery` is
	 * `enabled: !readOnly`.
	 */
	myBranchQueryFn: vi.fn(),
	close: vi.fn(),
	closeResult: { changed: true, attempt: 1 } as Record<string, unknown>,
	retry: vi.fn(),
	startOver: vi.fn(),
	stopTracking: vi.fn(),
	commandError: null as Error | null,
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
}));

function queryOptions(name: string) {
	return ({ input }: { input: unknown }) => ({
		queryKey: [name, input],
		queryFn: async () => {
			if (name === "myBranch") {
				state.myBranchQueryFn(input);
			}
			if (state.listError) {
				throw state.listError;
			}
			return {
				branch: state.branches[0] ?? null,
				liveChanges: 0,
				files: [],
				branches: state.branches,
			};
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
				proposals: {
					myBranch: { queryOptions: queryOptions("myBranch") },
					list: { queryOptions: queryOptions("list") },
					closeBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.close(input);
							if (state.commandError) {
								throw state.commandError;
							}
							return state.closeResult;
						}),
					},
					startOverBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.startOver(input);
							if (state.commandError) {
								throw state.commandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
					retryBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.retry(input);
							if (state.commandError) {
								throw state.commandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
					stopTrackingBranch: {
						mutationOptions: mutationOptions(async (input) => {
							state.stopTracking(input);
							if (state.commandError) {
								throw state.commandError;
							}
							return { changed: true, attempt: 1 };
						}),
					},
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

import { InstructionProposalBranchPanel } from "../InstructionProposalBranchPanel";

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

/**
 * Production never returns OPEN with no pull request: the branch only
 * reaches OPEN once one exists. So the default here fills one in whenever
 * the (possibly overridden) state is OPEN; a test that needs OPEN without
 * one overrides `pullRequest` explicitly, and any other state defaults to
 * none, same as before.
 */
function branch(overrides: Record<string, unknown> = {}) {
	const state = (overrides.state as string | undefined) ?? "OPEN";
	const defaultPullRequest =
		state === "OPEN"
			? {
					url: "https://github.com/example-org/example-repo/pull/9",
					externalId: "9",
					state: "OPEN",
					lastCheckedAt: new Date().toISOString(),
				}
			: null;
	return {
		id: "branch_1",
		ref: "fabric/instructions/members/reader-ab12/1",
		state: "OPEN",
		// Not a fresh branch's 0, so every command below proves it sends
		// the branch's own attempt as its fence.
		attempt: 7,
		foreignCommits: false,
		membership: "done",
		failure: null,
		retired: false,
		pullRequest: defaultPullRequest,
		...overrides,
	};
}

function renderPanel(props: Record<string, unknown> = {}) {
	const onChanged = vi.fn();
	render(
		<InstructionProposalBranchPanel
			projectId="p"
			onChanged={onChanged}
			{...props}
		/>,
		{ wrapper: Wrapper },
	);
	return { onChanged };
}

/** A reviewer panel's `data` prop: the aggregate's per-owner view shape. */
function ownerData(
	entries: Array<{ branch: Record<string, unknown>; liveChanges: number }>,
): Record<string, unknown> {
	return {
		branch: entries[0]?.branch ?? null,
		liveChanges: entries[0]?.liveChanges ?? 0,
		files: [],
		branches: entries,
	};
}

const branchCopy = en.projects.codingInstructions.proposalReview.branch;
const failureCopy =
	en.projects.codingInstructions.proposalReview.pullRequest.failures;

beforeEach(() => {
	state.branches = [{ branch: branch(), liveChanges: 3 }];
	state.listError = null;
	state.commandError = null;
	state.myBranchQueryFn.mockReset();
	state.close.mockReset();
	state.retry.mockReset();
	state.startOver.mockReset();
	state.stopTracking.mockReset();
	state.toastSuccess.mockReset();
	state.toastError.mockReset();
	state.toastInfo.mockReset();
});

describe("InstructionProposalBranchPanel", () => {
	it("renders nothing when the member has no branch", async () => {
		state.branches = [];
		const { container } = render(
			<InstructionProposalBranchPanel projectId="p" />,
			{ wrapper: Wrapper },
		);
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});

	it("shows the ref and the live change count", async () => {
		renderPanel();
		expect(
			await screen.findByText(
				"Branch fabric/instructions/members/reader-ab12/1",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Live changes: 3")).toBeInTheDocument();
	});

	it("links the pull request and shows when it was last checked", async () => {
		state.branches = [
			{
				branch: branch({
					pullRequest: {
						url: "https://github.com/example-org/example-repo/pull/9",
						externalId: "9",
						state: "OPEN",
						lastCheckedAt: new Date().toISOString(),
					},
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		const link = await screen.findByRole("link", {
			name: branchCopy.viewPullRequest,
		});
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/example-org/example-repo/pull/9",
		);
		expect(link).toHaveAttribute(
			"rel",
			expect.stringContaining("noopener"),
		);
		expect(screen.getByText(/^Checked /)).toBeInTheDocument();
	});

	it("shows the foreign-commits and unverified notices", async () => {
		state.branches = [
			{
				branch: branch({
					foreignCommits: true,
					membership: "unverified",
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		expect(
			await screen.findByText(branchCopy.foreignCommitsNotice),
		).toBeInTheDocument();
		expect(
			screen.getByText(branchCopy.unverifiedNotice),
		).toBeInTheDocument();
	});

	it("shows a branch failure from the shared pullRequest.failures copy, not a branch-local key", async () => {
		state.branches = [
			{
				branch: branch({
					state: "BLOCKED",
					failure: { code: "BRANCH_WRITE_REFUSED", retryable: true },
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		expect(
			await screen.findByText(failureCopy.BRANCH_WRITE_REFUSED),
		).toBeInTheDocument();
	});

	it("offers Close, confirms with the live change count, and calls closeBranch", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		const { onChanged } = renderPanel();
		await user.click(
			await screen.findByRole("button", { name: branchCopy.close }),
		);
		expect(confirm).toHaveBeenCalledWith(
			"Fabric closes the pull request and withdraws its 3 changes. It deletes the branch only if Fabric made every commit on it.",
		);
		await waitFor(() =>
			expect(state.close).toHaveBeenCalledWith({
				projectId: "p",
				branchId: "branch_1",
				expectedAttempt: 7,
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		confirm.mockRestore();
	});

	it.each([
		{
			label: "Close",
			failure: null,
			button: branchCopy.close,
			command: () => state.close,
		},
		{
			label: "Retry opening",
			failure: { code: "PR_CREATION_REFUSED", retryable: false },
			button: branchCopy.retryOpening,
			command: () => state.retry,
		},
		{
			label: "Start over",
			failure: { code: "CREATE_OUTCOME_UNKNOWN", retryable: false },
			button: branchCopy.startOver,
			command: () => state.startOver,
		},
		{
			label: "Stop tracking",
			failure: { code: "REPOSITORY_CHANGED", retryable: false },
			button: branchCopy.stopTracking,
			command: () => state.stopTracking,
		},
	])(
		"$label toasts the translated line for the error's code, never the server's message",
		async ({ failure, button, command }) => {
			state.branches = [
				{
					branch: branch(
						failure === null ? {} : { state: "BLOCKED", failure },
					),
					liveChanges: 1,
				},
			];
			state.commandError = Object.assign(
				new Error("Upstream said: provider detail"),
				{ code: "CONFLICT" },
			);
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
			renderPanel();
			await user.click(
				await screen.findByRole("button", { name: button }),
			);

			await waitFor(() =>
				expect(state.toastError).toHaveBeenCalledWith(
					en.projects.codingInstructions.actionErrors.conflict,
				),
			);
			expect(command()).toHaveBeenCalled();
			expect(state.toastError).not.toHaveBeenCalledWith(
				"Upstream said: provider detail",
			);
			confirm.mockRestore();
		},
	);

	it("offers Retry opening only on PR_CREATION_REFUSED", async () => {
		state.branches = [
			{
				branch: branch({
					state: "BLOCKED",
					failure: { code: "PR_CREATION_REFUSED", retryable: false },
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		expect(
			await screen.findByRole("button", {
				name: branchCopy.retryOpening,
			}),
		).toBeInTheDocument();
	});

	it("offers no Retry opening for a different failure", async () => {
		state.branches = [
			{
				branch: branch({
					state: "BLOCKED",
					failure: { code: "BRANCH_WRITE_REFUSED", retryable: true },
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		await screen.findByText(failureCopy.BRANCH_WRITE_REFUSED);
		expect(
			screen.queryByRole("button", { name: branchCopy.retryOpening }),
		).not.toBeInTheDocument();
	});

	it("offers Start over only on a non-retryable CREATE_OUTCOME_UNKNOWN", async () => {
		state.branches = [
			{
				branch: branch({
					state: "BLOCKED",
					failure: {
						code: "CREATE_OUTCOME_UNKNOWN",
						retryable: false,
					},
				}),
				liveChanges: 2,
			},
		];
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPanel();
		await user.click(
			await screen.findByRole("button", { name: branchCopy.startOver }),
		);
		await waitFor(() =>
			expect(state.startOver).toHaveBeenCalledWith({
				projectId: "p",
				branchId: "branch_1",
				expectedAttempt: 7,
			}),
		);
		confirm.mockRestore();
	});

	it("offers no Start over when the CREATE_OUTCOME_UNKNOWN failure is still retryable", async () => {
		state.branches = [
			{
				branch: branch({
					state: "BLOCKED",
					failure: {
						code: "CREATE_OUTCOME_UNKNOWN",
						retryable: true,
					},
				}),
				liveChanges: 1,
			},
		];
		renderPanel();
		await screen.findByText(
			"Fabric is checking whether the pull request was created.",
		);
		expect(
			screen.queryByRole("button", { name: branchCopy.startOver }),
		).not.toBeInTheDocument();
	});

	it("offers Stop tracking only on REPOSITORY_CHANGED", async () => {
		state.branches = [
			{
				branch: branch({
					failure: { code: "REPOSITORY_CHANGED", retryable: false },
				}),
				liveChanges: 1,
			},
		];
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPanel();
		await user.click(
			await screen.findByRole("button", {
				name: branchCopy.stopTracking,
			}),
		);
		await waitFor(() =>
			expect(state.stopTracking).toHaveBeenCalledWith({
				projectId: "p",
				branchId: "branch_1",
				expectedAttempt: 7,
			}),
		);
		confirm.mockRestore();
	});

	it("Refresh re-reads the branch", async () => {
		const user = userEvent.setup();
		renderPanel();
		const refreshButton = await screen.findByRole("button", {
			name: new RegExp(branchCopy.refresh),
		});
		await user.click(refreshButton);
		await waitFor(() =>
			expect(state.toastInfo).toHaveBeenCalledWith(
				branchCopy.refreshSuccess,
			),
		);
	});

	it("shows a load error and no crash on a failed read", async () => {
		state.listError = new Error("offline");
		renderPanel();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			branchCopy.loadError,
		);
	});

	/**
	 * A reviewer's read-only instance of another member's branch (Fizzy #2738
	 * spec §10: "Reviewers see every member's branches read-only, with
	 * owner-or-reviewer visibility as `authorizedProposal`"). Since round 3,
	 * this is driven entirely by the `data`/`isLoading`/`isError` props the
	 * reviewer aggregate read already fetched — the panel's own `myBranch`
	 * query is `enabled: !readOnly`, so it never runs for these (round-3
	 * finding: duplicate queries).
	 */
	describe("a reviewer's read-only view of another member's branch", () => {
		beforeEach(() => {
			state.branches = [];
		});

		it("names the member, shows the ref and state read-only, and never says 'your'", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([
					{ branch: branch({ state: "OPEN" }), liveChanges: 2 },
				]),
			});
			expect(
				await screen.findByText(
					"Branch fabric/instructions/members/reader-ab12/1",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText("Case Worker's branch"),
			).toBeInTheDocument();
			// The read-only headline, never the owner's "Your branch's pull
			// request is open".
			expect(
				screen.getByText("The branch's pull request is open"),
			).toBeInTheDocument();
			expect(
				screen.queryByText(branchCopy.states.OPEN),
			).not.toBeInTheDocument();
		});

		it("de-personalizes the foreign-commits notice", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([
					{
						branch: branch({ foreignCommits: true }),
						liveChanges: 1,
					},
				]),
			});
			expect(
				await screen.findByText(
					"This branch has commits made outside Fabric",
				),
			).toBeInTheDocument();
			expect(
				screen.queryByText(branchCopy.foreignCommitsNotice),
			).not.toBeInTheDocument();
		});

		it("hides Close, Retry opening and Start over, which only the owner may do", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([
					{
						branch: branch({
							state: "BLOCKED",
							failure: {
								code: "PR_CREATION_REFUSED",
								retryable: false,
							},
						}),
						liveChanges: 1,
					},
				]),
			});
			await screen.findByText(failureCopy.PR_CREATION_REFUSED);
			expect(
				screen.queryByRole("button", { name: branchCopy.close }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", {
					name: branchCopy.retryOpening,
				}),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: branchCopy.startOver }),
			).not.toBeInTheDocument();
		});

		it("still offers Stop tracking (owner-or-reviewer, spec Decision 19) and Refresh", async () => {
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([
					{
						branch: branch({
							failure: {
								code: "REPOSITORY_CHANGED",
								retryable: false,
							},
						}),
						liveChanges: 1,
					},
				]),
			});
			await user.click(
				await screen.findByRole("button", {
					name: branchCopy.stopTracking,
				}),
			);
			await waitFor(() =>
				expect(state.stopTracking).toHaveBeenCalledWith({
					projectId: "p",
					branchId: "branch_1",
					expectedAttempt: 7,
				}),
			);
			expect(
				screen.getByRole("button", {
					name: new RegExp(branchCopy.refresh),
				}),
			).toBeInTheDocument();
			confirm.mockRestore();
		});

		it("after Stop tracking, asks the caller to refresh instead of refetching itself", async () => {
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
			const { onChanged } = renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([
					{
						branch: branch({
							failure: {
								code: "REPOSITORY_CHANGED",
								retryable: false,
							},
						}),
						liveChanges: 1,
					},
				]),
			});
			await user.click(
				await screen.findByRole("button", {
					name: branchCopy.stopTracking,
				}),
			);
			// A read-only instance has no query of its own to refetch — the
			// aggregate this view came from is what `onChanged` refreshes.
			await waitFor(() => expect(onChanged).toHaveBeenCalled());
			expect(state.myBranchQueryFn).not.toHaveBeenCalled();
			confirm.mockRestore();
		});

		it("names the member in a read-only load error", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				isError: true,
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Could not load Case Worker's branch. Try again.",
			);
		});

		it("shows a loading skeleton while the caller's data is still loading, and still names the member", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				isLoading: true,
			});
			expect(
				screen.getByText("Case Worker's branch"),
			).toBeInTheDocument();
			expect(state.myBranchQueryFn).not.toHaveBeenCalled();
		});

		it("renders nothing for a member with no branch, same as the owner's own empty case", async () => {
			const { container } = render(
				<InstructionProposalBranchPanel
					projectId="p"
					userId="member_2"
					ownerName="Case Worker"
					data={ownerData([])}
				/>,
				{ wrapper: Wrapper },
			);
			await waitFor(() => expect(container).toBeEmptyDOMElement());
		});

		it("never queries myBranch when rendered read-only with data supplied (round-3 finding: duplicate queries)", async () => {
			renderPanel({
				userId: "member_2",
				ownerName: "Case Worker",
				data: ownerData([{ branch: branch(), liveChanges: 1 }]),
			});
			await screen.findByText(
				"Branch fabric/instructions/members/reader-ab12/1",
			);
			expect(state.myBranchQueryFn).not.toHaveBeenCalled();
		});
	});
});
