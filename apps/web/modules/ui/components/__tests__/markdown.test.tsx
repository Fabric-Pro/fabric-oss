import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../markdown";

describe("Markdown", () => {
	// Covers AC1: valid Markdown renders as formatted output.
	it("renders bold as <strong>", () => {
		const { container } = render(<Markdown>{"**bold**"}</Markdown>);
		const strong = container.querySelector("strong");
		expect(strong).not.toBeNull();
		expect(strong?.textContent).toBe("bold");
	});

	it("renders an ATX heading as a heading element", () => {
		const { container } = render(<Markdown>{"## Overview"}</Markdown>);
		const heading = container.querySelector("h2");
		expect(heading?.textContent).toBe("Overview");
	});

	it("renders a dash list as a <ul> with items", () => {
		const { container } = render(<Markdown>{"- one\n- two"}</Markdown>);
		const items = container.querySelectorAll("ul > li");
		expect(items).toHaveLength(2);
		expect(items[0]?.textContent).toBe("one");
		expect(items[1]?.textContent).toBe("two");
	});

	it("renders a GFM pipe table as a <table>", () => {
		const table = "| a | b |\n| - | - |\n| 1 | 2 |";
		const { container } = render(<Markdown>{table}</Markdown>);
		expect(container.querySelector("table")).not.toBeNull();
		expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
	});

	it("renders a fenced code block as <pre><code>", () => {
		const { container } = render(
			<Markdown>{"```\nconst x = 1;\n```"}</Markdown>,
		);
		expect(container.querySelector("pre code")).not.toBeNull();
	});

	// Covers AC3: raw Markdown tokens are not visible when syntax is valid.
	it("does not leak raw ** or ## characters into rendered text", () => {
		const { container } = render(
			<Markdown>{"**Steps to Reproduce**\n\n## Details"}</Markdown>,
		);
		expect(container.textContent).not.toContain("**");
		expect(container.textContent).not.toContain("##");
		expect(screen.getByText("Steps to Reproduce")).toBeDefined();
	});

	it("merges a custom className onto the wrapper", () => {
		const { container } = render(
			<Markdown className="line-clamp-[7]">{"hi"}</Markdown>,
		);
		const wrapper = container.firstElementChild;
		expect(wrapper?.className).toContain("line-clamp-[7]");
		expect(wrapper?.className).toContain("prose");
	});

	// Raw HTML is not rendered (no rehype-raw) — untrusted markup is inert.
	it("does not render embedded raw HTML as elements", () => {
		const { container } = render(
			<Markdown>{"<script>alert(1)</script> hello"}</Markdown>,
		);
		expect(container.querySelector("script")).toBeNull();
	});
});

describe("Markdown — fenced code", () => {
	it("resets the inline-code chip inside a fenced block and boxes the block itself", () => {
		const { container } = render(
			<Markdown>{"```sh\nexport A=1\nrun --now\n```"}</Markdown>,
		);

		const className = container.firstElementChild?.className ?? "";
		expect(container.querySelector("pre code")).not.toBeNull();
		expect(className).toContain("[&_pre_code]:border-0");
		expect(className).toContain("[&_pre_code]:bg-transparent");
		expect(className).toContain("[&_pre_code]:p-0");
		expect(className).toContain("prose-pre:bg-muted");
	});
});

describe("Markdown — fenced code padding", () => {
	it("pads the pre box, since the code inside is reset to no padding", () => {
		const { container } = render(<Markdown>{"```\nx\n```"}</Markdown>);

		const className = container.firstElementChild?.className ?? "";
		expect(className).toContain("prose-pre:px-4");
		expect(className).toContain("prose-pre:py-3");
	});
});
