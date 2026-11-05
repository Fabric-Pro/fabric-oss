import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeChatHeadingOutline } from "../../../components/ai-elements/chat-heading-outline";
import { Response } from "../../../components/ai-elements/response";
import { TypingResponse } from "../../../components/ai-elements/typing-response";

const workspaceUrl = "/app/example-org/workspaces/frame-1";
const artifactsUrl = "/app/example-org/projects/project-1?tab=artifacts#saved";
const markdown = [
	`[Open Workspace](${workspaceUrl})`,
	`[Project artifacts](${artifactsUrl})`,
	"[External documentation](https://example.com/docs)",
].join("\n\n");

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Response links", () => {
	it.each([true, false])(
		"renders saved page links with normalizeMarkdown=%s",
		(normalizeMarkdown) => {
			render(
				<Response normalizeMarkdown={normalizeMarkdown}>
					{markdown}
				</Response>,
			);

			expect(
				screen.getByRole("link", { name: "Open Workspace" }),
			).toHaveAttribute("href", workspaceUrl);
			expect(
				screen.getByRole("link", { name: "Project artifacts" }),
			).toHaveAttribute("href", artifactsUrl);
			expect(
				screen.getByRole("link", { name: "External documentation" }),
			).toHaveAttribute("href", "https://example.com/docs");
			expect(screen.queryByText(/\[blocked\]/)).not.toBeInTheDocument();
		},
	);

	it("keeps unsafe link protocols blocked", () => {
		render(
			<Response>
				{
					"[Script](javascript:alert(1))\n\n[Data](data:text/html,unsafe)"
				}
			</Response>,
		);

		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.getByText("Script [blocked]")).toBeInTheDocument();
		expect(screen.getByText("Data [blocked]")).toBeInTheDocument();
	});

	it("preserves relative image proxy rendering", () => {
		render(
			<Response>{"![Chart](/api/storage/image?key=example)"}</Response>,
		);

		expect(screen.getByRole("img", { name: "Chart" })).toHaveAttribute(
			"src",
			"/api/storage/image?key=example",
		);
	});

	it("renders relative links on the server using the configured site origin", () => {
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.com");
		vi.stubGlobal("window", undefined);
		let html: string;
		try {
			html = renderToString(<Response>{markdown}</Response>);
		} finally {
			vi.unstubAllGlobals();
		}

		const container = document.createElement("div");
		container.innerHTML = html;
		expect(
			container.querySelector(`a[href="${workspaceUrl}"]`),
		).not.toBeNull();
		expect(
			container.querySelector(`a[href="${artifactsUrl}"]`),
		).not.toBeNull();
		expect(container.textContent).not.toContain("[blocked]");
	});
});

describe("Response heading outline", () => {
	it("keeps peer headings and nesting without skipping the page's heading levels", () => {
		render(
			<Response normalizeHeadings>
				{
					"### First section\n\n### Second section\n\n##### Nested section\n\n## Another section"
				}
			</Response>,
		);
		expect(
			screen.getByRole("heading", { name: "First section" }).tagName,
		).toBe("H2");
		expect(
			screen.getByRole("heading", { name: "Second section" }).tagName,
		).toBe("H2");
		expect(
			screen.getByRole("heading", { name: "Nested section" }).tagName,
		).toBe("H3");
		expect(
			screen.getByRole("heading", { name: "Another section" }).tagName,
		).toBe("H2");
	});
});

it("preserves heading-like text inside fenced code, including unfinished streaming blocks", () => {
	const text =
		"### Title\n\n````markdown\n### Literal heading\n```\n## Still literal\n````\n\n##### Nested\n\n~~~text\n# Unfinished literal";
	render(
		<Response normalizeHeadings streaming>
			{text}
		</Response>,
	);
	expect(screen.getByRole("heading", { name: "Title" }).tagName).toBe("H2");
	expect(screen.getByRole("heading", { name: "Nested" }).tagName).toBe("H3");
	expect(
		screen.queryByRole("heading", { name: "Literal heading" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Unfinished literal" }),
	).not.toBeInTheDocument();
});

it("preserves list-contained fenced code verbatim and normalizes subsequent headings", () => {
	const markdown =
		"### Title\n\n- ~~~markdown\n  ### Literal\n  ~~~\n\n##### Next section";
	expect(normalizeChatHeadingOutline(markdown)).toBe(
		"## Title\n\n- ~~~markdown\n  ### Literal\n  ~~~\n\n### Next section",
	);
	render(<Response normalizeHeadings>{markdown}</Response>);
	expect(
		screen.getByText(
			(_text, node) =>
				node?.tagName === "CODE" &&
				node.textContent?.trim() === "### Literal",
		),
	).toBeVisible();
	expect(screen.getByRole("heading", { name: "Next section" }).tagName).toBe(
		"H3",
	);
});

it("keeps the outline stable between the streaming and completed answer renderers", () => {
	const markdown = "### Section\n\n##### Child";
	const view = render(
		<TypingResponse normalizeHeadings animate={false} streaming>
			{markdown}
		</TypingResponse>,
	);
	expect(screen.getByRole("heading", { name: "Section" }).tagName).toBe("H2");
	expect(screen.getByRole("heading", { name: "Child" }).tagName).toBe("H3");
	view.rerender(<Response normalizeHeadings>{markdown}</Response>);
	expect(screen.getByRole("heading", { name: "Section" }).tagName).toBe("H2");
	expect(screen.getByRole("heading", { name: "Child" }).tagName).toBe("H3");
});

it("normalizes setext headings and leaves nested literal code untouched", () => {
	expect(
		normalizeChatHeadingOutline(
			"Title\n=====\n\n- Item\n\n      ## literal\n\n### Child",
		),
	).toBe("## Title\n\n\n- Item\n\n      ## literal\n\n### Child");
});

it("normalizes headings inside blockquotes and lists", () => {
	expect(normalizeChatHeadingOutline("> ### Quoted\n\n- ##### Listed")).toBe(
		"> ## Quoted\n\n- ### Listed",
	);
});

it("preserves authored document headings unless chat normalization is requested", () => {
	render(<Response normalizeMarkdown={false}>{"# Quarterly plan"}</Response>);
	expect(
		screen.getByRole("heading", { name: "Quarterly plan" }).tagName,
	).toBe("H1");
});

it.each(["python", "javascript", "plaintext"])(
	"keeps explicit %s code literal even when it resembles a diagram",
	(language) => {
		const text = ["```", language, '\ngraph = {"a": ["b"]}\n```'].join("");
		const view = render(
			<Response normalizeMarkdown={false}>{text}</Response>,
		);
		expect(
			view.getByText(
				(_text, node) =>
					node?.tagName === "CODE" &&
					node.textContent?.includes('graph = {"a": ["b"]}') === true,
			),
		).toBeVisible();
	},
);

it.each(["response", "typing"])(
	"preserves literal fenced code with the default %s renderer",
	(renderer) => {
		const text =
			"### Example\n\n- ~~~text\n  • literal item\n  1) literal instruction\n  “literal quotes”\n  ~~~";
		const view = render(
			renderer === "response" ? (
				<Response>{text}</Response>
			) : (
				<TypingResponse animate={false}>{text}</TypingResponse>
			),
		);
		expect(
			view.getByText(
				(_text, node) =>
					node?.tagName === "CODE" &&
					node.textContent?.includes("• literal item") === true,
			),
		).toHaveTextContent("1) literal instruction “literal quotes”");
	},
);
