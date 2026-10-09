/**
 * "Committed" is announced after the page has re-read what the commit
 * changed, so the old file never sits under the toast.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	onSettled: null as ((result: unknown) => void) | null,
	onRetry: null as (() => void) | null,
	commitChange: vi.fn(),
	getState: vi.fn(),
	listFiles: vi.fn(),
	getFile: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: m.toastError, info: vi.fn() },
}));
vi.mock("../use-instruction-action-error", () => ({
	useInstructionActionError: () => () => "error",
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			instructions: {
				commitChange: async (input: unknown) => {
					m.commitChange(input);
					return { kind: "native", operationId: "operation-1" };
				},
				repository: {
					getState: (input: unknown) => m.getState(input),
					listFiles: (input: unknown) => m.listFiles(input),
					getFile: (input: unknown) => m.getFile(input),
				},
			},
		},
	},
}));
vi.mock("../../components/instructions/DirectCommitStatus", () => ({
	DirectCommitBranchMovedDialog: (props: { onRetry: () => void }) => {
		m.onRetry = props.onRetry;
		return null;
	},
	DirectCommitPullRequestAlert: () => null,
	DirectCommitWatcher: (props: { onSettled: (result: unknown) => void }) => {
		m.onSettled = props.onSettled;
		return null;
	},
}));

import {
	COMMIT_REREAD_TIMEOUT_MS,
	useDirectCommit,
} from "../use-direct-commit";

function Harness({
	onChanged,
	onFinished,
}: {
	onChanged: () => Promise<void> | void;
	onFinished: () => void;
}) {
	const commit = useDirectCommit({
		projectId: "p",
		branch: "main",
		onChanged,
		onFinished,
	});
	return (
		<>
			<button
				type="button"
				onClick={() =>
					commit.start({
						message: "Update",
						changes: [{ op: "put", path: "a.md", content: "x" }],
						nativeBase: {
							generation: 1,
							commitSha: "a".repeat(40),
						},
					})
				}
			>
				commit
			</button>
			{commit.status}
		</>
	);
}

describe("useDirectCommit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		m.onSettled = null;
	});

	it("announces the commit only after the page has been re-read", async () => {
		let finishReread = () => {};
		const reread = new Promise<void>((resolve) => {
			finishReread = resolve;
		});
		const onChanged = vi.fn(() => reread);
		const onFinished = vi.fn();
		const view = render(
			<QueryClientProvider client={new QueryClient()}>
				<Harness onChanged={onChanged} onFinished={onFinished} />
			</QueryClientProvider>,
		);
		view.getByRole("button", { name: "commit" }).click();
		await waitFor(() => expect(m.onSettled).not.toBeNull());

		act(() => {
			m.onSettled?.({
				kind: "committed",
				sha: "b".repeat(40),
				ref: "main",
			});
		});
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(m.toastSuccess).not.toHaveBeenCalled();
		expect(onFinished).not.toHaveBeenCalled();

		await act(async () => {
			finishReread();
		});
		await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledTimes(1));
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	async function commitWith(
		onChanged: () => Promise<void> | void,
		options: { fakeTimers?: boolean } = {},
	) {
		const onFinished = vi.fn();
		const view = render(
			<QueryClientProvider client={new QueryClient()}>
				<Harness onChanged={onChanged} onFinished={onFinished} />
			</QueryClientProvider>,
		);
		view.getByRole("button", { name: "commit" }).click();
		await waitFor(() => expect(m.onSettled).not.toBeNull());
		if (options.fakeTimers) {
			vi.useFakeTimers();
		}
		act(() => {
			m.onSettled?.({
				kind: "committed",
				sha: "b".repeat(40),
				ref: "main",
			});
		});
		return { onFinished, view };
	}

	it("still ends the flow, and says so, when the re-read fails", async () => {
		const { onFinished } = await commitWith(() =>
			Promise.reject(new Error("offline")),
		);
		await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledTimes(1));
		expect(m.toastError).toHaveBeenCalledWith("rereadFailed");
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	it("does not stay stuck on a re-read that never answers", async () => {
		try {
			const { onFinished } = await commitWith(
				() => new Promise<void>(() => undefined),
				{ fakeTimers: true },
			);
			expect(onFinished).not.toHaveBeenCalled();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(COMMIT_REREAD_TIMEOUT_MS + 1);
			});
			expect(m.toastSuccess).toHaveBeenCalledTimes(1);
			expect(m.toastError).toHaveBeenCalledWith("rereadFailed");
			expect(onFinished).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not touch the surface after it unmounted", async () => {
		let finishReread = () => {};
		const onChanged = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishReread = resolve;
				}),
		);
		const { onFinished, view } = await commitWith(onChanged);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		view.unmount();
		await act(async () => {
			finishReread();
		});
		await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledTimes(1));
		expect(onFinished).not.toHaveBeenCalled();
	});

	describe("Retry commit after the branch moved", () => {
		const HEAD = "c".repeat(40);
		async function moved() {
			const view = render(
				<QueryClientProvider client={new QueryClient()}>
					<Harness onChanged={vi.fn()} onFinished={vi.fn()} />
				</QueryClientProvider>,
			);
			view.getByRole("button", { name: "commit" }).click();
			await waitFor(() => expect(m.onSettled).not.toBeNull());
			m.commitChange.mockClear();
			act(() => {
				m.onSettled?.({ kind: "branch-moved" });
			});
			await waitFor(() => expect(m.onRetry).not.toBeNull());
		}
		beforeEach(() => {
			m.getFile.mockReset();
			m.getFile.mockResolvedValue({ state: "binary", size: 1 });
			m.getState.mockResolvedValue({
				availability: "READY",
				generation: 2,
				currentCommitSha: HEAD,
			});
		});

		const listing = (blobId: string | undefined, incomplete = false) => ({
			incomplete,
			files: [{ path: "a.md", kind: "KNOWLEDGE", blobId }],
		});

		it("commits again on the new head when the file is the same blob there", async () => {
			m.listFiles.mockResolvedValue(listing("blob-1"));
			await moved();
			act(() => m.onRetry?.());
			await waitFor(() =>
				expect(m.commitChange).toHaveBeenCalledTimes(1),
			);
			expect(m.commitChange).toHaveBeenCalledWith(
				expect.objectContaining({
					nativeBase: { generation: 2, commitSha: HEAD },
				}),
			);
		});

		describe("on a repository whose listing is capped", () => {
			const missing = { incomplete: true, files: [] };
			const found = (body: string) => ({
				state: "found",
				body,
				nextOffset: null,
			});

			it("still proves a file with a blob id in both listings", async () => {
				m.listFiles.mockResolvedValue(listing("blob-1", true));
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.commitChange).toHaveBeenCalledTimes(1),
				);
				expect(m.getFile).not.toHaveBeenCalled();
			});

			it("falls back to comparing the content of a path the capped listing does not hold", async () => {
				m.listFiles.mockResolvedValue(missing);
				m.getFile.mockResolvedValue(found("same text"));
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.commitChange).toHaveBeenCalledTimes(1),
				);
				expect(m.getFile).toHaveBeenCalledTimes(2);
			});

			it("refuses when that content differs", async () => {
				m.listFiles.mockResolvedValue(missing);
				m.getFile
					.mockResolvedValueOnce(found("mine"))
					.mockResolvedValueOnce(found("theirs"));
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.toastError).toHaveBeenCalledWith(
						"retryNeedsMerge",
					),
				);
				expect(m.commitChange).not.toHaveBeenCalled();
			});

			it("resends when identical content spans several pages", async () => {
				const pages = ["aa", "bb", "cc"];
				m.listFiles.mockResolvedValue(missing);
				m.getFile.mockImplementation(
					async (input: { offset: number }) => {
						const page = input.offset;
						return {
							state: "found",
							body: pages[page],
							nextOffset:
								page + 1 < pages.length ? page + 1 : null,
						};
					},
				);
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.commitChange).toHaveBeenCalledTimes(1),
				);
				expect(m.getFile).toHaveBeenCalledTimes(6);
			});

			it("refuses a file longer than the page cap instead of reading it forever", async () => {
				m.listFiles.mockResolvedValue(missing);
				m.getFile.mockImplementation(
					async (input: { offset: number }) => ({
						state: "found",
						body: "x",
						nextOffset: input.offset + 1,
					}),
				);
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.toastError).toHaveBeenCalledWith(
						"retryNeedsMerge",
					),
				);
				expect(m.commitChange).not.toHaveBeenCalled();
				expect(m.getFile.mock.calls.length).toBeLessThanOrEqual(50);
			});
		});

		it.each([
			["the blob differs", listing("blob-1"), listing("blob-2")],
			[
				"the blob identity is unknown",
				listing(undefined),
				listing(undefined),
			],
			[
				"the file appeared on the branch",
				{ incomplete: false, files: [] },
				listing("blob-2"),
			],
		])(
			"does not resend a draft when %s, and says why",
			async (_name, atBase, atHead) => {
				m.listFiles
					.mockResolvedValueOnce(atBase)
					.mockResolvedValueOnce(atHead);
				await moved();
				act(() => m.onRetry?.());
				await waitFor(() =>
					expect(m.toastError).toHaveBeenCalledWith(
						"retryNeedsMerge",
					),
				);
				expect(m.commitChange).not.toHaveBeenCalled();
			},
		);
	});
});
