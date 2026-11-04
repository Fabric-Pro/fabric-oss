/**
 * The shared repository-sync selection tree (Fizzy #2750 §3, §9): the
 * listing states, the three box states and how a partial one is announced
 * (once, on the tree item), a row that cannot be clicked saying why through
 * `aria-describedby`, the click handed to the adapter, Select all / Select
 * none, Collapse all and folders the dialog asks to open, the keyboard order
 * and the WAI-ARIA tree keys, "Show only selected", a search that shows the
 * adapter's verdict over the whole listing, and the summary. Like the
 * sibling suites, this resolves the REAL `en.json` copy and throws on a
 * missing key.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RepositoryTreeEntry,
	RepositoryTreeNode,
} from "../lib/repository-tree";
import type {
	SelectionRow,
	SelectionSummaryModel,
	SelectionTreeListing,
} from "../lib/selection-row";
import { TREE_TYPE_AHEAD_MS } from "../lib/use-tree-keyboard";
import { RepositorySyncSelectionTree } from "../RepositorySyncSelectionTree";
import { SelectionSummary } from "../SelectionSummary";
import { boxIn, chevronIn, queryTreeItem, treeItem } from "./tree-queries";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	return (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out
				.replaceAll(`{${name}, number}`, String(value))
				.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

const NAMESPACE = "projects.contexts.livingMemory.repositorySync" as const;

const ENTRIES: RepositoryTreeEntry[] = [
	{ path: "docs", type: "dir" },
	{ path: "docs/guide.md", type: "file" },
	{ path: "docs/old", type: "dir" },
	{ path: "docs/old/notes.md", type: "file" },
	{ path: "docs/logo.png", type: "file" },
	{ path: "README.md", type: "file" },
	{ path: "tools", type: "dir" },
	{ path: "tools/run.md", type: "file" },
];

const ready = (
	entries: RepositoryTreeEntry[] = ENTRIES,
	truncated = false,
): SelectionTreeListing => ({ status: "ready", entries, truncated });

const ROWS: Record<string, SelectionRow> = {
	docs: { membership: "mixed", disabledReason: null },
	"docs/guide.md": { membership: "in", disabledReason: null },
	"docs/old": { membership: "out", disabledReason: null },
	"docs/logo.png": {
		membership: "out",
		disabledReason: { key: "tree.selection.nonText" },
	},
	"README.md": {
		membership: "in",
		disabledReason: null,
		note: {
			key: "tree.selection.defaultRule",
			values: { rule: "README.md" },
		},
	},
	tools: { membership: "unknown", disabledReason: null },
};

function rowOf(node: RepositoryTreeNode): SelectionRow {
	return ROWS[node.path] ?? { membership: "out", disabledReason: null };
}

function renderTree(
	props: Partial<Parameters<typeof RepositorySyncSelectionTree>[0]> = {},
) {
	const handlers = {
		onToggle: vi.fn(),
		onSelectAll: vi.fn(),
		onSelectNone: vi.fn(),
	};
	const view = render(
		<RepositorySyncSelectionTree
			namespace={NAMESPACE}
			listing={ready()}
			row={rowOf}
			disabled={false}
			summary={<p>summary slot</p>}
			{...handlers}
			{...props}
		/>,
	);
	return { ...view, ...handlers };
}

/** What assistive technology reads of a row. */
const item = (path: string) => treeItem(path);
/** The box drawn in a row, for the pointer. */
const box = (path: string) => boxIn(treeItem(path));
/** The paths of the rows on screen, top to bottom. */
const rowsOnScreen = () =>
	screen
		.getAllByRole("treeitem")
		.map((element) => element.getAttribute("aria-label"));

describe("RepositorySyncSelectionTree", () => {
	it("renders nothing while there is no repository or branch to list", () => {
		const { container } = renderTree({ listing: { status: "idle" } });
		expect(container).toBeEmptyDOMElement();
	});

	it("says the listing is loading, and keeps Select all and Select none", () => {
		renderTree({ listing: { status: "loading" } });
		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading the branch's folders and files…",
		);
		expect(
			screen.getByRole("button", { name: "Select all" }),
		).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Select none" }),
		).toBeEnabled();
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Show only selected" }),
		).not.toBeInTheDocument();
	});

	it("words a failed listing as the feature does", () => {
		renderTree({
			listing: { status: "error", message: { key: "tree.error" } },
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Couldn't list this branch's folders and files.",
		);
	});

	it("says when the provider cannot list, when the branch is empty, and when the listing is truncated", () => {
		const { rerender } = renderTree({ listing: { status: "unsupported" } });
		expect(
			screen.getByText(/doesn't support browsing/),
		).toBeInTheDocument();
		const props = {
			namespace: NAMESPACE,
			row: rowOf,
			onToggle: vi.fn(),
			onSelectAll: vi.fn(),
			onSelectNone: vi.fn(),
			disabled: false,
			summary: null,
		};
		rerender(
			<RepositorySyncSelectionTree {...props} listing={ready([])} />,
		);
		expect(
			screen.getByText("No files on this branch."),
		).toBeInTheDocument();
		expect(screen.queryByRole("tree")).not.toBeInTheDocument();
		rerender(
			<RepositorySyncSelectionTree
				{...props}
				listing={ready(ENTRIES, true)}
			/>,
		);
		expect(
			screen.getByText(/only the first 20000 entries are shown/),
		).toBeInTheDocument();
	});

	it("is a tree of items, each announcing its level, its place among its siblings, and whether it is open", () => {
		renderTree();
		const tree = screen.getByRole("tree", {
			name: "Folders and files on this branch",
		});
		expect(
			within(tree)
				.getAllByRole("treeitem")
				.map((element) => element.getAttribute("aria-label")),
		).toEqual([
			"docs",
			"docs/old",
			"docs/guide.md",
			"docs/logo.png",
			"tools",
			"tools/run.md",
			"README.md",
		]);
		expect(item("docs")).toHaveAttribute("aria-level", "1");
		expect(item("docs")).toHaveAttribute("aria-posinset", "1");
		expect(item("docs")).toHaveAttribute("aria-setsize", "3");
		expect(item("docs")).toHaveAttribute("aria-expanded", "true");
		expect(item("docs/old")).toHaveAttribute("aria-level", "2");
		expect(item("docs/old")).toHaveAttribute("aria-expanded", "false");
		expect(item("docs/logo.png")).toHaveAttribute("aria-posinset", "3");
		expect(item("docs/logo.png")).toHaveAttribute("aria-setsize", "3");
		// A file is neither open nor closed.
		expect(item("README.md")).not.toHaveAttribute("aria-expanded");
		// A folder's children are a group inside its item.
		expect(within(item("docs")).getByRole("group")).toContainElement(
			item("docs/guide.md"),
		);
	});

	it("announces a ticked, an empty and a partial row on the item, once: the box it draws is hidden from assistive technology", () => {
		renderTree();
		expect(item("docs/guide.md")).toHaveAttribute("aria-checked", "true");
		expect(item("docs/old")).toHaveAttribute("aria-checked", "false");
		expect(item("docs")).toHaveAttribute("aria-checked", "mixed");
		// The drawn box agrees, and is not a second checkbox to announce.
		expect(box("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(box("docs")).toHaveAttribute("aria-hidden", "true");
		expect(screen.queryAllByRole("checkbox")).toEqual([]);
	});

	it("marks a row that cannot be clicked disabled and points it at the reason", () => {
		renderTree();
		expect(item("docs/logo.png")).toHaveAttribute("aria-disabled", "true");
		expect(box("docs/logo.png")).toBeDisabled();
		expect(item("docs/logo.png")).toHaveAccessibleDescription(
			"Only text files sync (.md, .markdown, .txt, .json, .yaml, .yml)",
		);
		// An unknown row with no reason of its own can't tell yet.
		expect(item("tools")).toHaveAttribute("aria-disabled", "true");
		expect(item("tools")).toHaveAccessibleDescription("Can't tell yet");
		// A clickable row's note is wired the same way, and the row stays enabled.
		expect(item("README.md")).not.toHaveAttribute("aria-disabled");
		expect(box("README.md")).toBeEnabled();
		expect(item("README.md")).toHaveAccessibleDescription(
			"Skipped by the default rule README.md",
		);
		expect(item("docs/old")).not.toHaveAttribute("aria-describedby");
	});

	it("hands each click to the adapter with the state Radix asks for", async () => {
		const user = userEvent.setup();
		const { onToggle } = renderTree();
		await user.click(box("docs"));
		await user.click(box("docs/guide.md"));
		await user.click(box("docs/old"));
		expect(
			onToggle.mock.calls.map(([node, next]) => [node.path, next]),
		).toEqual([
			["docs", true],
			["docs/guide.md", false],
			["docs/old", true],
		]);
		await user.click(box("docs/logo.png"));
		expect(onToggle).toHaveBeenCalledTimes(3);
	});

	it("runs Select all and Select none, and disables everything while a save is in flight", async () => {
		const user = userEvent.setup();
		const { onSelectAll, onSelectNone, rerender, onToggle } = renderTree();
		await user.click(screen.getByRole("button", { name: "Select all" }));
		await user.click(screen.getByRole("button", { name: "Select none" }));
		expect(onSelectAll).toHaveBeenCalledTimes(1);
		expect(onSelectNone).toHaveBeenCalledTimes(1);
		rerender(
			<RepositorySyncSelectionTree
				namespace={NAMESPACE}
				listing={ready()}
				row={rowOf}
				onToggle={onToggle}
				onSelectAll={onSelectAll}
				onSelectNone={onSelectNone}
				disabled
				summary={null}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Select all" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Select none" }),
		).toBeDisabled();
		expect(box("docs/old")).toBeDisabled();
		expect(item("docs/old")).toHaveAttribute("aria-disabled", "true");
		// Space does nothing either.
		item("docs/old").focus();
		await user.keyboard(" ");
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("puts the search, Show only selected, Collapse all, Select all and Select none before the rows, and makes the tree one Tab stop", async () => {
		const user = userEvent.setup();
		renderTree();
		await user.tab();
		expect(
			screen.getByRole("searchbox", { name: "Search folders and files" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Show only selected" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Collapse all" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Select all" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Select none" }),
		).toHaveFocus();
		await user.tab();
		// The first row, and only it: the rows are one Tab stop.
		expect(item("docs")).toHaveFocus();
		expect(
			screen
				.getAllByRole("treeitem")
				.filter((element) => element.tabIndex === 0),
		).toEqual([item("docs")]);
		await user.tab();
		expect(document.body).toHaveFocus();
		// Coming back lands on the row last focused.
		await user.tab({ shift: true });
		expect(item("docs")).toHaveFocus();
	});

	it("opens only the top level unless told which folders lead to the selection", () => {
		const { unmount } = renderTree();
		expect(item("docs/guide.md")).toBeInTheDocument();
		expect(queryTreeItem("docs/old/notes.md")).not.toBeInTheDocument();
		unmount();
		renderTree({ initiallyOpen: new Set(["docs/old"]) });
		expect(item("docs/old/notes.md")).toBeInTheDocument();
	});

	it("opens a folder the dialog adds later, once, and leaves the member's other choices alone (Fizzy #2752)", async () => {
		const user = userEvent.setup();
		const handlers = {
			onToggle: vi.fn(),
			onSelectAll: vi.fn(),
			onSelectNone: vi.fn(),
		};
		const tree = (initiallyOpen: ReadonlySet<string>) => (
			<RepositorySyncSelectionTree
				namespace={NAMESPACE}
				listing={ready()}
				row={rowOf}
				disabled={false}
				summary={null}
				initiallyOpen={initiallyOpen}
				{...handlers}
			/>
		);
		const { rerender } = render(tree(new Set()));
		// The member closes `tools`, which is open by default.
		await user.click(chevronIn(item("tools")));
		expect(queryTreeItem("tools/run.md")).not.toBeInTheDocument();

		// The way to something left out arrives once the rules load.
		rerender(tree(new Set(["docs/old"])));
		expect(item("docs/old/notes.md")).toBeInTheDocument();
		// `tools` was not asked for: it stays as the member left it.
		expect(queryTreeItem("tools/run.md")).not.toBeInTheDocument();

		// Closed by the member afterwards, it stays closed while the set
		// still holds it, and when it drops out.
		await user.click(chevronIn(item("docs/old")));
		rerender(tree(new Set(["docs/old"])));
		rerender(tree(new Set()));
		expect(queryTreeItem("docs/old/notes.md")).not.toBeInTheDocument();

		// A folder the member closed BEFORE it arrived opens when it does…
		rerender(tree(new Set(["tools"])));
		expect(item("tools/run.md")).toBeInTheDocument();
		// …and closed again, it stays closed on later renders.
		await user.click(chevronIn(item("tools")));
		rerender(tree(new Set(["tools"])));
		expect(queryTreeItem("tools/run.md")).not.toBeInTheDocument();
	});

	it("Collapse all closes every folder down to the top-level rows, and is off once nothing is open", async () => {
		const user = userEvent.setup();
		renderTree({ initiallyOpen: new Set(["docs/old"]) });
		const collapse = screen.getByRole("button", { name: "Collapse all" });
		expect(item("docs/old/notes.md")).toBeInTheDocument();
		expect(item("tools/run.md")).toBeInTheDocument();

		await user.click(collapse);
		expect(rowsOnScreen()).toEqual(["docs", "tools", "README.md"]);
		expect(collapse).toBeDisabled();

		// Opening a folder again opens only that folder: the one inside it
		// that was open before stays closed.
		await user.click(chevronIn(item("docs")));
		expect(collapse).toBeEnabled();
		expect(item("docs/old")).toBeInTheDocument();
		expect(queryTreeItem("docs/old/notes.md")).not.toBeInTheDocument();
	});

	it("Collapse all during a search closes the folders it shows, and leaves browsing as it was", async () => {
		const user = userEvent.setup();
		renderTree();
		await user.type(screen.getByRole("searchbox"), "notes");
		expect(item("docs/old/notes.md")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(item("docs")).toBeInTheDocument();
		expect(queryTreeItem("docs/old/notes.md")).not.toBeInTheDocument();

		await user.clear(screen.getByRole("searchbox"));
		expect(item("docs/guide.md")).toBeInTheDocument();
		expect(item("tools/run.md")).toBeInTheDocument();
	});

	it("offers Collapse all only when there are rows to collapse", () => {
		renderTree({ listing: ready([]) });
		expect(
			screen.queryByRole("button", { name: "Collapse all" }),
		).not.toBeInTheDocument();
	});

	it("shows the adapter's verdict for a search match, computed over the whole listing", async () => {
		const user = userEvent.setup();
		const row = vi.fn(rowOf);
		renderTree({ row });
		await user.type(screen.getByRole("searchbox"), "guide");
		expect(item("docs/guide.md")).toHaveAttribute("aria-checked", "true");
		// The folder keeps its partial state although only one child matches.
		expect(item("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(queryTreeItem("docs/old")).not.toBeInTheDocument();
		// Every call was about a real listed path, whatever the search shows.
		for (const [node] of row.mock.calls) {
			expect(ENTRIES.some((entry) => entry.path === node.path)).toBe(
				true,
			);
		}
		await user.clear(screen.getByRole("searchbox"));
		await user.type(screen.getByRole("searchbox"), "no-such-name");
		expect(
			screen.getByText("No folders or files match this search."),
		).toBeInTheDocument();
	});

	it("asks to refine a search that matches more than it shows", async () => {
		const user = userEvent.setup();
		const many: RepositoryTreeEntry[] = Array.from(
			{ length: 250 },
			(_, i) => ({
				path: `notes/n${i}.md`,
				type: "file" as const,
			}),
		);
		renderTree({ listing: ready(many) });
		await user.type(screen.getByRole("searchbox"), "n");
		expect(
			screen.getByText(
				"Showing the first 200 matches. Refine the search to see others.",
			),
		).toBeInTheDocument();
	});

	it("renders the summary it is given", () => {
		renderTree();
		expect(screen.getByText("summary slot")).toBeInTheDocument();
	});
});

describe("RepositorySyncSelectionTree: the keyboard", () => {
	/** Focus a row, as a click or Tab would. */
	function focusRow(path: string) {
		item(path).focus();
		expect(item(path)).toHaveFocus();
	}

	it("moves one row with Down and Up, and to the first and last with Home and End", async () => {
		const user = userEvent.setup();
		renderTree();
		focusRow("docs");
		await user.keyboard("{ArrowDown}");
		expect(item("docs/old")).toHaveFocus();
		await user.keyboard("{ArrowDown}{ArrowDown}");
		expect(item("docs/logo.png")).toHaveFocus();
		await user.keyboard("{ArrowUp}");
		expect(item("docs/guide.md")).toHaveFocus();
		await user.keyboard("{End}");
		expect(item("README.md")).toHaveFocus();
		// Down past the last row stays there.
		await user.keyboard("{ArrowDown}");
		expect(item("README.md")).toHaveFocus();
		await user.keyboard("{Home}");
		expect(item("docs")).toHaveFocus();
		// The focused row is the one Tab stop.
		expect(item("docs")).toHaveAttribute("tabindex", "0");
		expect(item("README.md")).toHaveAttribute("tabindex", "-1");
	});

	it("opens a closed folder with Right, then moves into it", async () => {
		const user = userEvent.setup();
		renderTree();
		focusRow("docs/old");
		await user.keyboard("{ArrowRight}");
		expect(item("docs/old")).toHaveAttribute("aria-expanded", "true");
		expect(item("docs/old")).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(item("docs/old/notes.md")).toHaveFocus();
		// Right on a file does nothing.
		await user.keyboard("{ArrowRight}");
		expect(item("docs/old/notes.md")).toHaveFocus();
	});

	it("moves to the parent with Left, then closes the open folder", async () => {
		const user = userEvent.setup();
		renderTree();
		focusRow("docs/guide.md");
		await user.keyboard("{ArrowLeft}");
		expect(item("docs")).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(item("docs")).toHaveAttribute("aria-expanded", "false");
		expect(queryTreeItem("docs/guide.md")).not.toBeInTheDocument();
		expect(item("docs")).toHaveFocus();
		// Left on a closed top-level folder does nothing.
		await user.keyboard("{ArrowLeft}");
		expect(item("docs")).toHaveFocus();
	});

	it("opens and closes a folder with Enter", async () => {
		const user = userEvent.setup();
		renderTree();
		focusRow("tools");
		await user.keyboard("{Enter}");
		expect(item("tools")).toHaveAttribute("aria-expanded", "false");
		await user.keyboard("{Enter}");
		expect(item("tools")).toHaveAttribute("aria-expanded", "true");
		expect(item("tools/run.md")).toBeInTheDocument();
	});

	it("ticks and unticks with Space, as a click would, and not a row that says why it can't", async () => {
		const user = userEvent.setup();
		const { onToggle } = renderTree();
		focusRow("docs");
		await user.keyboard(" ");
		focusRow("docs/guide.md");
		await user.keyboard(" ");
		focusRow("docs/old");
		await user.keyboard(" ");
		focusRow("docs/logo.png");
		await user.keyboard(" ");
		focusRow("tools");
		await user.keyboard(" ");
		expect(
			onToggle.mock.calls.map(([node, next]) => [node.path, next]),
		).toEqual([
			["docs", true],
			["docs/guide.md", false],
			["docs/old", true],
		]);
	});

	it("moves to the next row whose name starts with what is typed, cycling on a repeated letter", async () => {
		const user = userEvent.setup();
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		renderTree();
		focusRow("docs");
		await user.keyboard("t");
		expect(item("tools")).toHaveFocus();
		now += TREE_TYPE_AHEAD_MS + 1;
		// `run.md` and `README.md` both start with r: the letter again,
		// once the pause has passed, moves on to the next one.
		await user.keyboard("r");
		expect(item("tools/run.md")).toHaveFocus();
		now += TREE_TYPE_AHEAD_MS + 1;
		await user.keyboard("r");
		expect(item("README.md")).toHaveFocus();
		now += TREE_TYPE_AHEAD_MS + 1;
		// Letters typed together name one row, in any case.
		focusRow("docs");
		await user.keyboard("Re");
		expect(item("README.md")).toHaveFocus();
	});

	it("hands focus to the nearest row still on screen when the focused one goes away", async () => {
		const user = userEvent.setup();
		renderTree();
		focusRow("docs/guide.md");
		// Collapse all closes `docs` under the focused row; the button
		// takes focus, so the row to come back to is `docs`.
		await user.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(item("docs")).toHaveAttribute("tabindex", "0");
		// A search that leaves only another row makes that the Tab stop.
		await user.type(screen.getByRole("searchbox"), "run");
		expect(item("tools")).toHaveAttribute("tabindex", "0");
	});

	it("focuses the row itself when its box is clicked, so the keys carry on from there", async () => {
		const user = userEvent.setup();
		renderTree();
		await user.click(box("docs/old"));
		expect(item("docs/old")).toHaveFocus();
		await user.keyboard("{ArrowDown}");
		expect(item("docs/guide.md")).toHaveFocus();
	});
});

describe("RepositorySyncSelectionTree: Show only selected", () => {
	const SELECTED_ROWS: Record<string, SelectionRow> = {
		// A partial folder: something inside it is left out.
		docs: { membership: "mixed", disabledReason: null },
		"docs/guide.md": { membership: "in", disabledReason: null },
		"docs/old": {
			membership: "out",
			disabledReason: null,
			leftOut: true,
		},
		// A ticked folder: everything inside it syncs.
		tools: { membership: "in", disabledReason: null },
		"tools/run.md": { membership: "in", disabledReason: null },
	};
	const selectedRow = (node: RepositoryTreeNode): SelectionRow =>
		SELECTED_ROWS[node.path] ?? { membership: "out", disabledReason: null };
	const toggle = () =>
		screen.getByRole("button", { name: "Show only selected" });

	it("keeps the ticked, partial and left-out rows and the way to them, a ticked folder collapsed", async () => {
		const user = userEvent.setup();
		renderTree({ row: selectedRow });
		expect(toggle()).toHaveAttribute("aria-pressed", "false");

		await user.click(toggle());
		expect(toggle()).toHaveAttribute("aria-pressed", "true");
		expect(rowsOnScreen()).toEqual([
			"docs",
			"docs/old",
			"docs/guide.md",
			"tools",
		]);
		expect(item("tools")).toHaveAttribute("aria-expanded", "false");
		// Opened, a ticked folder shows what is in it.
		await user.click(chevronIn(item("tools")));
		expect(item("tools/run.md")).toBeInTheDocument();

		await user.click(toggle());
		expect(item("README.md")).toBeInTheDocument();
		expect(item("docs/logo.png")).toBeInTheDocument();
	});

	it("narrows a search to the selection when both are on", async () => {
		const user = userEvent.setup();
		renderTree({ row: selectedRow });
		await user.click(toggle());
		await user.type(screen.getByRole("searchbox"), "ol");
		// `docs/old/notes.md` matches but is not chosen; `docs` is only the
		// way to `docs/old`.
		expect(rowsOnScreen()).toEqual([
			"docs",
			"docs/old",
			"tools",
			"tools/run.md",
		]);
		await user.clear(screen.getByRole("searchbox"));
		await user.type(screen.getByRole("searchbox"), "logo");
		expect(
			screen.getByText("No folders or files match this search."),
		).toBeInTheDocument();
	});

	it("says so when nothing is selected or left out", async () => {
		const user = userEvent.setup();
		renderTree({
			row: () => ({ membership: "out", disabledReason: null }),
		});
		await user.click(toggle());
		expect(
			screen.getByText("Nothing is selected or left out yet."),
		).toBeInTheDocument();
		expect(screen.queryByRole("tree")).not.toBeInTheDocument();
	});

	it("is not offered by a picker that opts out", () => {
		renderTree({ offerSelectedOnly: false });
		expect(
			screen.queryByRole("button", { name: "Show only selected" }),
		).not.toBeInTheDocument();
	});
});

describe("SelectionSummary", () => {
	it("says nothing is selected, as the line Save points at", () => {
		const summary: SelectionSummaryModel = {
			nothingSelected: { key: "summary.nothingSelected" },
			lead: null,
			count: null,
			notes: [],
		};
		render(
			<SelectionSummary
				namespace={NAMESPACE}
				summary={summary}
				nothingSelectedId="nothing"
			/>,
		);
		expect(
			screen.getByText(
				"Nothing selected yet. Tick a folder or file to sync it.",
			),
		).toHaveAttribute("id", "nothing");
	});

	it("gives the lead, a live count that never promises, and the notes", () => {
		const summary: SelectionSummaryModel = {
			nothingSelected: null,
			lead: {
				key: "summary.lead",
				fragments: { what: { key: "summary.what.wholeRepository" } },
			},
			count: { key: "summary.counting" },
			notes: [
				{ key: "summary.unreadable" },
				{ key: "summary.policyCaveat" },
			],
		};
		render(
			<SelectionSummary
				namespace={NAMESPACE}
				summary={summary}
				nothingSelectedId="nothing"
			/>,
		);
		expect(
			screen.getByText("Syncs the whole repository."),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Counting…");
		expect(
			screen.getByText(
				"Files the sync can't read are skipped when it runs.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"A ticked folder's .contextignore may leave out more.",
			),
		).toBeInTheDocument();
	});
});
