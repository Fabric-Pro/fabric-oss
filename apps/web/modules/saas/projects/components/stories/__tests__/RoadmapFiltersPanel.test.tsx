import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { RoadmapFiltersPanel } from "../RoadmapFiltersPanel";

beforeAll(() => {
	// Radix Popover (Stage/Source multiselect) needs these in jsdom.
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
});

describe("RoadmapFiltersPanel — primary tier", () => {
	it("selecting a Type option from the dropdown emits that value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Type filter" }));
		await user.click(await screen.findByRole("option", { name: "Bug" }));
		expect(onChange).toHaveBeenCalledWith({ kind: ["BUG"] });
	});

	it("adds a second Type value alongside the first (OR-within multi-select)", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Type filter" }));
		await user.click(
			await screen.findByRole("option", { name: "Feature" }),
		);
		expect(onChange).toHaveBeenCalledWith({ kind: ["BUG", "FEATURE"] });
	});

	it("toggling an already-selected Type option removes it", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Type filter" }));
		await user.click(await screen.findByRole("option", { name: "Bug" }));
		expect(onChange).toHaveBeenCalledWith({ kind: [] });
	});

	it("summarises the active Type selection on the fixed-width trigger", () => {
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onChange={vi.fn()}
			/>,
		);
		// The closed trigger reads the single selected label ("Any" when empty).
		// This is what replaces the old pill's aria-pressed visual state.
		expect(
			screen.getByRole("button", { name: "Type filter" }),
		).toHaveTextContent("Bug");
	});

	it("offers only Feature and Bug as Type options (User Story retired)", async () => {
		const user = userEvent.setup();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={vi.fn()}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Type filter" }));
		expect(
			await screen.findByRole("option", { name: "Feature" }),
		).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Bug" })).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: "User Story" }),
		).not.toBeInTheDocument();
	});

	it("selecting a Priority option from the dropdown emits that value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Priority filter" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "P1 - High" }),
		);
		expect(onChange).toHaveBeenCalledWith({ priority: ["P1_HIGH"] });
	});

	it("selecting a Stage option from the dropdown emits that value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Stage filter" }));
		await user.click(
			await screen.findByRole("option", {
				name: "Requirements Complete",
			}),
		);
		// Picking a maturity stage also exits "Hidden" mode (mutual exclusivity —
		// hidden items are CLOSED, which isn't a maturity stage).
		expect(onChange).toHaveBeenCalledWith({
			stage: ["DONE"],
			hiddenOnly: false,
		});
	});

	it("toggling Hidden in the Stage dropdown emits hiddenOnly and clears stages", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Stage filter" }));
		// "Hidden" is the CLOSED stage, hosted in the Stage facet below a divider
		// on its own boolean — entering it clears any maturity-stage picks.
		await user.click(await screen.findByRole("option", { name: "Hidden" }));
		expect(onChange).toHaveBeenCalledWith({ hiddenOnly: true, stage: [] });
	});

	it("does not render secondary (more) facets", () => {
		render(
			<RoadmapFiltersPanel
				tier="primary"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByText("Type")).toBeInTheDocument();
		expect(screen.queryByText("Source")).not.toBeInTheDocument();
		expect(
			screen.queryByText("Missing description"),
		).not.toBeInTheDocument();
	});
});

describe("RoadmapFiltersPanel — more tier", () => {
	it("selecting a flag option from the Flags dropdown emits the flag booleans", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Flags filter" }));
		await user.click(
			await screen.findByRole("option", { name: "Missing description" }),
		);
		// Flags is now a single multiselect dropdown — selecting one option
		// re-emits the full set of booleans (the chosen one true, rest false).
		// "Hidden" is NOT a flag — it lives in the Stage facet (see below).
		expect(onChange).toHaveBeenCalledWith({
			missingDesc: true,
			missingAc: false,
			duplicatesOnly: false,
			needsMoreInfo: false,
			blocked: false,
		});
	});

	it("selecting a recency window emits the numeric value for the right group", () => {
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		const group = screen.getByRole("radiogroup", {
			name: "Recently approved",
		});
		fireEvent.click(within(group).getByRole("radio", { name: "7d" }));
		expect(onChange).toHaveBeenCalledWith({ recentlyApproved: 7 });
	});

	it("exposes the Source facet (incl. Slack) and Sync, not the primary facets", async () => {
		const user = userEvent.setup();
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByText("Source")).toBeInTheDocument();
		expect(screen.getByText("Sync")).toBeInTheDocument();
		expect(screen.queryByText("Type")).not.toBeInTheDocument();
		// Source is a multiselect dropdown — open it to reveal the options.
		await user.click(screen.getByRole("button", { name: "Source filter" }));
		expect(
			await screen.findByRole("option", { name: "Slack" }),
		).toBeInTheDocument();
	});

	it("selecting a Source option from the dropdown emits that value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Source filter" }));
		await user.click(await screen.findByRole("option", { name: "Jira" }));
		expect(onChange).toHaveBeenCalledWith({ source: ["jira"] });
	});

	it("selecting a Sync option from the dropdown emits that value", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={onChange}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Sync filter" }));
		await user.click(await screen.findByRole("option", { name: "Synced" }));
		expect(onChange).toHaveBeenCalledWith({ sync: ["synced"] });
	});
});
