/**
 * `InstructionsTree` renders every string through `useTranslations`, so this
 * suite overrides the shared `next-intl` mock (which only echoes the
 * translation KEY back, per `vitest.setup.ts`) with one that resolves the
 * REAL `en.json` copy (the shared `en-copy` helper), so the search box's
 * accessible name and the markers' wording can be asserted against actual
 * shipped copy rather than a key.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

import { InstructionsTree } from "../InstructionsTree";

const files = [
	{
		id: "1",
		path: ".claude/skills/example-qa-test/SKILL.md",
		kind: "SKILL",
		name: "example-qa-test",
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
	{
		id: "2",
		path: ".claude/agents/qa-lead.md",
		kind: "AGENT",
		name: "qa-lead",
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
	{
		id: "3",
		path: "CLAUDE.md",
		kind: "INSTRUCTIONS",
		name: null,
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
] as const;

describe("InstructionsTree", () => {
	it("renders folders collapsed with counts and opens a file on click", async () => {
		const onSelect = vi.fn();
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={onSelect}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /\.claude 2/ }),
		).toBeInTheDocument();
		expect(screen.queryByText("SKILL.md")).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /\.claude 2/ }),
		);
		await userEvent.click(screen.getByRole("button", { name: /skills 1/ }));
		await userEvent.click(
			screen.getByRole("button", { name: /example-qa-test 1/ }),
		);
		await userEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
		expect(onSelect).toHaveBeenCalledWith(
			".claude/skills/example-qa-test/SKILL.md",
		);
	});

	it("filters by the search box across path, name and description", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"qa-lead",
		);
		expect(
			screen.getByRole("button", { name: "qa-lead.md" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});

	// The chip group is a real <fieldset> named by a visually-hidden
	// <legend>, matching `qa-settings/QaCiSetupSection.tsx`. Asserted through
	// the accessible `group` role so the name has to come from a real naming
	// mechanism, not from text that merely sits nearby.
	it("names the kind filter as a group", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		expect(
			screen.getByRole("group", { name: "Filter by kind" }),
		).toBeInTheDocument();
	});

	it("filters by kind, hiding files of other kinds", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Skill 1" }));
		expect(
			screen.getByRole("button", { name: "SKILL.md" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "qa-lead.md" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});

	// The two filters must AND, not replace each other: `kindFilter` narrows
	// first and the query narrows within that result. Each was covered alone,
	// so a change making one clobber the other would have passed both.
	it("composes the kind filter with the search box", async () => {
		const twoSkills = [
			...files,
			{
				id: "4",
				path: ".claude/skills/example-release-notes/SKILL.md",
				kind: "SKILL" as const,
				name: "example-release-notes",
				description: null,
				size: 10,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
			},
		];
		render(
			<InstructionsTree
				files={twoSkills}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Skill 2" }));
		// Both SKILL rows survive the kind filter; they share a file name, so
		// the surviving leaf is identified by its parent folder.
		expect(
			screen.getByRole("button", { name: /example-qa-test 1/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /example-release-notes 1/ }),
		).toBeInTheDocument();

		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"release-notes",
		);
		// The query narrows WITHIN the kind, rather than reinstating the
		// AGENT/INSTRUCTIONS files the kind filter removed.
		expect(
			screen.getByRole("button", { name: /example-release-notes 1/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /example-qa-test/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "qa-lead.md" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});
	// Every folder with a match opens while searching, and a person must still
	// be able to close one: the old `searching || open` left a folder open
	// with a button that did nothing and an `aria-expanded` that lied.
	it("lets a folder be collapsed while searching, and says so truthfully", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"qa",
		);
		const claude = screen.getByRole("button", { name: /\.claude/ });
		expect(claude).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("button", { name: "qa-lead.md" }),
		).toBeInTheDocument();

		await userEvent.click(claude);

		expect(claude).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("button", { name: "qa-lead.md" }),
		).not.toBeInTheDocument();

		await userEvent.click(claude);

		expect(claude).toHaveAttribute("aria-expanded", "true");
	});

	it("forgets a folder collapsed during one search when the search changes, and keeps the browse state apart", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		const search = screen.getByRole("searchbox", { name: "Search files" });
		await userEvent.type(search, "qa");
		await userEvent.click(screen.getByRole("button", { name: /\.claude/ }));
		expect(
			screen.getByRole("button", { name: /\.claude/ }),
		).toHaveAttribute("aria-expanded", "false");

		await userEvent.clear(search);
		// Back to browsing: collapsed by default, as it was before the search.
		expect(
			screen.getByRole("button", { name: /\.claude/ }),
		).toHaveAttribute("aria-expanded", "false");
		await userEvent.type(search, "qa-lead");

		expect(
			screen.getByRole("button", { name: /\.claude/ }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("says, politely and in the tree's own words, when nothing matches", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		const region = screen.getByRole("status");
		expect(region).toBeEmptyDOMElement();

		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"zzz-no-such-file",
		);

		// The same region, now holding the message: it was mounted beforehand,
		// which is what lets a screen reader announce the change.
		expect(screen.getByRole("status")).toBe(region);
		expect(region).toHaveTextContent(
			"No files match this search or filter.",
		);
	});

	it("gives the search wrapper a visible focus ring, since the input's own is removed", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		const wrapper = screen.getByRole("searchbox", {
			name: "Search files",
		}).parentElement;

		expect(wrapper).toHaveClass(
			"focus-within:border-ring",
			"focus-within:ring-1",
			"focus-within:ring-ring",
		);
	});

	it("counts the files of each kind in its chip", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "All kinds 3" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Skill 1" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Agent 1" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Instructions 1" }),
		).toBeInTheDocument();
	});
});

describe("InstructionsTree: what the published version changed", () => {
	const marks = new Map<string, "added" | "changed">([
		[".claude/agents/qa-lead.md", "added"],
		["CLAUDE.md", "changed"],
	]);
	const changes = { baseVersion: 6, marks };

	it("marks an added file A and a changed file M, named for screen readers", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				changes={changes}
			/>,
		);

		const claude = screen.getByRole("button", { name: /CLAUDE\.md/ });
		expect(within(claude).getByText("M")).toBeInTheDocument();
		expect(
			within(claude).getByTitle("Changed since version 6"),
		).toHaveClass("text-highlight-ink");
		expect(claude).toHaveAccessibleName(
			"CLAUDE.md Changed since version 6",
		);
	});

	it("marks added files in success ink once their folder is open", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				changes={changes}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: /\.claude/ }));
		await userEvent.click(screen.getByRole("button", { name: /agents/ }));

		const lead = screen.getByRole("button", { name: /qa-lead\.md/ });
		expect(within(lead).getByText("A")).toBeInTheDocument();
		expect(within(lead).getByTitle("Added since version 6")).toHaveClass(
			"text-success",
		);
	});

	it("puts a dot on a closed folder that holds a change, and takes it away once the folder is open", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				changes={changes}
			/>,
		);
		const dotTitle = "Contains changes since version 6";

		const claude = screen.getByRole("button", { name: /\.claude/ });
		expect(
			within(claude).getByRole("img", { name: dotTitle }),
		).toHaveAttribute("title", dotTitle);

		await userEvent.click(claude);

		expect(
			within(claude).queryByRole("img", { name: dotTitle }),
		).not.toBeInTheDocument();
		// The folder it holds is closed and has the change: its dot shows.
		expect(
			within(screen.getByRole("button", { name: /agents/ })).getByRole(
				"img",
				{ name: dotTitle },
			),
		).toBeInTheDocument();
		// A folder with nothing changed has none.
		expect(
			within(screen.getByRole("button", { name: /skills/ })).queryByRole(
				"img",
				{ name: dotTitle },
			),
		).not.toBeInTheDocument();
	});

	it("shows the A / M legend only when there are markers", () => {
		const { rerender } = render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		expect(
			screen.queryByTestId("instructions-tree-legend"),
		).not.toBeInTheDocument();

		rerender(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				changes={changes}
			/>,
		);

		expect(
			screen.getByTestId("instructions-tree-legend"),
		).toHaveTextContent("A added M changed");
	});

	it("shows no legend when the changed paths are not in the tree", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				changes={{
					baseVersion: 6,
					marks: new Map([
						["gone/removed-from-the-tree.md", "added"],
					]),
				}}
			/>,
		);

		expect(
			screen.queryByTestId("instructions-tree-legend"),
		).not.toBeInTheDocument();
	});
});

describe("InstructionsTree: opening down to the selected file", () => {
	const SKILL = ".claude/skills/example-qa-test/SKILL.md";

	it("opens every folder above the selected file, and marks it current", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={SKILL}
				onSelect={() => undefined}
			/>,
		);

		for (const folder of [/\.claude/, /skills/, /example-qa-test/]) {
			expect(
				screen.getByRole("button", { name: folder }),
			).toHaveAttribute("aria-expanded", "true");
		}
		expect(
			screen.getByRole("button", { name: "SKILL.md" }),
		).toHaveAttribute("aria-current", "true");
		// The folder holding only the other file stays closed.
		expect(screen.getByRole("button", { name: /agents/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("opens a root file's list as it was: nothing to open above CLAUDE.md", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath="CLAUDE.md"
				onSelect={() => undefined}
			/>,
		);

		expect(
			screen.getByRole("button", { name: /\.claude/ }),
		).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.getByRole("button", { name: /CLAUDE\.md/ }),
		).toHaveAttribute("aria-current", "true");
	});

	it("opens the folders of a file selected from somewhere else, after the tree is on screen", () => {
		const { rerender } = render(
			<InstructionsTree
				files={[...files]}
				selectedPath="CLAUDE.md"
				onSelect={() => undefined}
			/>,
		);
		expect(screen.queryByText("qa-lead.md")).not.toBeInTheDocument();

		rerender(
			<InstructionsTree
				files={[...files]}
				selectedPath=".claude/agents/qa-lead.md"
				onSelect={() => undefined}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "qa-lead.md" }),
		).toHaveAttribute("aria-current", "true");
	});

	it("lets the person close a folder above the selection, and keeps it closed until the selection changes", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath=".claude/agents/qa-lead.md"
				onSelect={() => undefined}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: /\.claude/ }));

		expect(
			screen.getByRole("button", { name: /\.claude/ }),
		).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("qa-lead.md")).not.toBeInTheDocument();
	});
});

describe("InstructionsTree: files the version left out", () => {
	const leftOutFiles = [
		{ path: "tasks/a.md", rule: "tasks/" },
		{ path: "tasks/b.md", rule: "tasks/" },
		{ path: "retro.md", rule: "retro.md" },
	];

	/** The tree with the toggle's state kept the way the published view keeps it. */
	function Harness({
		list = leftOutFiles,
		onSelect = () => undefined,
		shown = false,
	}: {
		list?: typeof leftOutFiles;
		onSelect?: (path: string) => void;
		shown?: boolean;
	}) {
		const [open, setOpen] = useState(shown);
		return (
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={onSelect}
				leftOut={{
					files: list,
					shown: open,
					onToggle: () => setOpen((value) => !value),
				}}
			/>
		);
	}

	it("offers to show them in the footer, and adds no rows until asked", () => {
		render(<Harness />);

		expect(
			screen.getByRole("button", { name: "Show 3 left-out files" }),
		).toBeInTheDocument();
		expect(screen.queryByText("retro.md")).not.toBeInTheDocument();
		expect(screen.queryByText(/left out ·/)).not.toBeInTheDocument();
	});

	it("says one file in the singular", () => {
		render(<Harness list={[{ path: "tasks/a.md", rule: "tasks/" }]} />);

		expect(
			screen.getByRole("button", { name: "Show 1 left-out file" }),
		).toBeInTheDocument();
	});

	it("lists them greyed with the rule that left each one out, on request, and hides them again", async () => {
		render(<Harness />);

		await userEvent.click(
			screen.getByRole("button", { name: "Show 3 left-out files" }),
		);

		const row = screen.getByText("retro.md").closest("div");
		expect(row).toHaveAttribute("title", "Left out by retro.md");
		expect(row).toHaveTextContent("left out · retro.md");
		expect(row).toHaveClass("text-foreground/40");
		expect(
			screen.getByRole("button", { name: "Hide left-out files" }),
		).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: "Hide left-out files" }),
		);

		expect(screen.queryByText("retro.md")).not.toBeInTheDocument();
	});

	it("counts only the files a folder keeps, and greys a folder that holds nothing but left-out files", async () => {
		render(<Harness shown />);

		const folder = screen.getByRole("button", { name: /^tasks/ });
		// Two left-out files and no kept one: no count, and the name is muted.
		expect(folder).toHaveTextContent(/^tasks$/);
		expect(within(folder).getByText("tasks")).toHaveClass(
			"text-muted-foreground",
		);
	});

	it("never makes a left-out row something to select", async () => {
		const onSelect = vi.fn();
		render(<Harness onSelect={onSelect} shown />);

		await userEvent.click(screen.getByText("retro.md"));

		expect(onSelect).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: /retro\.md/ }),
		).not.toBeInTheDocument();
	});

	it("puts them in their folders, which count only the files they keep", async () => {
		render(<Harness shown />);

		const tasks = screen.getByRole("button", { name: /tasks/ });
		expect(tasks).toHaveAccessibleName("tasks");

		await userEvent.click(tasks);

		const inside = screen.getByText("a.md").closest("div");
		expect(inside).toHaveAttribute("title", "Left out by tasks/");
	});

	it("answers a text search by path, and no kind filter", async () => {
		render(<Harness shown />);

		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"retro",
		);
		expect(screen.getByText("retro.md")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();

		await userEvent.clear(screen.getByRole("searchbox"));
		await userEvent.click(screen.getByRole("button", { name: "Skill 1" }));

		expect(screen.queryByText("retro.md")).not.toBeInTheDocument();
	});

	it("skips a left-out path a kept file already holds", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				leftOut={{
					files: [{ path: "CLAUDE.md", rule: "*.md" }],
					shown: true,
					onToggle: () => undefined,
				}}
			/>,
		);

		expect(screen.getAllByText("CLAUDE.md")).toHaveLength(1);
		expect(screen.queryByText(/left out ·/)).not.toBeInTheDocument();
	});

	it("offers no toggle when the version named no files, or when the tree is given none", () => {
		const { rerender } = render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				leftOut={{ files: [], shown: false, onToggle: () => undefined }}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /left-out/ }),
		).not.toBeInTheDocument();

		rerender(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /left-out/ }),
		).not.toBeInTheDocument();
	});
});

describe("InstructionsTree no-match signal", () => {
	it("tells the page when a search leaves nothing, and when it clears", async () => {
		const onNoMatchesChange = vi.fn();
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
				onNoMatchesChange={onNoMatchesChange}
			/>,
		);
		expect(onNoMatchesChange).toHaveBeenLastCalledWith(false);
		const search = screen.getByRole("searchbox", { name: "Search files" });
		await userEvent.type(search, "zzz-no-match");
		expect(onNoMatchesChange).toHaveBeenLastCalledWith(true);
		await userEvent.clear(search);
		expect(onNoMatchesChange).toHaveBeenLastCalledWith(false);
	});
});
