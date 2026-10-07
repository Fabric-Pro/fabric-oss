/**
 * The Commits view of a repository-backed project (Fizzy #2878 §10): the synced
 * branch's own history with Fabric's view of each commit laid over it, paged,
 * with Revert as its one write.
 *
 * `listCommits` and `revertCommit` are the mocked procedures; copy is the real
 * `en.json`, so what is asserted is what ships.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
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

type Row = {
	sha: string;
	author: { name: string };
	date: string;
	message: string | null;
	messageWithheld?: boolean;
	url: string;
	parent: string | null;
	published: number | null;
	refused: boolean;
	isFabric: boolean;
};

const mocks = vi.hoisted(() => ({
	/** The page `listCommits` answers for a cursor, and what it was asked. */
	pages: new Map<number, unknown>(),
	listCalls: [] as Array<Record<string, unknown>>,
	listFails: { current: false },
	/** What a failing `listCommits` throws; a plain error when unset. */
	listError: { current: null as unknown },
	compareCalls: [] as Array<Record<string, unknown>>,
	revert: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repository: {
					getCommitParent: {
						queryOptions: () => ({
							queryKey: ["commitParent"],
							enabled: false,
						}),
					},
				},
				repositorySync: {
					listCommits: {
						queryOptions: (o: {
							input: { projectId: string; cursor?: number };
						}) => ({
							queryKey: ["listCommits", o.input],
							queryFn: async () => {
								mocks.listCalls.push(o.input);
								if (mocks.listFails.current) {
									throw (
										mocks.listError.current ??
										new Error("unreachable")
									);
								}
								return mocks.pages.get(o.input.cursor ?? 1);
							},
						}),
						key: () => ["listCommits"],
					},
					compareCommits: {
						queryOptions: (o: {
							input: Record<string, unknown>;
						}) => ({
							queryKey: ["compareCommits", o.input],
							queryFn: async () => {
								mocks.compareCalls.push(o.input);
								return {
									from: { sha: o.input.from },
									to: { sha: o.input.to },
									added: [],
									removed: [],
									changed: [],
									truncated: false,
								};
							},
						}),
					},
					readCommitFile: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["readCommitFile", o.input],
							queryFn: async () => ({ state: "absent" }),
						}),
					},
				},
				revertCommit: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: (input: unknown) => mocks.revert(input),
						...opts,
					}),
				},
			},
		},
	},
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
		info: (...a: unknown[]) => mocks.toastInfo(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
	},
}));

import { InstructionsCommits } from "../InstructionsCommits";

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";
const SHA_C = "c3d4e5f60718293a4b5c6d7e8f90123456789012";
const SHA_D = "d4e5f60718293a4b5c6d7e8f9012345678901234";
const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";

function row(sha: string, over: Partial<Row> = {}): Row {
	return {
		sha,
		author: { name: "Example Member" },
		date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
		message: `Change ${sha.slice(0, 3)}\n\nA longer body.`,
		url: `https://github.com/example-org/instructions/commit/${sha}`,
		parent: "9".repeat(40),
		published: null,
		refused: false,
		isFabric: false,
		...over,
	};
}

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderCommits(
	props: Partial<ComponentProps<typeof InstructionsCommits>> = {},
) {
	const onChanged = vi.fn();
	const onCommitted = vi.fn();
	const view = render(
		<InstructionsCommits
			projectId="p"
			open
			onOpenChange={() => undefined}
			provider="GITHUB"
			branch="main"
			rootPath=""
			published={{ sha: SHA_B, version: 7 }}
			canRevert
			canCompare
			onChanged={onChanged}
			onCommitted={onCommitted}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
	return { onChanged, onCommitted, ...view };
}

function rows() {
	return screen.getAllByTestId("commit-row");
}

function detail() {
	return screen.getByTestId("commit-detail");
}

function detailAction(name: string) {
	return within(detail()).getByRole("button", { name });
}

beforeEach(() => {
	mocks.pages.clear();
	mocks.listCalls.length = 0;
	mocks.compareCalls.length = 0;
	mocks.listFails.current = false;
	mocks.listError.current = null;
	for (const fn of [
		mocks.revert,
		mocks.confirm,
		mocks.toastSuccess,
		mocks.toastInfo,
		mocks.toastError,
	]) {
		fn.mockReset();
	}
	mocks.revert.mockResolvedValue({
		outcome: "reverted",
		sha: NEW_SHA,
		ref: "main",
		fileCount: 2,
	});
	mocks.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
	mocks.pages.set(1, {
		commits: [
			row(SHA_A, { published: null }),
			row(SHA_B, { published: 7 }),
			row(SHA_C, { refused: true }),
			row(SHA_D),
		],
		nextCursor: null,
	});
});

describe("InstructionsCommits — the list", () => {
	it("reads nothing from the repository until it is opened", async () => {
		renderCommits({ open: false });

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.listCalls).toEqual([]);
	});

	it("titles itself with the branch and says which folder the commits touched", async () => {
		renderCommits({ rootPath: ".claude" });

		expect(await screen.findByText("Commits on main")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Every commit on main that touched .claude, newest first.",
			),
		).toBeInTheDocument();
	});

	it("says every commit on the branch when the folder is the whole repository", async () => {
		renderCommits({ rootPath: "" });

		expect(
			await screen.findByText("Every commit on main, newest first."),
		).toBeInTheDocument();
	});

	it("shows each compact row's short sha, subject, author and age, with the provider link in the selected detail", async () => {
		renderCommits();

		await screen.findAllByTestId("commit-row");
		const first = rows()[0] as HTMLElement;
		expect(within(first).getByText("Change a1b")).toBeInTheDocument();
		const sha = within(first).getByText("a1b2c3d");
		expect(sha.tagName).toBe("CODE");
		const providerLink = within(detail()).getByRole("link", {
			name: "Open in GitHub",
		});
		expect(providerLink).toHaveAttribute(
			"href",
			`https://github.com/example-org/instructions/commit/${SHA_A}`,
		);
		expect(providerLink).toHaveAttribute("rel", "noopener noreferrer");
		expect(within(first).getByText("Example Member")).toBeInTheDocument();
		expect(within(first).getByText(/ago/)).toBeInTheDocument();
		// The body is not the subject.
		expect(within(first).queryByText(/A longer body/)).toBeNull();
	});

	it("marks the commit Fabric's copy is of as Published, a refused one as refused, and a newer one as not synced yet", async () => {
		renderCommits();

		await screen.findAllByTestId("commit-row");
		const [newer, current, refused, older] = rows() as HTMLElement[];
		expect(within(newer).getByText("Not synced yet")).toBeInTheDocument();
		expect(within(current).getByText("Published")).toBeInTheDocument();
		expect(
			within(refused).getByText("Refused by scan"),
		).toBeInTheDocument();
		// Below the published commit, with no copy of its own: passed over by a
		// sync that took a later tip, not "not synced".
		expect(within(older).queryByText("Not synced yet")).toBeNull();
		expect(within(older).queryByText("Published")).toBeNull();
	});

	it("calls every commit Fabric holds no copy of not synced yet when nothing is published", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A), row(SHA_B), row(SHA_C)],
			nextCursor: null,
		});
		renderCommits({ published: { sha: null, version: null } });

		await screen.findAllByTestId("commit-row");
		for (const element of rows()) {
			expect(
				within(element).getByText("Not synced yet"),
			).toBeInTheDocument();
		}
	});

	it("says the message was withheld, muted, and keeps its provider link in detail", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A, { message: null, messageWithheld: true })],
			nextCursor: null,
		});
		renderCommits();

		await screen.findAllByTestId("commit-row");
		const only = rows()[0] as HTMLElement;
		const withheld = within(only).getByText("Message withheld");
		expect(withheld.className).toContain("text-muted-foreground");
		expect(
			within(detail()).getByRole("link", { name: "Open in GitHub" }),
		).toBeInTheDocument();
	});

	it("shows only the first line of a long subject, never the whole message", async () => {
		mocks.pages.set(1, {
			commits: [
				row(SHA_A, {
					message:
						"Tighten lint rules\n\nThis also renames a few things.",
				}),
			],
			nextCursor: null,
		});
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(
			await within(rows()[0] as HTMLElement).findByText(
				"Tighten lint rules",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/renames a few things/)).toBeNull();
	});
});

describe("InstructionsCommits — selection and comparison", () => {
	it("selects a compact row, then clears the detail when the loaded-history filter excludes it", async () => {
		const user = userEvent.setup();
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(rows()[0]).toHaveAttribute("aria-pressed", "true");
		await user.click(rows()[1] as HTMLElement);
		expect(rows()[1]).toHaveAttribute("aria-pressed", "true");
		expect(within(detail()).getByText("Change b2c")).toBeInTheDocument();

		await user.type(
			screen.getByRole("textbox", { name: "Filter loaded commits" }),
			"Change a1b",
		);

		expect(
			within(detail()).getByText(
				"Select a loaded commit to see its details.",
			),
		).toBeInTheDocument();
		expect(mocks.compareCalls).toEqual([]);
	});

	it("defers a comparison until requested and resets it when another commit is selected", async () => {
		const user = userEvent.setup();
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(mocks.compareCalls).toEqual([]);
		await user.click(detailAction("Compare with parent"));
		await waitFor(() =>
			expect(mocks.compareCalls).toEqual([
				{ projectId: "p", from: "9".repeat(40), to: SHA_A },
			]),
		);
		expect(screen.getByTestId("commit-comparison")).toBeInTheDocument();

		await user.click(rows()[1] as HTMLElement);
		expect(screen.queryByTestId("commit-comparison")).toBeNull();
		await user.click(detailAction("Compare with parent"));
		await waitFor(() =>
			expect(mocks.compareCalls).toContainEqual({
				projectId: "p",
				from: "9".repeat(40),
				to: SHA_B,
			}),
		);
	});
});

describe("InstructionsCommits — paging", () => {
	it("loads older commits a page at a time, keeping what is already on screen", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A), row(SHA_B)],
			nextCursor: 2,
		});
		mocks.pages.set(2, {
			commits: [row(SHA_C), row(SHA_D)],
			nextCursor: null,
		});
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");
		expect(rows()).toHaveLength(2);

		await user.click(
			screen.getByRole("button", { name: "Load older commits" }),
		);

		await waitFor(() => expect(rows()).toHaveLength(4));
		expect(mocks.listCalls).toContainEqual({ projectId: "p", cursor: 2 });
		// Newest first across the pages.
		expect(
			rows().map(
				(element) =>
					within(element).getByText(/^[0-9a-f]{7}$/).textContent,
			),
		).toEqual(["a1b2c3d", "b2c3d4e", "c3d4e5f", "d4e5f60"]);
		// The last page: nothing older to load.
		expect(
			screen.queryByRole("button", { name: "Load older commits" }),
		).toBeNull();
	});

	it("offers no Load older commits on a single page", async () => {
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(
			screen.queryByRole("button", { name: "Load older commits" }),
		).toBeNull();
	});
});

describe("InstructionsCommits — when there is nothing to show", () => {
	it("says no commit has touched the folder yet", async () => {
		mocks.pages.set(1, { commits: [], nextCursor: null });
		renderCommits();

		expect(
			await screen.findByText(
				"No commit on main has touched this folder yet.",
			),
		).toBeInTheDocument();
	});

	it("says it could not read the repository, never an empty history, and tries again", async () => {
		mocks.listFails.current = true;
		const user = userEvent.setup();
		renderCommits();

		expect(
			await screen.findByText(
				"Couldn't read the commits from the repository. Try again.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/has touched this folder/)).toBeNull();

		mocks.listFails.current = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));

		await screen.findAllByTestId("commit-row");
	});

	// Azure DevOps cannot list the history of a folder that is no longer on
	// the branch; trying again would fail the same way for ever.
	it("names a synced folder that is gone, and offers no retry", async () => {
		mocks.listFails.current = true;
		mocks.listError.current = Object.assign(new Error("folder"), {
			data: { code: "FOLDER_NOT_FOUND" },
		});
		renderCommits({ rootPath: "team" });

		expect(
			await screen.findByText(
				"team/ isn't on main any more, so its commits can't be listed. It was removed or renamed: choose the folder again in the sync settings.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});
});

describe("InstructionsCommits — Open in the provider", () => {
	it.each([
		["GITHUB", "GitHub"],
		["GITLAB", "GitLab"],
		["AZURE_DEVOPS", "Azure DevOps"],
	])("links each commit in %s with its own name", async (provider, name) => {
		renderCommits({ provider });

		await screen.findAllByTestId("commit-row");
		expect(
			within(detail()).getByRole("link", { name: `Open in ${name}` }),
		).toHaveAttribute(
			"href",
			`https://github.com/example-org/instructions/commit/${SHA_A}`,
		);
	});

	it("never links an address that is not https", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A, { url: "javascript:alert(1)" })],
			nextCursor: null,
		});
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(within(detail()).queryByRole("link")).toBeNull();
		expect(within(detail()).getByText("a1b2c3d")).toBeInTheDocument();
	});
});

describe("InstructionsCommits — Revert", () => {
	it("offers no Revert to someone who cannot commit, but still shows them the history", async () => {
		renderCommits({ canRevert: false });

		await screen.findAllByTestId("commit-row");
		expect(
			within(detail()).queryByRole("button", { name: "Revert" }),
		).toBeNull();
		expect(rows()).toHaveLength(4);
	});

	it("offers no Revert on a commit with no parent", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A), row(SHA_B, { parent: null })],
			nextCursor: null,
		});
		renderCommits();

		const user = userEvent.setup();
		await screen.findAllByTestId("commit-row");
		expect(detailAction("Revert")).toBeInTheDocument();
		await user.click(rows()[1] as HTMLElement);
		expect(
			within(detail()).queryByRole("button", { name: "Revert" }),
		).toBeNull();
	});

	it("asks before reverting, naming the commit and the branch, and does not skip the question", async () => {
		mocks.confirm.mockImplementation(() => undefined);
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");

		await user.click(detailAction("Revert"));

		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Revert a1b2c3d? This commits a revert to main.",
				confirmLabel: "Revert",
				destructive: true,
			}),
		);
		expect(mocks.revert).not.toHaveBeenCalled();
	});

	it("reverts the commit once confirmed, says what it committed, tells the tab, and re-reads the list", async () => {
		const user = userEvent.setup();
		const { onChanged, onCommitted } = renderCommits();
		await screen.findAllByTestId("commit-row");
		const listed = mocks.listCalls.length;

		await user.click(detailAction("Revert"));

		await waitFor(() =>
			expect(mocks.revert).toHaveBeenCalledWith({
				projectId: "p",
				sha: SHA_A,
			}),
		);
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Reverted a1b2c3d with commit 0123456 on main",
			),
		);
		expect(onCommitted).toHaveBeenCalledWith({ sha: NEW_SHA, ref: "main" });
		expect(onChanged).toHaveBeenCalled();
		await waitFor(() =>
			expect(mocks.listCalls.length).toBeGreaterThan(listed),
		);
	});

	it("says nothing was committed when the branch already has the files as they were", async () => {
		mocks.revert.mockResolvedValue({ outcome: "unchanged", sha: NEW_SHA });
		const user = userEvent.setup();
		const { onCommitted } = renderCommits();
		await screen.findAllByTestId("commit-row");

		await user.click(detailAction("Revert"));

		await waitFor(() =>
			expect(mocks.toastInfo).toHaveBeenCalledWith(
				"Nothing to revert: main already has the files as they were before a1b2c3d.",
			),
		);
		expect(onCommitted).not.toHaveBeenCalled();
	});

	it("says the revert is still running when it outlived the request", async () => {
		mocks.revert.mockResolvedValue({
			outcome: "pending",
			requestId: "req_1",
		});
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");

		await user.click(detailAction("Revert"));

		await waitFor(() =>
			expect(mocks.toastInfo).toHaveBeenCalledWith(
				"The revert is still running and continues in the background. Reload Commits in a minute.",
			),
		);
	});

	it.each([
		[
			"REVERT_CONFLICT",
			"A later commit changed one of these files, so this commit can't be undone on its own. Edit the files and commit the result instead.",
		],
		[
			"BRANCH_PROTECTED",
			"main is protected, so Fabric can't push a revert to it. Revert the commit in your repository instead.",
		],
		[
			"BRANCH_BUSY",
			"main changed while the revert was being made. Try again.",
		],
		[
			"REVERT_REJECTED",
			"Undoing this commit would restore a file that looks like it contains a credential, so Fabric won't commit it.",
		],
		[
			"REVERT_TOO_LARGE",
			"This commit touches too many files, or a file that is too large, to undo from Fabric.",
		],
		[
			"REVERT_EMPTY",
			"This commit changed nothing in the synced folder, so there is nothing to revert.",
		],
		[
			"REVERT_UNSUPPORTED",
			"A merge commit or a repository's first commit can't be undone from Fabric.",
		],
		[
			"COMMIT_NOT_FOUND",
			"That commit is no longer on main. Reload Commits and try again.",
		],
	])(
		"words a refused revert (%s) in plain words, never the server's text",
		async (code, sentence) => {
			mocks.revert.mockRejectedValue({
				code: "CONFLICT",
				data: { code },
				message: "TEXT THAT MUST NOT BE SHOWN",
			});
			const user = userEvent.setup();
			renderCommits();
			await screen.findAllByTestId("commit-row");

			await user.click(detailAction("Revert"));

			await waitFor(() =>
				expect(mocks.toastError).toHaveBeenCalledWith(sentence),
			);
			expect(mocks.toastError).not.toHaveBeenCalledWith(
				"TEXT THAT MUST NOT BE SHOWN",
			);
		},
	);

	it("words Read-only mode as that, through the shared error map", async () => {
		mocks.revert.mockRejectedValue({
			code: "CONFLICT",
			data: { errorCode: "PROJECT_READ_ONLY" },
		});
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");

		await user.click(detailAction("Revert"));

		await waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith(
				en.projects.codingInstructions.actionErrors.readOnlyMode,
			),
		);
	});

	it("holds every Revert while one is running, and says which commit is being reverted", async () => {
		let finish: (value: unknown) => void = () => undefined;
		mocks.revert.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");

		await user.click(detailAction("Revert"));

		await waitFor(() => expect(detailAction("Reverting…")).toBeDisabled());
		finish({ outcome: "unchanged", sha: NEW_SHA });
	});
});

describe("InstructionsCommits — Compare with parent", () => {
	it("opens the commit's own diff, the commit against its parent", async () => {
		const user = userEvent.setup();
		renderCommits();
		await screen.findAllByTestId("commit-row");

		expect(mocks.compareCalls).toEqual([]);
		await user.click(detailAction("Compare with parent"));
		await waitFor(() =>
			expect(mocks.compareCalls).toEqual([
				{ projectId: "p", from: "9".repeat(40), to: SHA_A },
			]),
		);
	});

	it("offers no comparison to someone who may not read file bodies, though the history stays visible", async () => {
		renderCommits({ canCompare: false });

		await screen.findAllByTestId("commit-row");
		expect(
			screen.queryByRole("button", { name: "Compare with parent" }),
		).toBeNull();
		expect(rows()).toHaveLength(4);
	});

	it("removes an open comparison when comparison permission is withdrawn", async () => {
		const user = userEvent.setup();
		const { rerender } = renderCommits();
		await screen.findAllByTestId("commit-row");
		await user.click(detailAction("Compare with parent"));
		await screen.findByTestId("commit-comparison");

		rerender(
			<TestQueryProvider>
				<InstructionsCommits
					projectId="p"
					open
					onOpenChange={() => undefined}
					provider="GITHUB"
					branch="main"
					rootPath=""
					published={{ sha: SHA_B, version: 7 }}
					canRevert
					canCompare={false}
					onChanged={() => undefined}
				/>
			</TestQueryProvider>,
		);

		expect(screen.queryByTestId("commit-comparison")).toBeNull();
	});

	it("still offers a comparison in Read-only mode, which refuses writes and not reads", async () => {
		renderCommits({ canRevert: false, canCompare: true });

		await screen.findAllByTestId("commit-row");
		expect(detailAction("Compare with parent")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
	});

	it("offers none on a commit with no parent to compare with", async () => {
		mocks.pages.set(1, {
			commits: [row(SHA_A, { parent: null })],
			nextCursor: null,
		});
		renderCommits();

		await screen.findAllByTestId("commit-row");
		expect(
			screen.queryByRole("button", { name: "Compare with parent" }),
		).toBeNull();
	});
});

describe("InstructionsCommits — around the list", () => {
	it("keeps many sync runs behind a bounded native disclosure", async () => {
		const user = userEvent.setup();
		renderCommits({
			syncRuns: (
				<div data-testid="sync-runs">
					{Array.from({ length: 30 }, (_, index) => (
						<p key={index}>Run {index + 1}</p>
					))}
				</div>
			),
		});

		await screen.findAllByTestId("commit-row");
		const syncRuns = screen.getByTestId("sync-runs");
		const disclosure = syncRuns.closest("details");
		expect(disclosure).not.toBeNull();
		expect(syncRuns.parentElement).toHaveClass(
			"max-h-24",
			"md:max-h-40",
			"overflow-auto",
		);
		await user.click(screen.getByText("Sync runs"));
		expect(disclosure).toHaveAttribute("open");
	});

	it("offers no publish, roll back or delete, since Fabric's copy follows the branch", async () => {
		renderCommits();

		await screen.findAllByTestId("commit-row");
		for (const name of [
			/publish this version/i,
			/roll back/i,
			/^delete/i,
			/download/i,
		]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});
});
