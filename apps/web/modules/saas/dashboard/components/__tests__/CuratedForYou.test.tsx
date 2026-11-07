import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CuratedForYou } from "../CuratedForYou";

const cards = [
	{
		key: "review:run-1",
		kind: "review" as const,
		title: "Review billing export",
		description: "Run failed · Example Portal",
		actionLabel: "Open",
		href: "/app/example-org/projects/project-1/stories/story-1",
		score: 100,
	},
	{
		key: "create-feature:project-1",
		kind: "create" as const,
		title: "Turn an idea into a feature",
		description: "Start with a real requirement.",
		actionLabel: "Create feature",
		href: "/app/example-org/projects/project-1?createStory=true",
		score: 50,
	},
];

describe("CuratedForYou", () => {
	it("renders actionable cards with real links", () => {
		render(<CuratedForYou cards={cards} onFeedback={vi.fn()} />);

		expect(
			screen.getByRole("heading", { name: "Curated for you" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open: Review billing export" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-1/stories/story-1",
		);
		expect(
			screen.getByRole("link", {
				name: "Create feature: Turn an idea into a feature",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-1?createStory=true",
		);
	});

	it("records clicks, pins and dismissals with stable card keys", async () => {
		const onFeedback = vi.fn();
		const user = userEvent.setup();
		render(<CuratedForYou cards={[cards[0]]} onFeedback={onFeedback} />);

		await user.click(
			screen.getByRole("button", { name: "Pin Review billing export" }),
		);
		expect(onFeedback).toHaveBeenCalledWith("review:run-1", "pin");
		await user.click(
			screen.getByRole("button", {
				name: "Dismiss Review billing export",
			}),
		);
		expect(onFeedback).toHaveBeenCalledWith("review:run-1", "dismiss");
		const link = screen.getByRole("link", {
			name: "Open: Review billing export",
		});
		link.addEventListener("click", (event) => event.preventDefault());
		await user.click(link);
		expect(onFeedback).toHaveBeenCalledWith("review:run-1", "click");
	});

	it("renders nothing when there are no cards", () => {
		const { container } = render(
			<CuratedForYou cards={[]} onFeedback={vi.fn()} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
