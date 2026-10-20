import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import remarkDirective from "remark-directive";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Response } from "../../../components/ai-elements/response";
import { TypingResponse } from "../../../components/ai-elements/typing-response";
import { sidekickSuggestionDirective } from "../../../modules/saas/agents/sidekick/markdown/sidekickSuggestionDirective";

const html = [
	"<!doctype html>",
	"<html><head>",
	"<title>Example generated page</title>",
	'<style id="chat-page-style">:root { --chat-page-color: red; }</style>',
	'<meta http-equiv="refresh" content="0;url=https://example.com">',
	'<link rel="stylesheet" href="https://example.com/page.css">',
	'<base href="https://example.com/">',
	"</head><body>",
	'<script id="chat-page-script">window.chatPageInjected = true;</script>',
	'<iframe src="https://example.com/embed"></iframe>',
	'<object data="https://example.com/object"></object>',
	'<embed src="https://example.com/embed">',
	'<form action="https://example.com"><input name="value"></form>',
	'<div id="chat-page-body" onclick="alert(1)">Page content</div>',
	"</body></html>",
].join("\n");

function message(
	renderer: "Response" | "TypingResponse",
	content: string,
	streaming = false,
) {
	return renderer === "Response" ? (
		<Response streaming={streaming}>{content}</Response>
	) : (
		<TypingResponse animate={false} streaming={streaming}>
			{content}
		</TypingResponse>
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(["Response", "TypingResponse"] as const)(
	"%s HTML isolation",
	(renderer) => {
		it.each([false, true])(
			"shows complete HTML as text with streaming=%s",
			(streaming) => {
				const originalTitle = document.title;
				const { container } = render(
					message(renderer, html, streaming),
				);

				expect(document.title).toBe(originalTitle);
				expect(
					document.querySelector(
						"#chat-page-style, #chat-page-script",
					),
				).toBeNull();
				expect(
					container.querySelector(
						"title, style, script, meta, link, base, iframe, object, embed, form, input, [onclick]",
					),
				).toBeNull();
				for (const line of html.split("\n")) {
					expect(container.textContent).toContain(line);
				}
			},
		);

		it("keeps partial HTML inert while a message grows", () => {
			const partial = '<style id="chat-page-style">:root { color: red; }';
			const { container, rerender } = render(
				message(renderer, partial, true),
			);
			expect(container.textContent).toContain(partial);
			expect(document.querySelector("#chat-page-style")).toBeNull();

			rerender(message(renderer, `${partial}</style>`, true));
			expect(container.textContent).toContain(`${partial}</style>`);
			expect(document.querySelector("#chat-page-style")).toBeNull();
		});

		it("preserves literal XML wrappers as readable source", () => {
			const source =
				"<result><account>example-account</account></result>";
			const { container } = render(message(renderer, source));

			expect(container.textContent).toContain(source);
			expect(container.querySelector("result, account")).toBeNull();
		});

		it("preserves Markdown, math and safe relative links", () => {
			const { container } = render(
				message(
					renderer,
					"## Summary\n\n**Reviewed**\n\n- One story\n\n[Open Workspace](/app/example-org/workspaces/frame-1)\n\n[Unsafe](javascript:alert(1))\n\n$$\nx^2\n$$",
				),
			);

			expect(
				screen.getByRole("heading", { name: "Summary" }),
			).toBeVisible();
			expect(container.querySelector("strong")).toHaveTextContent(
				"Reviewed",
			);
			expect(screen.getByRole("listitem")).toHaveTextContent("One story");
			expect(
				screen.getByRole("link", { name: "Open Workspace" }),
			).toHaveAttribute("href", "/app/example-org/workspaces/frame-1");
			expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
			expect(screen.getByText("Unsafe [blocked]")).toBeInTheDocument();
			expect(container.querySelector(".katex")).not.toBeNull();
		});

		it("keeps fenced HTML readable and copyable", async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { clipboard: { writeText } });
			const { container } = render(
				message(renderer, `\`\`\`html\n${html}\n\`\`\``),
			);

			expect(container.querySelector("code")).toHaveTextContent(
				"<title>Example generated page</title>",
			);
			expect(container.querySelector("style, script, iframe")).toBeNull();
			fireEvent.click(screen.getByLabelText("Copy code"));
			await waitFor(() =>
				expect(writeText).toHaveBeenCalledWith(`${html}\n`),
			);
		});

		it("escapes document HTML during server rendering too", () => {
			const output = renderToString(message(renderer, html));

			expect(output).not.toMatch(
				/<(title|style|script|meta|link|base|iframe)\b/,
			);
			expect(output).toContain(
				"&lt;title&gt;Example generated page&lt;/title&gt;",
			);
			expect(output).toContain("&lt;script");
		});
	},
);

it("keeps trusted remark directives and registered chat components", () => {
	render(
		<Response
			remarkPlugins={[remarkDirective, sidekickSuggestionDirective]}
			components={{
				"agent-suggestion": ({ sid }: { sid: string }) => (
					<button type="button">Review suggestion {sid}</button>
				),
			}}
		>
			{":agent_suggestion[]{sId=example-suggestion kind=tools}"}
		</Response>,
	);

	expect(
		screen.getByRole("button", {
			name: "Review suggestion example-suggestion",
		}),
	).toBeVisible();
});
