/**
 * The bar above a file: its path in full ink, the kind, whether the published
 * version added or changed it, a size that does not read "0 KB", a Copy path
 * icon, Edit, and a File actions menu that holds Rename and Delete file; and
 * the reading column the body sits in.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFileActions } from "./file-actions-menu";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const mocks = vi.hoisted(() => ({
	confirm: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	file: { current: {} as Record<string, unknown> },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => mocks.toastInfo(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { instructions: { commitChange: vi.fn() } } },
}));

const TEXT_FILE = {
	path: ".claude/skills/review/SKILL.md",
	kind: "SKILL",
	name: "review",
	description: "Reviews a change.",
	size: 6349,
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
						queryFn: async () => mocks.file.current,
					}),
				},
				get: {
					queryOptions: (o: unknown) => ({
						queryKey: ["get", o],
						queryFn: async () => ({}),
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

import { InstructionFileView } from "../InstructionFileView";

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
	return render(
		<InstructionFileView
			projectId="p"
			snapshotId="s7"
			path={TEXT_FILE.path}
			existingPaths={new Set([TEXT_FILE.path])}
			onChanged={vi.fn()}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
}

beforeEach(() => {
	for (const fn of [
		mocks.confirm,
		mocks.toastInfo,
		mocks.toastError,
		mocks.toastSuccess,
	]) {
		fn.mockReset();
	}
	mocks.file.current = TEXT_FILE;
});

describe("the file header", () => {
	it("shows the path in full ink, the kind and a size that is not rounded to nothing", async () => {
		renderView();

		const path = await screen.findByText(TEXT_FILE.path);

		expect(path.tagName).toBe("CODE");
		expect(path).toHaveClass("text-foreground");
		expect(path).not.toHaveClass("text-muted-foreground");
		expect(screen.getByText("Skill")).toBeInTheDocument();
		expect(screen.getByText("6.2 KB")).toBeInTheDocument();
	});

	it.each([
		[0, "0 B"],
		[212, "212 B"],
		[1024, "1.0 KB"],
		[1.5 * 1024 * 1024, "1.5 MB"],
	])("writes a %d byte file as %s", async (size, written) => {
		mocks.file.current = { ...TEXT_FILE, size };
		renderView();

		expect(await screen.findByText(written)).toBeInTheDocument();
	});

	it("says a file the published version added was added in that version", async () => {
		renderView({ change: "added", publishedVersion: 7 });

		expect(await screen.findByText("Added in v7")).toBeInTheDocument();
		expect(screen.queryByText(/Changed in v/)).not.toBeInTheDocument();
	});

	it("says a file the published version changed was changed in that version", async () => {
		renderView({ change: "changed", publishedVersion: 7 });

		expect(await screen.findByText("Changed in v7")).toBeInTheDocument();
		expect(screen.queryByText(/Added in v/)).not.toBeInTheDocument();
	});

	it("says nothing about a file the published version left alone", async () => {
		renderView({ change: null, publishedVersion: 7 });

		await screen.findByText(TEXT_FILE.path);
		expect(
			screen.queryByText(/(Added|Changed) in v/),
		).not.toBeInTheDocument();
	});
});

describe("Copy path", () => {
	it("is an icon button named Copy path, with a tooltip that says Copied once it has copied", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		renderView();

		const copy = await screen.findByRole("button", { name: "Copy path" });
		expect(copy.textContent).toBe("");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		await user.click(copy);

		expect(writeText).toHaveBeenCalledWith(TEXT_FILE.path);
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith("Path copied"),
		);
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Copied");
	});

	it("says it could not copy, and not Copied, when the clipboard refuses", async () => {
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: vi.fn(async () => {
					throw new Error("denied");
				}),
			},
		});
		renderView();

		await user.click(
			await screen.findByRole("button", { name: "Copy path" }),
		);

		await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});
});

describe("the File actions menu", () => {
	it("keeps Delete file out of the header row: it is only in the menu, last, in the destructive colour", async () => {
		const user = userEvent.setup();
		renderView({ canEdit: true });

		await screen.findByRole("button", { name: "Edit" });
		expect(
			screen.queryByRole("button", { name: "Delete file" }),
		).not.toBeInTheDocument();
		await openFileActions(user);

		const items = screen.getAllByRole("menuitem");
		expect(items.map((item) => item.textContent)).toEqual(["Delete file"]);
		expect(items[0]).toHaveClass("text-destructive");
	});

	it("holds Rename, then a separator, then Delete file on a repository project", async () => {
		const user = userEvent.setup();
		renderView({
			canCommit: true,
			repositoryTarget: {
				repository: "example-org/instructions",
				ref: "main",
			},
		});

		await screen.findByRole("button", { name: "Edit" });
		await openFileActions(user);

		const menu = screen.getByRole("menu");
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Rename", "Delete file"]);
		expect(within(menu).getByRole("separator")).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "Delete file" }),
		).toHaveClass("text-destructive");
		expect(
			screen.getByRole("menuitem", { name: "Rename" }),
		).not.toHaveClass("text-destructive");
	});

	it("keeps Edit an outline button, beside the menu and not the menu's neighbour in red", async () => {
		renderView({ canEdit: true });

		const edit = await screen.findByRole("button", { name: "Edit" });

		expect(edit).toHaveClass("border-input");
		expect(edit).not.toHaveClass("text-destructive");
	});

	it("offers no menu to someone who may not change the file", async () => {
		renderView();

		await screen.findByText(TEXT_FILE.path);

		expect(
			screen.queryByRole("button", { name: "File actions" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Edit" }),
		).not.toBeInTheDocument();
	});

	it("asks the same confirmation as before when Delete file is chosen", async () => {
		const user = userEvent.setup();
		renderView({ canEdit: true });

		await screen.findByRole("button", { name: "Edit" });
		await openFileActions(user);
		await user.click(screen.getByRole("menuitem", { name: "Delete file" }));

		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: `Delete ${TEXT_FILE.path} and publish a new version?`,
				confirmLabel: "Delete file",
				destructive: true,
			}),
		);
	});
});

describe("the reading column", () => {
	it("caps a Markdown body near 72 characters a line", async () => {
		renderView();

		const heading = await screen.findByRole("heading", { name: "Review" });

		expect(heading.closest(".max-w-\\[72ch\\]")).not.toBeNull();
	});

	it("caps a plain file's text the same way", async () => {
		mocks.file.current = {
			...TEXT_FILE,
			path: "scripts/run.sh",
			kind: "SCRIPT",
			name: null,
			description: null,
			body: "echo hi",
		};
		renderView({ path: "scripts/run.sh" });

		const text = await screen.findByText("echo hi");

		expect(text.tagName).toBe("PRE");
		expect(text.closest(".max-w-\\[72ch\\]")).not.toBeNull();
	});
});
