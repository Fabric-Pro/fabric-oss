import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { RoadmapFilterChips } from "../RoadmapFilterChips";

describe("RoadmapFilterChips", () => {
	it("renders nothing when no filters are active", () => {
		const { container } = render(
			<RoadmapFilterChips
				filters={EMPTY_ROADMAP_FILTERS}
				onRemoveFilter={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("does not render a chip for the free-text search", () => {
		const { container } = render(
			<RoadmapFilterChips
				filters={{ ...EMPTY_ROADMAP_FILTERS, q: "auth" }}
				onRemoveFilter={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a chip per active facet value and removes a single value", () => {
		const onRemoveFilter = vi.fn();
		render(
			<RoadmapFilterChips
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					kind: ["BUG"],
					stage: ["DONE"],
				}}
				onRemoveFilter={onRemoveFilter}
			/>,
		);
		expect(screen.getByText("Bug")).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove type Bug filter" }),
		);
		expect(onRemoveFilter).toHaveBeenCalledWith("kind", "BUG");
	});

	it("renders a composed date-range chip that clears both bounds", () => {
		const onRemoveFilter = vi.fn();
		render(
			<RoadmapFilterChips
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					createdFrom: "2026-05-01",
					createdTo: null,
				}}
				onRemoveFilter={onRemoveFilter}
			/>,
		);
		expect(screen.getByText(/2026-05-01/)).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove created date filter" }),
		);
		expect(onRemoveFilter).toHaveBeenCalledWith("createdFrom");
		expect(onRemoveFilter).toHaveBeenCalledWith("createdTo");
	});

	it("renders a flag chip and removes it", () => {
		const onRemoveFilter = vi.fn();
		render(
			<RoadmapFilterChips
				filters={{ ...EMPTY_ROADMAP_FILTERS, missingDesc: true }}
				onRemoveFilter={onRemoveFilter}
			/>,
		);
		expect(screen.getByText("Missing description")).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove missing-description filter",
			}),
		);
		expect(onRemoveFilter).toHaveBeenCalledWith("missingDesc");
	});

	it("renders a 'Clear all' action when onClearAll is provided", () => {
		const onClearAll = vi.fn();
		render(
			<RoadmapFilterChips
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onRemoveFilter={vi.fn()}
				onClearAll={onClearAll}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
		expect(onClearAll).toHaveBeenCalledTimes(1);
	});

	it("omits 'Clear all' when onClearAll is not provided", () => {
		render(
			<RoadmapFilterChips
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onRemoveFilter={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /clear all/i }),
		).not.toBeInTheDocument();
	});
});
