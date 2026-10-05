/**
 * Tests for `CommandBlock`: the dark block every command and file in the Connect
 * dialog is shown in, and the copy control inside it.
 *
 * Pinned here: the `$` is drawn, not typed (so it can be neither selected nor
 * copied), the control reads "Copied" for about 1.8 s and then goes back, a
 * second copy restarts that clock, a failed copy is announced and never reads
 * "Copied", and a block that unmounts takes its timer with it.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_RESET_MS, CommandBlock } from "../CommandBlock";

const writeText = vi.fn(async (_text: string) => {});
const announce = vi.fn();

function renderBlock(props?: {
	command?: string;
	layout?: "command" | "document";
}) {
	return render(
		<CommandBlock
			announce={announce}
			command={props?.command ?? "npx -y example"}
			label="Copy the example"
			layout={props?.layout}
			testId="block"
		/>,
	);
}

/** The click, then the microtasks the clipboard promise settles in. */
async function copyIt() {
	await act(async () => {
		fireEvent.click(
			screen.getByRole("button", { name: "Copy the example" }),
		);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	announce.mockReset();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CommandBlock", () => {
	it("copies the command, reads 'Copied', and announces it", async () => {
		renderBlock();

		await copyIt();

		expect(writeText).toHaveBeenCalledWith("npx -y example");
		expect(
			screen.getByRole("button", { name: "Copied" }),
		).toBeInTheDocument();
		expect(announce).toHaveBeenCalledWith(
			"Copy the example: copied to the clipboard.",
		);
	});

	it("goes back to 'Copy' about 1.8 seconds later", async () => {
		renderBlock();
		await copyIt();

		act(() => {
			vi.advanceTimersByTime(COPIED_RESET_MS - 1);
		});
		expect(
			screen.getByRole("button", { name: "Copied" }),
		).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(
			screen.getByRole("button", { name: "Copy the example" }),
		).toHaveTextContent("Copy");
		expect(COPIED_RESET_MS).toBe(1800);
	});

	it("restarts the clock when it is copied again before it has gone back", async () => {
		renderBlock();
		await copyIt();
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		fireEvent.click(screen.getByRole("button", { name: "Copied" }));
		await act(async () => {});

		act(() => {
			vi.advanceTimersByTime(1500);
		});

		expect(
			screen.getByRole("button", { name: "Copied" }),
		).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(
			screen.getByRole("button", { name: "Copy the example" }),
		).toBeInTheDocument();
	});

	it("announces a failed copy and never reads 'Copied'", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		renderBlock();

		await copyIt();

		expect(
			screen.getByRole("button", { name: "Copy the example" }),
		).toBeInTheDocument();
		expect(announce).toHaveBeenCalledWith(
			"Copying failed. Select the text and copy it manually.",
		);
	});

	it("draws the $ with CSS, one per command, so the text has none", () => {
		renderBlock({
			command: "codex mcp add fabric\ncodex mcp login fabric",
		});

		const block = screen.getByTestId("block");
		const rows = block.querySelectorAll("code");

		expect(rows).toHaveLength(2);
		expect(block.textContent).toBe(
			"codex mcp add fabriccodex mcp login fabric",
		);
		for (const row of rows) {
			expect(row.className).toContain("before:content-['$']");
			expect(row.className).toContain("before:select-none");
		}
	});

	it("shows a file as it is, with no prompt", async () => {
		renderBlock({ command: '{\n  "a": 1\n}', layout: "document" });

		const block = screen.getByTestId("block");

		expect(block.tagName).toBe("CODE");
		expect(block.textContent).toBe('{\n  "a": 1\n}');
		expect(block.closest("pre")?.className).toContain(
			"whitespace-pre-wrap",
		);
		expect(block.closest("div")?.innerHTML).not.toContain("content-['$']");
		await copyIt();
		expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
	});

	it("keeps its name specific while idle, because the dialog holds several copy controls", () => {
		renderBlock();

		const button = screen.getByRole("button", { name: "Copy the example" });

		expect(button).toHaveTextContent("Copy");
		expect(button).toHaveAttribute("aria-label", "Copy the example");
	});

	it("does not touch state after it has been removed", async () => {
		const { unmount } = renderBlock();
		await copyIt();

		unmount();

		expect(() => vi.advanceTimersByTime(COPIED_RESET_MS * 2)).not.toThrow();
	});
});
