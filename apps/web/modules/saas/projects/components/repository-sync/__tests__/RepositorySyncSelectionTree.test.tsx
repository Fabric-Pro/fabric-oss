/**
 * The shared repository-sync selection tree (Fizzy #2750 §3, §9): the
 * listing states, the three box states and how a partial one is announced,
 * a row that cannot be clicked saying why through `aria-describedby`, the
 * click handed to the adapter, Select all / Select none, Collapse all and
 * folders the dialog asks to open, the keyboard order,
 * a search that shows the adapter's verdict over the whole listing, and the
 * summary. Like the sibling suites, this resolves the REAL `en.json` copy
 * and throws on a missing key.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
	RepositoryTreeEntry,
	RepositoryTreeNode,
} from "../lib/repository-tree";
import type {
	SelectionRow,
	SelectionSummaryModel,
	SelectionTreeListing,
} from "../lib/selection-row";
import { RepositorySyncSelectionTree } from "../RepositorySyncSelectionTree";
import { SelectionSummary } from "../SelectionSummary";

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

const box = (path: string) => screen.getByRole("checkbox", { name: path });

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
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
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

	it("shows a ticked, an empty and a partial box, the partial one announced as mixed", () => {
		renderTree();
		expect(box("docs/guide.md")).toHaveAttribute("aria-checked", "true");
		expect(box("docs/old")).toHaveAttribute("aria-checked", "false");
		expect(box("docs")).toHaveAttribute("aria-checked", "mixed");
	});

	it("disables a row that cannot be clicked and points its box at the reason", () => {
		renderTree();
		expect(box("docs/logo.png")).toBeDisabled();
		expect(box("docs/logo.png")).toHaveAccessibleDescription(
			"Only text files sync (.md, .markdown, .txt, .json, .yaml, .yml)",
		);
		// An unknown row with no reason of its own can't tell yet.
		expect(box("tools")).toBeDisabled();
		expect(box("tools")).toHaveAccessibleDescription("Can't tell yet");
		// A clickable row's note is wired the same way, and the box stays enabled.
		expect(box("README.md")).toBeEnabled();
		expect(box("README.md")).toHaveAccessibleDescription(
			"Skipped by the default rule README.md",
		);
		expect(box("docs/old")).not.toHaveAttribute("aria-describedby");
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
		const { onSelectAll, onSelectNone, rerender } = renderTree();
		await user.click(screen.getByRole("button", { name: "Select all" }));
		await user.click(screen.getByRole("button", { name: "Select none" }));
		expect(onSelectAll).toHaveBeenCalledTimes(1);
		expect(onSelectNone).toHaveBeenCalledTimes(1);
		rerender(
			<RepositorySyncSelectionTree
				namespace={NAMESPACE}
				listing={ready()}
				row={rowOf}
				onToggle={vi.fn()}
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
	});

	it("puts the search, Collapse all, Select all and Select none before the rows in keyboard order", async () => {
		const user = userEvent.setup();
		renderTree();
		await user.tab();
		expect(
			screen.getByRole("searchbox", { name: "Search folders and files" }),
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
		// The first row: its expand toggle, then its box.
		expect(screen.getByRole("button", { name: "docs" })).toHaveFocus();
		await user.tab();
		expect(box("docs")).toHaveFocus();
	});

	it("opens only the top level unless told which folders lead to the selection", () => {
		const { unmount } = renderTree();
		expect(box("docs/guide.md")).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "docs/old/notes.md" }),
		).not.toBeInTheDocument();
		unmount();
		renderTree({ initiallyOpen: new Set(["docs/old"]) });
		expect(box("docs/old/notes.md")).toBeInTheDocument();
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
		await user.click(screen.getByRole("button", { name: "tools" }));
		expect(
			screen.queryByRole("checkbox", { name: "tools/run.md" }),
		).not.toBeInTheDocument();

		// The way to something left out arrives once the rules load.
		rerender(tree(new Set(["docs/old"])));
		expect(box("docs/old/notes.md")).toBeInTheDocument();
		// `tools` was not asked for: it stays as the member left it.
		expect(
			screen.queryByRole("checkbox", { name: "tools/run.md" }),
		).not.toBeInTheDocument();

		// Closed by the member afterwards, it stays closed while the set
		// still holds it, and when it drops out.
		await user.click(screen.getByRole("button", { name: "old" }));
		rerender(tree(new Set(["docs/old"])));
		rerender(tree(new Set()));
		expect(
			screen.queryByRole("checkbox", { name: "docs/old/notes.md" }),
		).not.toBeInTheDocument();

		// A folder the member closed BEFORE it arrived opens when it does…
		rerender(tree(new Set(["tools"])));
		expect(box("tools/run.md")).toBeInTheDocument();
		// …and closed again, it stays closed on later renders.
		await user.click(screen.getByRole("button", { name: "tools" }));
		rerender(tree(new Set(["tools"])));
		expect(
			screen.queryByRole("checkbox", { name: "tools/run.md" }),
		).not.toBeInTheDocument();
	});

	it("Collapse all closes every folder down to the top-level rows, and is off once nothing is open", async () => {
		const user = userEvent.setup();
		renderTree({ initiallyOpen: new Set(["docs/old"]) });
		const collapse = screen.getByRole("button", { name: "Collapse all" });
		expect(box("docs/old/notes.md")).toBeInTheDocument();
		expect(box("tools/run.md")).toBeInTheDocument();

		await user.click(collapse);
		expect(box("docs")).toBeInTheDocument();
		expect(box("README.md")).toBeInTheDocument();
		expect(box("tools")).toBeInTheDocument();
		for (const hidden of ["docs/guide.md", "docs/old", "tools/run.md"]) {
			expect(
				screen.queryByRole("checkbox", { name: hidden }),
			).not.toBeInTheDocument();
		}
		expect(collapse).toBeDisabled();

		// Opening a folder again opens only that folder: the one inside it
		// that was open before stays closed.
		await user.click(screen.getByRole("button", { name: "docs" }));
		expect(collapse).toBeEnabled();
		expect(box("docs/old")).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "docs/old/notes.md" }),
		).not.toBeInTheDocument();
	});

	it("Collapse all during a search closes the folders it shows, and leaves browsing as it was", async () => {
		const user = userEvent.setup();
		renderTree();
		await user.type(screen.getByRole("searchbox"), "notes");
		expect(box("docs/old/notes.md")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(box("docs")).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "docs/old/notes.md" }),
		).not.toBeInTheDocument();

		await user.clear(screen.getByRole("searchbox"));
		expect(box("docs/guide.md")).toBeInTheDocument();
		expect(box("tools/run.md")).toBeInTheDocument();
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
		expect(box("docs/guide.md")).toHaveAttribute("aria-checked", "true");
		// The folder keeps its partial state although only one child matches.
		expect(box("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(
			screen.queryByRole("checkbox", { name: "docs/old" }),
		).not.toBeInTheDocument();
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
