/**
 * How the tree is walked and read: arrow keys move through its rows, one row
 * is the tab stop, and the selected row does not look like a hovered one.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

import { InstructionsTree } from "../InstructionsTree";

function file(path: string) {
	return {
		path,
		kind: "INSTRUCTIONS",
		name: null,
		description: null,
	};
}

const FILES = [
	file(".claude/agents/qa-lead.md"),
	file(".claude/skills/review/SKILL.md"),
	file("AGENTS.md"),
	file("CLAUDE.md"),
];

function renderTree(
	props: Partial<React.ComponentProps<typeof InstructionsTree>> = {},
) {
	return render(
		<InstructionsTree
			files={FILES}
			selectedPath={null}
			onSelect={vi.fn()}
			{...props}
		/>,
	);
}

const row = (name: RegExp | string) => screen.getByRole("button", { name });

describe("InstructionsTree — arrow keys", () => {
	it("moves down and up through the rows", async () => {
		const user = userEvent.setup();
		renderTree();
		row(/\.claude/).focus();

		await user.keyboard("{ArrowDown}");
		expect(row("AGENTS.md")).toHaveFocus();
		await user.keyboard("{ArrowDown}");
		expect(row("CLAUDE.md")).toHaveFocus();
		await user.keyboard("{ArrowUp}");
		expect(row("AGENTS.md")).toHaveFocus();
	});

	it("jumps to the first and the last row with Home and End", async () => {
		const user = userEvent.setup();
		renderTree();
		row("AGENTS.md").focus();

		await user.keyboard("{End}");
		expect(row("CLAUDE.md")).toHaveFocus();
		await user.keyboard("{Home}");
		expect(row(/\.claude/)).toHaveFocus();
	});

	it("opens a closed folder with ArrowRight, then steps into it", async () => {
		const user = userEvent.setup();
		renderTree();
		row(/\.claude/).focus();

		await user.keyboard("{ArrowRight}");
		expect(row(/\.claude/)).toHaveAttribute("aria-expanded", "true");
		expect(row(/\.claude/)).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(row(/agents/)).toHaveFocus();
	});

	it("closes an open folder with ArrowLeft, and from a file goes up to its folder", async () => {
		const user = userEvent.setup();
		renderTree({ selectedPath: ".claude/agents/qa-lead.md" });
		row("qa-lead.md").focus();

		await user.keyboard("{ArrowLeft}");
		expect(row(/agents/)).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(row(/agents/)).toHaveAttribute("aria-expanded", "false");
		await user.keyboard("{ArrowLeft}");
		expect(row(/\.claude/)).toHaveFocus();
	});

	it("leaves ArrowRight on a file to the browser", async () => {
		const user = userEvent.setup();
		renderTree();
		row("AGENTS.md").focus();

		await user.keyboard("{ArrowRight}");

		expect(row("AGENTS.md")).toHaveFocus();
	});

	it("opens the focused file with Enter", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		renderTree({ onSelect });
		row("AGENTS.md").focus();

		await user.keyboard("{Enter}");

		expect(onSelect).toHaveBeenCalledWith("AGENTS.md");
	});

	it("makes one row the tab stop: the selected one, then the one last focused", async () => {
		const user = userEvent.setup();
		renderTree({ selectedPath: "AGENTS.md" });
		const stops = () =>
			screen
				.getAllByRole("button")
				.filter(
					(button) =>
						button.dataset.treePath !== undefined &&
						button.tabIndex === 0,
				);

		expect(stops().map((button) => button.dataset.treePath)).toEqual([
			"AGENTS.md",
		]);

		row("AGENTS.md").focus();
		await user.keyboard("{ArrowDown}");

		expect(stops().map((button) => button.dataset.treePath)).toEqual([
			"CLAUDE.md",
		]);
	});

	it("reaches a row outside the window of a long tree", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 300 }, (_, index) =>
			file(`file-${String(index).padStart(3, "0")}.md`),
		);
		renderTree({ files: many });
		row("file-000.md").focus();

		await user.keyboard("{End}");

		expect(row("file-299.md")).toHaveFocus();
	});
});

describe("InstructionsTree — the selected row", () => {
	it("is marked and does not carry the hover style", () => {
		renderTree({ selectedPath: "AGENTS.md" });

		const selected = row("AGENTS.md");
		const other = row("CLAUDE.md");

		expect(selected).toHaveAttribute("aria-current", "true");
		expect(selected.className).toContain("bg-primary/10");
		expect(selected.className).not.toContain("hover:bg-accent");
		expect(other).not.toHaveAttribute("aria-current");
		expect(other.className).toContain("hover:bg-accent");
		expect(other.className).not.toContain("bg-primary/10");
	});
});
