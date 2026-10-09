/**
 * The file view's QA findings: what a link in the text opens, how the text
 * renders, the draft that survives leaving the tab, and what follows a
 * deletion or a rename on a repository project.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseFileAction } from "./file-actions-menu";

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
	confirm: vi.fn(),
	toastInfo: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	body: { current: "" },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { instructions: { commitChange: mocks.commitChange } },
	},
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

const PATH = ".claude/skills/review/SKILL.md";
const SHA = "0123456789abcdef0123456789abcdef01234567";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getFile: {
					queryOptions: (o: unknown) => ({
						queryKey: ["getFile", o],
						queryFn: async () => ({
							path: PATH,
							kind: "SKILL",
							name: null,
							description: null,
							size: 120,
							mimeType: "text/markdown",
							isText: true,
							mode: null,
							body: mocks.body.current,
							offset: 0,
							nextOffset: null,
							truncated: false,
							url: null,
						}),
					}),
				},
				get: {
					queryOptions: (o: unknown) => ({
						queryKey: ["get", o],
						queryFn: async () => ({
							status: "READY",
							commitOutcome: {
								outcome: "committed",
								sha: SHA,
								ref: "main",
							},
						}),
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
								pullRequest: { url: null },
							}),
						}),
					},
				},
			},
		},
	},
}));

import { InstructionDraftsProvider } from "../InstructionDrafts";
import { InstructionFileView } from "../InstructionFileView";

const TARGET = { repository: "example-org/instructions", ref: "main" };
const LINKS = {
	provider: "GITHUB",
	repositoryUrl: "https://github.com/example-org/instructions",
	ref: "feature/links",
	rootPath: "",
};

type ViewProps = Partial<React.ComponentProps<typeof InstructionFileView>>;

function view(props: ViewProps = {}) {
	return (
		<InstructionFileView
			projectId="p"
			snapshotId="s7"
			path={PATH}
			canCommit
			canPropose
			repositoryTarget={TARGET}
			existingPaths={new Set([PATH, ".claude/skills/review/docs/a.md"])}
			onChanged={vi.fn()}
			{...props}
		/>
	);
}

function renderViewWithRerender(props: ViewProps = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const tree = (next: ViewProps) => (
		<QueryClientProvider client={client}>{view(next)}</QueryClientProvider>
	);
	const result = render(tree(props));
	return { rerender: (next: ViewProps) => result.rerender(tree(next)) };
}

function renderView(props: ViewProps = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			{view(props)}
		</QueryClientProvider>,
	);
}

/** A page whose tab body comes and goes while the holder above it stays. */
function renderTab(props: ViewProps = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const page = (shown: boolean, next: ViewProps = props) => (
		<QueryClientProvider client={client}>
			<InstructionDraftsProvider>
				<div>{shown ? view(next) : null}</div>
			</InstructionDraftsProvider>
		</QueryClientProvider>
	);
	const tree = render(page(true));
	return {
		leave: () => tree.rerender(page(false)),
		returnTo: (next: ViewProps = props) => tree.rerender(page(true, next)),
	};
}

beforeEach(() => {
	for (const fn of [
		mocks.commitChange,
		mocks.confirm,
		mocks.toastInfo,
		mocks.toastSuccess,
		mocks.toastError,
	]) {
		fn.mockReset();
	}
	mocks.body.current = "# Review\n\nOriginal body.";
	mocks.commitChange.mockResolvedValue({
		snapshotId: "snap_commit",
		version: 8,
		baseSnapshotId: "s7",
		fileCount: 4,
		putCount: 1,
		deleteCount: 0,
		status: "RECEIVING",
	});
	mocks.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
});

describe("InstructionFileView — links in the text", () => {
	beforeEach(() => {
		mocks.body.current = [
			"[doc](./docs/a.md)",
			"[readme](../README.md)",
			"[top](#usage)",
			"[site](https://example.com/guide)",
		].join("\n\n");
	});

	it("opens a relative link to an instruction file in the view, not in the app", async () => {
		const user = userEvent.setup();
		const onOpenPath = vi.fn();
		renderView({ repositoryLinks: LINKS, onOpenPath });

		await user.click(await screen.findByRole("link", { name: "doc" }));

		expect(onOpenPath).toHaveBeenCalledWith(
			".claude/skills/review/docs/a.md",
		);
	});

	it("sends a relative link to any other file to the repository at the ref on screen", async () => {
		renderView({ repositoryLinks: LINKS, onOpenPath: vi.fn() });

		const link = await screen.findByRole("link", { name: "readme" });

		expect(link).toHaveAttribute(
			"href",
			"https://github.com/example-org/instructions/blob/feature/links/.claude/skills/README.md",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("sends an in-page anchor to the same file in the repository", async () => {
		renderView({ repositoryLinks: LINKS, onOpenPath: vi.fn() });

		const link = await screen.findByRole("link", { name: "top" });

		expect(link).toHaveAttribute(
			"href",
			`https://github.com/example-org/instructions/blob/feature/links/${PATH}#usage`,
		);
	});

	it("opens an external link in a new tab without handing it the opener", async () => {
		renderView({ repositoryLinks: LINKS });

		const link = await screen.findByRole("link", { name: "site" });

		expect(link).toHaveAttribute("href", "https://example.com/guide");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("shows a relative link with nowhere to go as plain text, not as a link that 404s", async () => {
		renderView({ repositoryLinks: null, onOpenPath: undefined });

		await screen.findByText("readme");

		expect(screen.queryByRole("link", { name: "readme" })).toBeNull();
		expect(screen.queryByRole("link", { name: "doc" })).toBeNull();
		expect(screen.getByRole("link", { name: "site" })).toBeInTheDocument();
	});
});

describe("InstructionFileView — how the text renders", () => {
	it("keeps a fenced block's lines out of inline-code chips", async () => {
		mocks.body.current = "```sh\nexport A=1\nrun --now\n```";
		const { container } = renderView();

		await screen.findByText(/export A=1/);

		const prose = container.querySelector(".prose");
		expect(prose?.className).toContain("[&_pre_code]:border-0");
		expect(prose?.className).toContain("[&_pre_code]:bg-transparent");
		expect(prose?.className).toContain("[&_pre_code]:p-0");
	});

	it("lets a wide table keep a readable column width and scroll sideways", async () => {
		mocks.body.current = "| a | b |\n| - | - |\n| 1 | 2 |";
		const { container } = renderView();

		const table = await screen.findByRole("table");

		const prose = container.querySelector(".prose");
		expect(prose?.className).toContain("[&_td]:min-w-32");
		expect(prose?.className).toContain("[&_th]:min-w-32");
		expect(table.parentElement?.className).toContain("overflow-x-auto");
	});

	it("renders an escaped arrow literally, with ligatures off", async () => {
		mocks.body.current = "end of note \\-->";
		const { container } = renderView();

		await screen.findByText(/end of note/);

		const prose = container.querySelector(".prose");
		expect(prose?.textContent).toContain("-->");
		expect(prose?.className).toContain("[font-variant-ligatures:none]");
	});
});

describe("InstructionFileView — a draft kept while the tab is away", () => {
	it("is still there, with the text typed, when the view comes back", async () => {
		const user = userEvent.setup();
		const tab = renderTab();
		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.type(
			screen.getByRole("textbox", { name: /Contents of/ }),
			" unsaved words",
		);

		tab.leave();
		expect(screen.queryByRole("textbox")).toBeNull();
		tab.returnTo();

		const editor = await screen.findByRole("textbox", {
			name: /Contents of/,
		});
		expect(editor).toHaveValue("# Review\n\nOriginal body. unsaved words");
	});

	it("asks the page to open the file the draft is for when the view returns on another file", async () => {
		const user = userEvent.setup();
		const onOpenPath = vi.fn();
		const tab = renderTab({ onOpenPath });
		await user.click(await screen.findByRole("button", { name: "Edit" }));

		tab.leave();
		tab.returnTo({ path: "AGENTS.md", onOpenPath });

		await waitFor(() => expect(onOpenPath).toHaveBeenCalledWith(PATH));
	});

	it("is dropped once it is cancelled", async () => {
		const user = userEvent.setup();
		const tab = renderTab();
		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		tab.leave();
		tab.returnTo();

		await screen.findByRole("button", { name: "Edit" });
		expect(screen.queryByRole("textbox")).toBeNull();
	});
});

describe("InstructionFileView — after a commit on a repository project", () => {
	it("does not read the deleted file back, so the commit is announced once", async () => {
		const user = userEvent.setup();
		const onCommitted = vi.fn();
		renderView({ onCommitted });

		await chooseFileAction(user, "Delete file");

		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Committed 0123456 to main",
			),
		);
		expect(onCommitted).not.toHaveBeenCalled();
	});

	it("still reads the file back after an edit is committed", async () => {
		const user = userEvent.setup();
		const onCommitted = vi.fn();
		renderView({ onCommitted });
		await user.click(await screen.findByRole("button", { name: "Edit" }));
		await user.type(
			screen.getByRole("textbox", { name: /Contents of/ }),
			" more",
		);

		await user.click(
			screen.getByRole("button", { name: "Commit to main" }),
		);

		await waitFor(() =>
			expect(onCommitted).toHaveBeenCalledWith({ sha: SHA, ref: "main" }),
		);
	});

	it("reports the rename once, closes the dialog, and never reopens it on the renamed file", async () => {
		const user = userEvent.setup();
		const onRenamed = vi.fn();
		const onOpenPath = vi.fn();
		const props = { onRenamed, onOpenPath };
		const { rerender } = renderViewWithRerender(props);
		await chooseFileAction(user, "Rename");
		const dialog = await screen.findByRole("dialog");
		const path = within(dialog).getByLabelText("New path");
		await user.clear(path);
		await user.type(path, ".claude/skills/review/CHECKLIST.md");

		await user.click(
			within(dialog).getByRole("button", { name: "Commit to main" }),
		);

		await waitFor(() =>
			expect(onRenamed).toHaveBeenCalledWith(
				".claude/skills/review/CHECKLIST.md",
			),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		rerender({ ...props, path: ".claude/skills/review/CHECKLIST.md" });
		await screen.findByRole("button", { name: "Edit" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onRenamed).toHaveBeenCalledTimes(1);
		expect(onOpenPath).not.toHaveBeenCalled();
	});
});
