import { orpc } from "@shared/lib/orpc-query-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const mocks = vi.hoisted(() => ({
	state: vi.fn(),
	list: vi.fn(),
	preview: vi.fn(),
	restore: vi.fn(),
	operation: vi.fn(),
	confirm: vi.fn(),
	pr: vi.fn(),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			instructions: {
				repository: {
					listCommits: mocks.list,
					restoreFile: mocks.restore,
					getState: mocks.state,
				},
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getState: {
						queryOptions: ({
							input,
						}: {
							input: { projectId: string };
						}) => ({
							queryKey: ["state", input.projectId],
							queryFn: () => mocks.state(input),
						}),
					},
					previewFileRestore: {
						queryOptions: ({
							input,
						}: {
							input: {
								projectId: string;
								path: string;
								generation: number;
								currentCommitSha: string;
								targetCommitSha: string;
							};
						}) => ({
							queryKey: ["preview", input],
							queryFn: () => mocks.preview(input),
						}),
					},
				},
				getGitOperation: {
					queryOptions: ({
						input,
					}: {
						input: { projectId: string; operationId: string };
					}) => ({
						queryKey: ["operation", input.operationId],
						queryFn: () => mocks.operation(input),
					}),
				},
				proposals: {
					getPullRequestStatus: {
						queryOptions: ({
							input,
						}: {
							input: { projectId: string; snapshotId: string };
						}) => ({
							queryKey: ["pr", input.snapshotId],
							queryFn: () => mocks.pr(input),
						}),
					},
				},
			},
		},
	},
}));

import { InstructionFileHistory } from "../InstructionFileHistory";

const HEAD = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const OLDER = "c".repeat(40);
const PATH = ".claude/rules/review.md";
const STATE = {
	availability: "READY",
	readState: "DIRECT",
	generation: 7,
	currentCommitSha: HEAD,
	ref: "main",
	rootPath: "instructions",
	repositoryUrl: "https://example.com/org/repository",
	provider: "GITHUB",
};
const textVersion = (text: string) => ({
	state: "found",
	text,
	textLength: text.length,
	size: text.length,
});
const PREVIEW = {
	path: PATH,
	targetCommitSha: PREVIOUS,
	nativeBase: { generation: 7, commitSha: HEAD },
	current: textVersion("Current rule\n"),
	selected: textVersion("Previous rule\n"),
	restore: { available: true, operation: "put" },
	maxTextBytes: 262144,
};
const commit = (sha: string) => ({
	sha,
	author: { name: "Example author" },
	date: "2026-01-02T10:00:00Z",
	message: "Update review rule",
	messageWithheld: false,
	url: `https://example.com/org/repository/commit/${sha}`,
	parent: null,
	published: null,
	refused: false,
	isFabric: false,
});
const page = (sha = PREVIOUS) => ({
	commits: [commit(sha)],
	nextCursor: null,
	hasMore: false,
	historyLimitReached: false,
});

function renderHistory(
	props: Partial<ComponentProps<typeof InstructionFileHistory>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onChanged = vi.fn();
	const onCommitted = vi.fn();
	const defaults = {
		projectId: "example-project",
		path: PATH,
		canRestore: true,
		blockedReason: null,
		onChanged,
		onCommitted,
	};
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const result = render(<InstructionFileHistory {...defaults} {...props} />, {
		wrapper,
	});
	return {
		...result,
		client,
		onChanged,
		onCommitted,
		change: (
			next: Partial<ComponentProps<typeof InstructionFileHistory>>,
		) =>
			result.rerender(
				<InstructionFileHistory {...defaults} {...props} {...next} />,
			),
	};
}

async function openAndSelect(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "History" }));
	await user.click(await screen.findByRole("button", { name: PREVIOUS }));
	return screen.findByRole("button", { name: "Restore this file" });
}

async function settle(
	client: QueryClient,
	outcome: Record<string, unknown>,
	status = "READY",
) {
	mocks.operation.mockResolvedValue({ status, commitOutcome: outcome });
	await act(async () => {
		await client.refetchQueries({
			queryKey: ["operation", "operation-one"],
		});
	});
}

function observers(client: QueryClient, scope: "operation" | "pr") {
	return client
		.getQueryCache()
		.find({ queryKey: [scope, "operation-one"] })
		?.getObserversCount();
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.state.mockResolvedValue(STATE);
	mocks.list.mockResolvedValue(page());
	mocks.preview.mockResolvedValue(PREVIEW);
	mocks.restore.mockResolvedValue({
		kind: "native",
		operationId: "operation-one",
		nativeBase: PREVIEW.nativeBase,
		putCount: 1,
		deleteCount: 0,
		status: "READY",
	});
	mocks.operation.mockResolvedValue({ status: "READY" });
	mocks.pr.mockResolvedValue({
		pullRequest: { url: "https://example.com/pull/1" },
	});
});

describe("Git-native file history", () => {
	it("reads nothing before opening, refreshes Git on each opening, and loads bytes only after selection", async () => {
		const user = userEvent.setup();
		renderHistory();
		expect(mocks.state).not.toHaveBeenCalled();
		expect(mocks.list).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "History" }));
		await screen.findByRole("button", { name: PREVIOUS });
		expect(mocks.state).toHaveBeenCalledTimes(1);
		expect(mocks.list).toHaveBeenCalledTimes(1);
		expect(mocks.preview).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: PREVIOUS }));
		await screen.findByText(`Selected revision: ${PREVIOUS}`);
		expect(mocks.preview).toHaveBeenCalledWith({
			projectId: "example-project",
			path: PATH,
			generation: 7,
			currentCommitSha: HEAD,
			targetCommitSha: PREVIOUS,
		});
		expect(
			screen.getByText(`Current branch revision: ${HEAD}`),
		).toBeInTheDocument();
		expect(
			screen.getByTestId(`instruction-file-diff-${PATH}`),
		).toHaveTextContent("Current rule");
		expect(
			screen.getByRole("link", { name: "Open commit in Git" }),
		).toHaveAttribute("href", commit(PREVIOUS).url);
		await user.click(screen.getByRole("button", { name: "Close" }));
		mocks.state.mockResolvedValue({ ...STATE, currentCommitSha: OLDER });
		await user.click(screen.getByRole("button", { name: "History" }));
		await screen.findByText(`Current branch revision: ${OLDER}`);
		expect(mocks.state).toHaveBeenCalledTimes(2);
		expect(mocks.preview).toHaveBeenCalledTimes(1);
		expect(mocks.list).toHaveBeenLastCalledWith(
			expect.objectContaining({
				commitSha: OLDER,
				cursor: 1,
				path: PATH,
			}),
		);
	});

	it("pins Load more to one exact path and HEAD and reports partial history", async () => {
		mocks.list
			.mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: 2 })
			.mockResolvedValueOnce(page(OLDER));
		const user = userEvent.setup();
		renderHistory();
		await user.click(screen.getByRole("button", { name: "History" }));
		await screen.findByText(
			"More history is available. Only loaded commits are shown.",
		);
		await user.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByRole("button", { name: OLDER });
		expect(mocks.list.mock.calls.map(([input]) => input)).toEqual(
			[1, 2].map((cursor) => ({
				projectId: "example-project",
				path: PATH,
				generation: 7,
				commitSha: HEAD,
				cursor,
			})),
		);
		expect(mocks.preview).not.toHaveBeenCalled();
	});

	it("keeps its selected version and pin when the parent repository query refreshes in the background", async () => {
		const user = userEvent.setup();
		const { client } = renderHistory();
		await openAndSelect(user);
		await screen.findByText(`Selected revision: ${PREVIOUS}`);
		mocks.state.mockResolvedValue({ ...STATE, currentCommitSha: OLDER });
		await act(async () => {
			await client.fetchQuery(
				orpc.projects.instructions.repository.getState.queryOptions({
					input: { projectId: "example-project" },
				}),
			);
		});
		expect(
			screen.getByText(`Current branch revision: ${HEAD}`),
		).toBeInTheDocument();
		expect(
			screen.getByText(`Selected revision: ${PREVIOUS}`),
		).toBeInTheDocument();
		expect(mocks.list).toHaveBeenCalledTimes(1);
	});

	it("distinguishes provider failure from empty history", async () => {
		mocks.list.mockRejectedValue({
			code: "NOT_FOUND",
			data: { code: "PATH_NOT_FOUND" },
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not read Git history.",
		);
		expect(
			screen.queryByText("Git returned no commits for this path."),
		).not.toBeInTheDocument();
	});

	it("does not render failed historical content as an empty diff or permit restoration", async () => {
		mocks.preview.mockRejectedValue({
			code: "CONFLICT",
			data: { code: "FILE_RESTORE_PREVIEW_STALE" },
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(screen.getByRole("button", { name: "History" }));
		await user.click(await screen.findByRole("button", { name: PREVIOUS }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not compare this version.",
		);
		expect(
			screen.queryByTestId(`instruction-file-diff-${PATH}`),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Restore this file" }),
		).not.toBeInTheDocument();
	});

	it("does not call an empty paginated page complete or hide its limit", async () => {
		mocks.list.mockResolvedValue({
			commits: [],
			hasMore: true,
			nextCursor: null,
			historyLimitReached: true,
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(screen.getByRole("button", { name: "History" }));
		await screen.findByText(
			"The provider history limit was reached. Older commits may exist.",
		);
		expect(
			screen.queryByText("Git returned no commits for this path."),
		).not.toBeInTheDocument();
	});

	it.each([
		"UPLOAD",
		"MIGRATING",
		"DISCONNECTED",
		"CREDENTIALS_EXPIRED",
		"NOT_FOUND",
		"UNAVAILABLE",
	])("keeps %s repository availability explicit", async (availability) => {
		mocks.state.mockResolvedValue({ availability, readState: "DIRECT" });
		const user = userEvent.setup();
		renderHistory();
		await user.click(screen.getByRole("button", { name: "History" }));
		await screen.findByRole("alert");
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.preview).not.toHaveBeenCalled();
	});

	it.each([
		["binary", "binary"],
		["tooLarge", "tooLarge"],
		["nonRegular", "nonRegular"],
		["unavailable", "incomplete"],
	])(
		"does not turn %s content into an empty file or an enabled restore",
		async (state, reason) => {
			mocks.preview.mockResolvedValue({
				...PREVIEW,
				selected: { state },
				restore: { available: false, reason },
			});
			const user = userEvent.setup();
			renderHistory();
			expect(await openAndSelect(user)).toBeDisabled();
			expect(
				screen.queryByTestId(`instruction-file-diff-${PATH}`),
			).not.toBeInTheDocument();
			expect(
				screen.queryByText(
					"Selected file: no file exists at this path",
				),
			).not.toBeInTheDocument();
		},
	);

	it.each([
		{ canRestore: false, blockedReason: null },
		{
			canRestore: true,
			blockedReason: "Save or discard your editor draft first.",
		},
		{ canRestore: true, blockedReason: "Changes are paused." },
	])("allows comparison while restore is refused: %j", async (props) => {
		const user = userEvent.setup();
		renderHistory(props);
		expect(await openAndSelect(user)).toBeDisabled();
		expect(
			screen.getByTestId(`instruction-file-diff-${PATH}`),
		).toBeInTheDocument();
		expect(mocks.restore).not.toHaveBeenCalled();
	});

	it("restores an empty text file as content without asking to delete it", async () => {
		mocks.preview.mockResolvedValue({
			...PREVIEW,
			selected: textVersion(""),
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(await openAndSelect(user));
		await waitFor(() =>
			expect(mocks.restore).toHaveBeenCalledWith({
				projectId: "example-project",
				path: PATH,
				generation: 7,
				targetCommitSha: PREVIOUS,
				currentCommitSha: HEAD,
			}),
		);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.restore.mock.calls[0]?.[0]).not.toHaveProperty("content");
	});

	it("requires confirmation for proven absence and invalidates it when History closes", async () => {
		mocks.preview.mockResolvedValue({
			...PREVIEW,
			selected: { state: "absent" },
			restore: { available: true, operation: "delete" },
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(await openAndSelect(user));
		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				destructive: true,
				title: `Delete ${PATH} to match this version?`,
			}),
		);
		expect(mocks.restore).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Close" }));
		act(() => mocks.confirm.mock.calls[0]?.[0].onConfirm());
		expect(mocks.restore).not.toHaveBeenCalled();
	});

	it("requires fresh comparison after a stale preview is refused", async () => {
		mocks.restore.mockRejectedValue({
			code: "CONFLICT",
			data: { code: "FILE_RESTORE_PREVIEW_STALE" },
		});
		const user = userEvent.setup();
		renderHistory();
		await user.click(await openAndSelect(user));
		await screen.findByText(
			"This comparison can no longer be used. Refresh from Git and select the version again.",
		);
		expect(
			screen.getByRole("button", { name: "Restore this file" }),
		).toBeDisabled();
		await user.click(
			screen.getAllByRole("button", { name: "Refresh from Git" })[0],
		);
		await screen.findByRole("button", { name: PREVIOUS });
		expect(
			screen.queryByRole("button", { name: "Restore this file" }),
		).not.toBeInTheDocument();
	});

	it("does not start polling or announce a commit when admission reports an unchanged file", async () => {
		mocks.restore.mockResolvedValue({
			kind: "unchanged",
			nativeBase: PREVIEW.nativeBase,
		});
		const user = userEvent.setup();
		const { onCommitted } = renderHistory();
		await user.click(await openAndSelect(user));
		await screen.findByText(
			"The file already matches this version. No commit was created.",
		);
		expect(mocks.operation).not.toHaveBeenCalled();
		expect(onCommitted).not.toHaveBeenCalled();
	});

	it("keeps an admitted operation pending through dialog close/reopen, then refreshes only for a real commit", async () => {
		const user = userEvent.setup();
		const { client, onChanged, onCommitted } = renderHistory();
		await user.click(await openAndSelect(user));
		await waitFor(() =>
			expect(mocks.operation).toHaveBeenCalledWith({
				projectId: "example-project",
				operationId: "operation-one",
			}),
		);
		expect(onChanged).not.toHaveBeenCalled();
		expect(onCommitted).not.toHaveBeenCalled();
		expect(observers(client, "operation")).toBe(1);
		expect(
			within(screen.getByRole("dialog")).getByRole("status", {
				name: "A file restoration is awaiting its Git result.",
			}),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(observers(client, "operation")).toBe(1);
		expect(
			screen.queryByText(`File restored in commit ${OLDER}`),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "History" }));
		await user.click(await screen.findByRole("button", { name: PREVIOUS }));
		expect(observers(client, "operation")).toBe(1);
		expect(
			await screen.findByRole("button", { name: "Restore this file" }),
		).toBeDisabled();
		await settle(client, { outcome: "committed", sha: OLDER, ref: "main" });
		await screen.findByText(`File restored in commit ${OLDER}`);
		expect(onCommitted).toHaveBeenCalledWith({ sha: OLDER, ref: "main" });
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			outcome: { outcome: "branch-moved" },
			status: "READY",
			message: "The branch changed before restoration.",
		},
		{
			outcome: {
				outcome: "failed",
				code: "PROVIDER_UNAVAILABLE",
				retryable: true,
			},
			status: "READY",
			message: "Restoration did not complete",
		},
		{
			outcome: {},
			status: "REJECTED",
			message: "The secret check rejected the restoration.",
		},
		{
			outcome: { outcome: "unchanged", sha: HEAD },
			status: "READY",
			message: "The file already matches this version.",
		},
	])(
		"preserves the actual non-commit outcome: $message",
		async ({ outcome, status, message }) => {
			const user = userEvent.setup();
			const { client, onChanged, onCommitted } = renderHistory();
			await user.click(await openAndSelect(user));
			await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
			await settle(client, outcome, status);
			await screen.findByText((text) => text.startsWith(message));
			expect(onChanged).not.toHaveBeenCalled();
			expect(onCommitted).not.toHaveBeenCalled();
			if (outcome.outcome === "branch-moved")
				expect(
					screen.getByRole("button", { name: "Restore this file" }),
				).toBeDisabled();
		},
	);

	it.each(["protected", "busy"])(
		"keeps the %s branch PR fallback outstanding",
		async (reason) => {
			const user = userEvent.setup();
			const { client, onCommitted } = renderHistory();
			await user.click(await openAndSelect(user));
			await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
			await settle(client, {
				outcome: "pull-request",
				operationId: "operation-one",
				reason,
			});
			const dialog = within(screen.getByRole("dialog"));
			expect(
				await dialog.findByRole("link", { name: /pull request/i }),
			).toBeVisible();
			expect(
				screen.getAllByRole("link", { name: /pull request/i }),
			).toHaveLength(1);
			expect(observers(client, "pr")).toBe(1);
			expect(
				screen.getByRole("button", { name: "Restore this file" }),
			).toBeDisabled();
			expect(onCommitted).not.toHaveBeenCalled();
			await user.click(screen.getByRole("button", { name: "Close" }));
			expect(
				await screen.findByRole("link", { name: /pull request/i }),
			).toBeVisible();
			expect(
				screen.getAllByRole("link", { name: /pull request/i }),
			).toHaveLength(1);
			await user.click(screen.getByRole("button", { name: "History" }));
			expect(
				await within(screen.getByRole("dialog")).findByRole("link", {
					name: /pull request/i,
				}),
			).toBeVisible();
			expect(
				screen.getAllByRole("link", { name: /pull request/i }),
			).toHaveLength(1);
			expect(observers(client, "pr")).toBe(1);
		},
	);

	it("does not apply a late deletion confirmation to another file", async () => {
		mocks.preview.mockResolvedValue({
			...PREVIEW,
			selected: { state: "absent" },
			restore: { available: true, operation: "delete" },
		});
		const user = userEvent.setup();
		const view = renderHistory();
		await user.click(await openAndSelect(user));
		view.change({ projectId: "another-project", path: "another.md" });
		act(() => mocks.confirm.mock.calls[0]?.[0].onConfirm());
		expect(mocks.restore).not.toHaveBeenCalled();
	});

	it("confirms a deletion as a one-file operation and refreshes the list without rereading the deleted path", async () => {
		mocks.preview.mockResolvedValue({
			...PREVIEW,
			selected: { state: "absent" },
			restore: { available: true, operation: "delete" },
		});
		mocks.restore.mockResolvedValue({
			kind: "native",
			operationId: "operation-one",
			nativeBase: PREVIEW.nativeBase,
			putCount: 0,
			deleteCount: 1,
			status: "READY",
		});
		const user = userEvent.setup();
		const { client, onChanged, onCommitted } = renderHistory();
		await user.click(await openAndSelect(user));
		act(() => mocks.confirm.mock.calls[0]?.[0].onConfirm());
		await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
		expect(mocks.restore).toHaveBeenCalledWith({
			projectId: "example-project",
			path: PATH,
			generation: 7,
			targetCommitSha: PREVIOUS,
			currentCommitSha: HEAD,
		});
		await settle(client, { outcome: "committed", sha: OLDER, ref: "main" });
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(onCommitted).not.toHaveBeenCalled();
	});

	it("names the original pending file and refuses its completion callback after the selected file changes", async () => {
		const user = userEvent.setup();
		const view = renderHistory();
		await user.click(await openAndSelect(user));
		await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
		view.change({ projectId: "another-project", path: "another.md" });
		expect(screen.getByText(PATH)).toBeVisible();
		await settle(view.client, {
			outcome: "committed",
			sha: OLDER,
			ref: "main",
		});
		await screen.findByText(`File restored in commit ${OLDER}`);
		expect(view.onChanged).not.toHaveBeenCalled();
		expect(view.onCommitted).not.toHaveBeenCalled();
	});

	it("distinguishes a committed restoration from a failed reread without an unhandled rejection", async () => {
		const user = userEvent.setup();
		const view = renderHistory();
		view.onCommitted.mockRejectedValueOnce(
			new Error("Synthetic reread failure"),
		);
		await user.click(await openAndSelect(user));
		await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
		await settle(view.client, {
			outcome: "committed",
			sha: OLDER,
			ref: "main",
		});
		await screen.findByText(`File restored in commit ${OLDER}`);
		await screen.findByText(
			"The restoration committed, but the file view could not refresh. Refresh from Git to see the current file.",
		);
		expect(view.onChanged).toHaveBeenCalledTimes(1);
	});
});
