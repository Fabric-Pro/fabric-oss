import { render } from "@testing-library/react";
import { Markdown } from "@ui/components/markdown";
import { describe, expect, it } from "vitest";
import { remarkHideHtmlComments } from "../remark-hide-html-comments";

function rendered(markdown: string) {
	const view = render(
		<Markdown remarkPlugins={[remarkHideHtmlComments]}>
			{markdown}
		</Markdown>,
	);
	return view.container.textContent ?? "";
}

describe("remarkHideHtmlComments", () => {
	it("hides block and inline comments, and a comment that spans lines", () => {
		expect(rendered("a\n\n<!-- hidden -->\n\nb")).not.toContain("hidden");
		expect(rendered("a <!-- hidden --> b")).toBe("a  b");
		expect(rendered("a\n\n<!-- one\n\ntwo -->\n\nb")).not.toMatch(
			/one|two/,
		);
	});

	it("hides a comment that holds inline code", () => {
		expect(rendered("x <!-- see `y` --> z")).not.toContain("see");
	});

	it("never touches code: fenced, indented or inline", () => {
		expect(rendered("```html\n<!-- shown -->\n```")).toContain(
			"<!-- shown -->",
		);
		expect(rendered("text\n\n    <!-- indented -->\n")).toContain(
			"<!-- indented -->",
		);
		expect(rendered("use `<!-- x -->` here")).toContain("<!-- x -->");
	});

	it("does not end a fence at a closing fence with an info string", () => {
		const text = rendered("```\ncode\n```js\n<!-- still code -->\n```\n");
		expect(text).toContain("<!-- still code -->");
	});

	it("keeps arrows and prose that are not comments", () => {
		expect(rendered("a --> b")).toContain("a");
	});

	it("keeps the text that follows a comment on its line", () => {
		const text = rendered("<!-- note --> visible after comment");
		expect(text).toContain("visible after comment");
		expect(text).not.toContain("note");
	});

	it("hides several comments in one node and keeps the text between them", () => {
		const text = rendered("a <!-- one --> b <!-- two --> c");
		expect(text).toBe("a  b  c");
	});

	it("keeps trailing text after an html block comment", () => {
		const text = rendered("<!-- block -->trailing text\n\nnext");
		expect(text).toContain("trailing text");
		expect(text).toContain("next");
		expect(text).not.toContain("block");
	});

	it("keeps a comment-only table cell as a cell so columns do not shift", () => {
		const view = render(
			<Markdown remarkPlugins={[remarkHideHtmlComments]}>
				{"| a | b | c |\n| - | - | - |\n| 1 | <!-- gone --> | 3 |"}
			</Markdown>,
		);
		const cells = [...view.container.querySelectorAll("tbody td")].map(
			(cell) => cell.textContent?.trim(),
		);
		expect(cells).toEqual(["1", "", "3"]);
	});

	it("does not pair a stray opener in prose with a closer in a later block", () => {
		const text = rendered(
			"uses <!-- in prose\n\n# Heading\n\n```\ncode\n```\n\nend --> done",
		);
		expect(text).toContain("Heading");
		expect(text).toContain("code");
		expect(text).toContain("in prose");
	});

	it("leaves entity-escaped comments visible", () => {
		const text = rendered("shown &lt;!-- as text --&gt; here");
		expect(text).toContain("<!-- as text -->");
	});

	it("leaves text that spans paragraphs as written, as CommonMark does", () => {
		const text = rendered("text <!-- one\n\ntwo --> more");
		expect(text).toContain("one");
		expect(text).toContain("two");
	});
});
