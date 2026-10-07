/**
 * The other file actions of a repository-backed project's file view (Fizzy
 * #2878 §10): Delete file and Rename, each committing to the synced branch or
 * suggesting a pull request, and the page tour's anchor on the control that
 * leads to a commit. The editor's own commit flow and every way a commit can
 * end are in `InstructionFileView.commit.test.tsx`, which this file shares its
 * setup with.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseFileAction, openFileActions } from "./file-actions-menu";

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
				repository: {
					getFile: {
						queryOptions: (o: unknown) => ({
							queryKey: ["nativeGetFile", o],
							queryFn: async () => ({
								state: "found",
								body: TEXT_FILE.body,
								size: TEXT_FILE.size,
								nextOffset: null,
							}),
						}),
					},
				},
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

// The page tour's "Commit to the branch" step is anchored on the control that
// leads to a commit: Edit while reading, and the Commit button that replaces
// it while editing. Exactly one exists at a time, and neither on a project
// that cannot commit.
describe("InstructionFileView — the commit tour anchor", () => {
	const ANCHOR = '[data-onboarding-target="coding-instructions-commit"]';

	it("is on the Edit button of a member who can commit, then on the Commit button while editing", async () => {
		const user = userEvent.setup();
		renderView();

		const edit = await screen.findByRole("button", { name: "Edit" });
		expect(document.querySelectorAll(ANCHOR)).toHaveLength(1);
		expect(document.querySelector(ANCHOR)).toContainElement(edit);

		await user.click(edit);

		const commitButton = screen.getByRole("button", {
			name: "Commit to main",
		});
		expect(document.querySelectorAll(ANCHOR)).toHaveLength(1);
		expect(document.querySelector(ANCHOR)).toBe(commitButton);
	});

	it("is on no hidden element", async () => {
		renderView();
		await screen.findByRole("button", { name: "Edit" });

		const anchor = document.querySelector(ANCHOR);

		expect(anchor?.closest('[aria-hidden="true"]')).toBeNull();
	});

	it("is absent for a reader, who cannot commit", async () => {
		renderView({ canCommit: false });
		await screen.findByRole("button", { name: "Edit" });

		expect(document.querySelector(ANCHOR)).toBeNull();
	});

	it("is absent on a project that is not repository-backed", async () => {
		renderView({
			canCommit: false,
			canEdit: true,
			canPropose: false,
			repositoryTarget: null,
		});
		await screen.findByRole("button", { name: "Edit" });

		expect(document.querySelector(ANCHOR)).toBeNull();
	});
});

describe("InstructionFileView — file actions on a repository project", () => {
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

	describe("Delete file", () => {
		it("asks to delete the file from the branch and commits the deletion with a message that names it", async () => {
			const user = userEvent.setup();
			const { onChanged } = renderView();

			await chooseFileAction(user, "Delete file");

			expect(mocks.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					title: `Delete ${PATH} from main?`,
					confirmLabel: "Commit deletion",
					destructive: true,
				}),
			);
			await waitFor(() =>
				expect(mocks.commitChange).toHaveBeenCalledWith({
					projectId: "p",
					baseSnapshotId: "s7",
					message: `Delete ${PATH}`,
					changes: [{ op: "delete", path: PATH }],
				}),
			);
			await waitFor(() =>
				expect(mocks.toastSuccess).toHaveBeenCalledWith(
					"Committed 0123456 to main",
				),
			);
			expect(onChanged).toHaveBeenCalled();
		});

		it("offers a pull request as the other way to delete", async () => {
			mocks.confirm.mockImplementation(
				(options: { secondaryAction?: { onSelect: () => void } }) =>
					options.secondaryAction?.onSelect(),
			);
			const user = userEvent.setup();
			renderView();

			await chooseFileAction(user, "Delete file");

			expect(mocks.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					secondaryAction: expect.objectContaining({
						label: "Suggest as a pull request",
					}),
				}),
			);
			await waitFor(() =>
				expect(mocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({
						proposal: true,
						edits: [{ op: "delete", path: PATH }],
					}),
				),
			);
			expect(mocks.commitChange).not.toHaveBeenCalled();
		});

		it("keeps a reader's deletion a suggestion", async () => {
			const user = userEvent.setup();
			renderView({ canCommit: false });

			await chooseFileAction(user, "Delete file");

			expect(mocks.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmLabel: "Suggest deletion",
				}),
			);
			expect(mocks.commitChange).not.toHaveBeenCalled();
		});
	});

	describe("Rename", () => {
		async function openRename(user: ReturnType<typeof userEvent.setup>) {
			await chooseFileAction(user, "Rename");
			return screen.findByRole("dialog");
		}

		it("commits a deletion of the old path and the same text at the new one, as one commit", async () => {
			const user = userEvent.setup();
			renderView();
			const dialog = await openRename(user);

			const path = within(dialog).getByLabelText("New path");
			await user.clear(path);
			await user.type(path, ".claude/skills/review/CHECKLIST.md");
			expect(within(dialog).getByLabelText("Commit message")).toHaveValue(
				`Rename ${PATH} to .claude/skills/review/CHECKLIST.md`,
			);
			await user.click(
				within(dialog).getByRole("button", { name: "Commit to main" }),
			);

			await waitFor(() =>
				expect(mocks.commitChange).toHaveBeenCalledWith({
					projectId: "p",
					baseSnapshotId: "s7",
					message: `Rename ${PATH} to .claude/skills/review/CHECKLIST.md`,
					changes: [
						{ op: "delete", path: PATH },
						{
							op: "put",
							path: ".claude/skills/review/CHECKLIST.md",
							content: TEXT_FILE.body,
							encoding: "utf8",
						},
					],
				}),
			);
		});

		it("refuses a new path that is a file already, so a rename never overwrites one", async () => {
			const user = userEvent.setup();
			renderView();
			const dialog = await openRename(user);

			const path = within(dialog).getByLabelText("New path");
			await user.clear(path);
			await user.type(path, "docs/other.md");

			expect(
				within(dialog).getByText("A file already exists at that path."),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Commit to main" }),
			).toBeDisabled();
		});

		it("refuses a path Add file would refuse, in the same words", async () => {
			const user = userEvent.setup();
			renderView();
			const dialog = await openRename(user);

			const path = within(dialog).getByLabelText("New path");
			await user.clear(path);
			await user.type(path, "../outside.md");

			expect(
				within(dialog).getByText(
					"A path can't contain . or .. segments.",
				),
			).toBeInTheDocument();
			expect(
				within(dialog).getByRole("button", { name: "Commit to main" }),
			).toBeDisabled();
		});

		it("holds the commit back until the path is a different one", async () => {
			const user = userEvent.setup();
			renderView();
			const dialog = await openRename(user);

			expect(
				within(dialog).getByRole("button", { name: "Commit to main" }),
			).toBeDisabled();
		});

		it("offers a reader only the pull request", async () => {
			const user = userEvent.setup();
			renderView({ canCommit: false });
			const dialog = await openRename(user);

			expect(
				within(dialog).getByRole("button", {
					name: "Suggest as a pull request",
				}),
			).toBeInTheDocument();
			expect(
				within(dialog).queryByLabelText("Commit message"),
			).toBeNull();
			expect(
				within(dialog).queryByRole("button", { name: /^Commit to/ }),
			).toBeNull();
		});

		it("reports native rename and deletion suggestions without snapshot checks", async () => {
			const user = userEvent.setup();
			const nativeBase = { generation: 1, commitSha: SHA };
			renderView({ canCommit: false, nativeBase, snapshotId: undefined });
			const dialog = await openRename(user);
			const newPath = within(dialog).getByLabelText("New path");
			await user.clear(newPath);
			await user.type(newPath, "docs/renamed.md");
			await user.click(
				within(dialog).getByRole("button", {
					name: "Suggest as a pull request",
				}),
			);
			await waitFor(() =>
				expect(mocks.toastSuccess).toHaveBeenCalledWith(
					"Suggestion submitted. Fabric is opening the pull request.",
				),
			);
			await openFileActions(user);
			await user.click(
				screen.getByRole("menuitem", { name: "Delete file" }),
			);
			expect(mocks.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					title: `Suggest deleting ${PATH}? Fabric opens a pull request in ${TARGET.repository} against ${TARGET.ref}.`,
				}),
			);
		});

		it("is not offered on a project that is not repository-backed", async () => {
			const user = userEvent.setup();
			renderView({
				canCommit: false,
				canEdit: true,
				canPropose: false,
				repositoryTarget: null,
			});

			await screen.findByRole("button", { name: "Edit" });
			await openFileActions(user);

			expect(
				screen.queryByRole("menuitem", { name: "Rename" }),
			).toBeNull();
			expect(
				screen.getByRole("menuitem", { name: "Delete file" }),
			).toBeInTheDocument();
		});
	});
});
