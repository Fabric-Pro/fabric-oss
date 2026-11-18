import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StoryKindIcon } from "../StoryKindIcon";

describe("StoryKindIcon", () => {
	it("renders layers icon for INITIATIVE with primary text color", () => {
		const { container } = render(
			<StoryKindIcon kind="INITIATIVE" priority="P1_HIGH" />,
		);
		const svg = container.querySelector("svg");
		expect(svg).toBeInTheDocument();
		expect(svg?.classList.contains("text-primary")).toBe(true);
	});

	it("renders bug icon for BUG with destructive text color", () => {
		const { container } = render(
			<StoryKindIcon kind="BUG" priority="P1_HIGH" />,
		);
		const svg = container.querySelector("svg");
		expect(svg).toBeInTheDocument();
		expect(svg?.classList.contains("text-destructive")).toBe(true);
	});

	it("renders puzzle icon for FEATURE tinted by priority color", () => {
		const { container } = render(
			<StoryKindIcon kind="FEATURE" priority="P1_HIGH" />,
		);
		const svg = container.querySelector("svg");
		expect(svg).toBeInTheDocument();
		expect(svg?.style.color).toBeTruthy();
	});
});
