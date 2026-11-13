import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseNoteDetailModal } from "../ReleaseNoteDetailModal";

function content(images?: { url: string; alt: string }[]) {
	return {
		schemaVersion: 1 as const,
		headline: "This week's release notes",
		intro: "One change shipped.",
		hasMajorFeatures: true,
		highlights: [
			{
				title: "Faster search",
				description: "Search results now load twice as fast.",
				images,
			},
		],
	};
}

describe("ReleaseNoteDetailModal — approved images", () => {
	it("shows a highlight's images under its description", () => {
		render(
			<ReleaseNoteDetailModal
				open
				onOpenChange={() => {}}
				content={content([
					{
						url: "https://app.example.com/image-proxy/b/newsletter-public/one.png",
						alt: "The new search results page",
					},
				])}
			/>,
		);

		const image = screen.getByRole("img", {
			name: "The new search results page",
		});
		expect(image).toHaveAttribute(
			"src",
			"https://app.example.com/image-proxy/b/newsletter-public/one.png",
		);
		expect(image).toHaveAttribute("loading", "lazy");
	});

	it("renders no image for a highlight without images", () => {
		render(
			<ReleaseNoteDetailModal
				open
				onOpenChange={() => {}}
				content={content()}
			/>,
		);

		expect(screen.getByText("Faster search")).toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
});
