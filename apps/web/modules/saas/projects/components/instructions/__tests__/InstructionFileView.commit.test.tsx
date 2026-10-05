/**
 * "Commit to <branch>" from the file view of a repository-backed project
 * (Fizzy #2878 §10): the editor's message and two ways on, and every way a
 * commit can end. Delete file, Rename and the tour anchor are in
 * `InstructionFileView.file-actions.test.tsx`.
 *
 * `commitChange` answers at once with a snapshot id; what became of the commit
 * is read from that snapshot, so the suite drives both: the mocked procedure
 * and the row `instructions.get` returns. Copy is the real `en.json`.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

const mocks = vi.hoisted(() => ({
	commitChange: vi.fn(),
	editInstructionSnapshot: vi.fn(),
	confirm: vi.fn(),
	toastInfo: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	/** The row `instructions.get` returns for the commit's snapshot. */
	snapshotRow: { current: {} as Record<string, unknown> },
	/** The block `getPullRequestStatus` returns. */
	pullRequest: {
		current: { url: null } as { url: string | null },
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { instructions: { commitChange: mocks.commitChange } },
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: (...a: unknown[]) =>
		mocks.editInstructionSnapshot(...a),
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => mocks.toastInfo(...a),
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
	},
}));

const TEXT_FILE = {
	path: ".claude/skills/review/SKILL.md",
	kind: "SKILL",
	name: "review",
	description: "Reviews a change.",
	size: 120,
	mimeType: "text/markdown",
	isText: true,
	mode: null,
	body: "# Review\nOriginal body.",
	offset: 0,
	nextOffset: null,
	truncated: false,
	url: null,
};

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getFile: {
					queryOptions: (o: unknown) => ({
						queryKey: ["getFile", o],
						queryFn: async () => TEXT_FILE,
					}),
				},
				get: {
					queryOptions: (o: unknown) => ({
						queryKey: ["get", o],
						queryFn: async () => mocks.snapshotRow.current,
					}),
				},
				proposals: {
					myBranch: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranch", o],
							queryFn: async () => ({
								branch: null,
								liveChanges: 0,
								files: [],
								branches: [],
							}),
						}),
					},
					myBranchFile: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranchFile", o],
							queryFn: async () => ({}),
						}),
					},
					getPullRequestStatus: {
						queryOptions: (o: unknown) => ({
							queryKey: ["getPullRequestStatus", o],
							queryFn: async () => ({
								pullRequest: {
									url: mocks.pullRequest.current.url,
								},
							}),
						}),
					},
				},
			},
		},
	},
}));

import { InstructionFileView } from "../InstructionFileView";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TARGET = { repository: "example-org/instructions", ref: "main" };
const PATH = TEXT_FILE.path;

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderView(
	props: Partial<React.ComponentProps<typeof InstructionFileView>> = {},
) {
	const onChanged = vi.fn();
	render(
		<InstructionFileView
			projectId="p"
			snapshotId="s7"
			path={PATH}
			canCommit
			canPropose
			repositoryTarget={TARGET}
			existingPaths={new Set([PATH, "docs/other.md"])}
			onChanged={onChanged}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
	return { onChanged };
}

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	const editor = screen.getByRole("textbox", { name: `Contents of ${PATH}` });
	await user.clear(editor);
	await user.type(editor, "# Review\nChanged body.");
}

describe("InstructionFileView — commit to the branch", () => {
	beforeEach(() => {
		for (const fn of [
			mocks.commitChange,
			mocks.editInstructionSnapshot,
			mocks.confirm,
			mocks.toastInfo,
			mocks.toastSuccess,
			mocks.toastError,
		]) {
			fn.mockReset();
		}
		mocks.commitChange.mockResolvedValue({
			snapshotId: "snap_commit",
			version: 8,
			baseSnapshotId: "s7",
			fileCount: 4,
			putCount: 1,
			deleteCount: 0,
			status: "RECEIVING",
		});
		mocks.editInstructionSnapshot.mockResolvedValue({
			snapshotId: "snap_pr",
			version: 8,
		});
		mocks.snapshotRow.current = {
			status: "READY",
			commitOutcome: { outcome: "committed", sha: SHA, ref: "main" },
		};
		mocks.pullRequest.current = { url: null };
		mocks.confirm.mockImplementation((options: { onConfirm: () => void }) =>
			options.onConfirm(),
		);
	});

	describe("the editor", () => {
		it("offers a commit message, Commit to the branch as the primary action, and a pull request as the alternative", async () => {
			const user = userEvent.setup();
			renderView();

			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(screen.getByLabelText("Commit message")).toHaveValue(
				"Update SKILL.md",
			);
			expect(
				screen.getByRole("button", { name: "Commit to main" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", {
					name: "Suggest as a pull request",
				}),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Cancel" }),
			).toBeInTheDocument();
			// A repository project has no versions to save.
			expect(
				screen.queryByRole("button", { name: "Save as a new version" }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: "Save and publish" }),
			).toBeNull();
		});

		it("offers a reader only the pull request, with no commit message", async () => {
			const user = userEvent.setup();
			renderView({ canCommit: false });

			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(
				screen.getByRole("button", {
					name: "Suggest as a pull request",
				}),
			).toBeInTheDocument();
			expect(screen.queryByLabelText("Commit message")).toBeNull();
			expect(
				screen.queryByRole("button", { name: /^Commit to/ }),
			).toBeNull();
		});

		it("sends the edit as one commit stated against the published version, with the message shown", async () => {
			const user = userEvent.setup();
			const { onChanged } = renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.commitChange).toHaveBeenCalledWith({
					projectId: "p",
					baseSnapshotId: "s7",
					message: "Update SKILL.md",
					changes: [
						{
							op: "put",
							path: PATH,
							content: "# Review\nChanged body.",
							encoding: "utf8",
						},
					],
				}),
			);
			await waitFor(() =>
				expect(mocks.toastSuccess).toHaveBeenCalledWith(
					"Committed 0123456 to main",
				),
			);
			// The draft is done and the tab re-reads its lists.
			expect(screen.queryByLabelText("Commit message")).toBeNull();
			expect(onChanged).toHaveBeenCalled();
		});

		// The push is recorded; Fabric's copy follows from a sync of the real
		// tree, so the tab is told which commit to wait for.
		it("tells the tab which commit to wait for Fabric's copy to take", async () => {
			const user = userEvent.setup();
			const onCommitted = vi.fn();
			renderView({ onCommitted });
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(onCommitted).toHaveBeenCalledWith({
					sha: SHA,
					ref: "main",
				}),
			);
		});

		it("does not tell the tab to wait when the branch already held the content", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "unchanged", sha: SHA },
			};
			const user = userEvent.setup();
			const onCommitted = vi.fn();
			renderView({ onCommitted });
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalled());
			expect(onCommitted).not.toHaveBeenCalled();
		});

		it("sends the message the person wrote instead of the default", async () => {
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			const message = screen.getByLabelText("Commit message");
			await user.clear(message);
			await user.type(message, "Tighten the review checklist");
			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.commitChange).toHaveBeenCalledWith(
					expect.objectContaining({
						message: "Tighten the review checklist",
					}),
				),
			);
		});

		it("holds the commit back while the message is empty", async () => {
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.clear(screen.getByLabelText("Commit message"));

			expect(
				screen.getByRole("button", { name: "Commit to main" }),
			).toBeDisabled();
		});

		it("sends nothing for a text that is the published one, and says so", async () => {
			const user = userEvent.setup();
			renderView();
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			expect(mocks.commitChange).not.toHaveBeenCalled();
			expect(mocks.toastInfo).toHaveBeenCalledWith(
				"Nothing changed, so nothing was committed.",
			);
		});

		it("suggests the same text as a pull request through the existing path", async () => {
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", {
					name: "Suggest as a pull request",
				}),
			);

			await waitFor(() =>
				expect(mocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({
						proposal: true,
						publishOnReady: false,
					}),
				),
			);
			expect(mocks.commitChange).not.toHaveBeenCalled();
		});
	});

	describe("what became of the commit", () => {
		it("says nothing was committed when the branch already held this content", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "unchanged", sha: SHA },
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.toastInfo).toHaveBeenCalledWith(
					"Nothing changed, so nothing was committed.",
				),
			);
			expect(mocks.toastSuccess).not.toHaveBeenCalled();
		});

		it("shows the pull request a protected branch turned the change into, with its link", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: {
					outcome: "pull-request",
					operationId: "op_1",
					reason: "protected",
				},
			};
			mocks.pullRequest.current = {
				url: "https://github.com/example-org/instructions/pull/12",
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			expect(
				await screen.findByText(
					"main is protected, so your change was opened as a pull request instead",
				),
			).toBeInTheDocument();
			const link = await screen.findByRole("link", {
				name: /Open the pull request/,
			});
			expect(link).toHaveAttribute(
				"href",
				"https://github.com/example-org/instructions/pull/12",
			);
			expect(link).toHaveAttribute("rel", "noopener noreferrer");
			// The editor is done: the change lives in the pull request now.
			expect(screen.queryByLabelText("Commit message")).toBeNull();
		});

		it("never links an address that is not https", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: {
					outcome: "pull-request",
					operationId: "op_1",
					reason: "protected",
				},
			};
			mocks.pullRequest.current = { url: "javascript:alert(1)" };
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await screen.findByText(
				"main is protected, so your change was opened as a pull request instead",
			);
			expect(screen.queryByRole("link")).toBeNull();
		});

		it("says Fabric is still opening the pull request until it has a link", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: {
					outcome: "pull-request",
					operationId: "op_1",
					reason: "busy",
				},
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			expect(
				await screen.findByText(
					"main kept changing, so your change was opened as a pull request instead",
				),
			).toBeInTheDocument();
			expect(
				await screen.findByText("Fabric is opening the pull request."),
			).toBeInTheDocument();
			expect(screen.queryByRole("link")).toBeNull();
		});

		it("asks what to do when someone else committed to the same file, and keeps the typed change", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "branch-moved" },
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			const dialog = await screen.findByRole("dialog");
			expect(
				within(dialog).getByText(
					"Someone committed to main while you were editing.",
				),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Retry commit" }),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", {
					name: "Suggest as a pull request",
				}),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Cancel" }),
			).toBeInTheDocument();

			await user.click(
				within(dialog).getByRole("button", { name: "Cancel" }),
			);
			expect(
				screen.getByRole("textbox", { name: `Contents of ${PATH}` }),
			).toHaveValue("# Review\nChanged body.");
		});

		it("commits the same change again on Retry commit", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "branch-moved" },
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);
			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);
			const dialog = await screen.findByRole("dialog");
			expect(mocks.commitChange).toHaveBeenCalledTimes(1);
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "committed", sha: SHA, ref: "main" },
			};

			await user.click(
				within(dialog).getByRole("button", { name: "Retry commit" }),
			);

			await waitFor(() =>
				expect(mocks.commitChange).toHaveBeenCalledTimes(2),
			);
			expect(mocks.commitChange.mock.calls[1]?.[0]).toEqual(
				mocks.commitChange.mock.calls[0]?.[0],
			);
		});

		it("suggests the change as a pull request from the branch-moved dialog", async () => {
			mocks.snapshotRow.current = {
				status: "READY",
				commitOutcome: { outcome: "branch-moved" },
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);
			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);
			const dialog = await screen.findByRole("dialog");

			await user.click(
				within(dialog).getByRole("button", {
					name: "Suggest as a pull request",
				}),
			);

			await waitFor(() =>
				expect(mocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({ proposal: true }),
				),
			);
		});

		it.each([
			[
				"AUTHENTICATION_FAILED",
				"Fabric can't sign in to the repository any more, so nothing was committed. Reconnect the repository in the project's repository settings.",
			],
			[
				"TARGET_BRANCH_MISSING",
				"main no longer exists in the repository, so nothing was committed.",
			],
			[
				"GIT_FAILED",
				"The commit failed and nothing was pushed. Try again.",
			],
			[
				"SETTLE_FAILED",
				"The commit was pushed but its record could not be saved; Fabric's copy follows the branch on the next sync.",
			],
			["STALE", "This commit attempt timed out; commit again."],
		])(
			"words a failed commit (%s) from its code, never the server's text",
			async (code, sentence) => {
				mocks.snapshotRow.current = {
					status: "READY",
					commitOutcome: {
						outcome: "failed",
						code,
						retryable: false,
					},
				};
				const user = userEvent.setup();
				renderView();
				await startEditing(user);

				await user.click(
					screen.getByRole("button", { name: "Commit to main" }),
				);

				await waitFor(() =>
					expect(mocks.toastError).toHaveBeenCalledWith(sentence),
				);
				// The draft stays, so nothing typed is lost to a retry.
				expect(
					screen.getByRole("textbox", {
						name: `Contents of ${PATH}`,
					}),
				).toHaveValue("# Review\nChanged body.");
			},
		);

		it("says nothing was pushed when the secret scan refused the change, and re-reads the page for its findings", async () => {
			mocks.snapshotRow.current = {
				status: "REJECTED",
				commitOutcome: null,
			};
			const user = userEvent.setup();
			const { onChanged } = renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.toastError).toHaveBeenCalledWith(
					"The commit wasn't made: a file looks like it contains a secret, so nothing was pushed. The findings are listed on the page.",
				),
			);
			expect(onChanged).toHaveBeenCalled();
			expect(screen.queryByLabelText("Commit message")).toBeNull();
		});

		it("waits, with the editor held, while the commit is still being checked", async () => {
			mocks.snapshotRow.current = {
				status: "VALIDATING",
				commitOutcome: null,
			};
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			expect(
				await screen.findByText("Committing to main…"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Commit to main" }),
			).toBeDisabled();
			expect(mocks.toastSuccess).not.toHaveBeenCalled();
		});
	});

	describe("when the server refuses the commit outright", () => {
		it("shows a message the server refused under the message field, not as a toast", async () => {
			mocks.commitChange.mockRejectedValue({
				code: "UNPROCESSABLE_CONTENT",
				data: { reason: "MESSAGE_REJECTED", field: "message" },
				message: "TEXT THAT MUST NOT BE SHOWN",
			});
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			expect(
				await screen.findByText(
					"That commit message looks like it contains a credential. Remove it and try again.",
				),
			).toBeInTheDocument();
			expect(mocks.toastError).not.toHaveBeenCalled();
			expect(document.body.textContent).not.toContain(
				"TEXT THAT MUST NOT BE SHOWN",
			);
		});

		it("says the branch moved when the published version it was stated against is no longer published", async () => {
			mocks.commitChange.mockRejectedValue({
				code: "CONFLICT",
				data: { reason: "BASE_NOT_PUBLISHED" },
				message: "TEXT THAT MUST NOT BE SHOWN",
			});
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.toastError).toHaveBeenCalledWith(
					"main moved while you were editing, so nothing was committed. Copy what you need, then make the change again on the newest commit.",
				),
			);
		});

		it("says the project is in Read-only mode, in its own words, when the server refuses the write for that", async () => {
			mocks.commitChange.mockRejectedValue({
				code: "CONFLICT",
				data: { errorCode: "PROJECT_READ_ONLY" },
				message: "TEXT THAT MUST NOT BE SHOWN",
			});
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.toastError).toHaveBeenCalledWith(
					en.projects.codingInstructions.actionErrors.readOnlyMode,
				),
			);
			expect(document.body.textContent).not.toContain(
				"TEXT THAT MUST NOT BE SHOWN",
			);
		});

		it("falls back to the shared error map for a refusal it does not know", async () => {
			mocks.commitChange.mockRejectedValue({
				code: "FORBIDDEN",
				message: "TEXT THAT MUST NOT BE SHOWN",
			});
			const user = userEvent.setup();
			renderView();
			await startEditing(user);

			await user.click(
				screen.getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.toastError).toHaveBeenCalledWith(
					"You don't have permission to do that.",
				),
			);
		});
	});
});
