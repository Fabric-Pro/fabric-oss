import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const responseLoaded = vi.hoisted(() => vi.fn());

vi.mock("../../../components/ai-elements/response", () => {
	responseLoaded();
	return {
		Response: ({ children }: { children?: ReactNode }) => (
			<div data-testid="full-search-content">{children}</div>
		),
	};
});

describe("SearchResultsDisplay loading", () => {
	it("renders source cards without loading rich content until it is expanded", async () => {
		const { SearchResultsDisplay } = await import(
			"../../../components/ai-elements/search-results-display"
		);
		const output = {
			success: true,
			results: [
				{
					title: "Example source",
					url: "https://example.com/reference",
					snippet: "A synthetic source summary.",
					content:
						"**Detailed source** with a preserved reference. This synthetic document explains a sample release checklist and contains no external customer data.",
				},
			],
		};
		const view = <SearchResultsDisplay output={output} />;
		expect(responseLoaded).not.toHaveBeenCalled();
		expect(renderToString(view)).toContain("Example source");
		expect(responseLoaded).not.toHaveBeenCalled();

		const mounted = render(view);
		expect(
			screen.getByRole("link", { name: "Example source" }),
		).toHaveAttribute("href", "https://example.com/reference");
		expect(
			screen.getByText("A synthetic source summary."),
		).toBeInTheDocument();
		expect(responseLoaded).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "View full content" }),
		);
		expect(
			await screen.findByTestId("full-search-content"),
		).toHaveTextContent(output.results[0].content);
		expect(responseLoaded).toHaveBeenCalledOnce();
		mounted.unmount();
	});
});
