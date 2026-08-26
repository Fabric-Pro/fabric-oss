import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { RoadmapEmptyState } from "../RoadmapEmptyState";

describe("RoadmapEmptyState", () => {
	const onClearFilters = vi.fn();

	it("renders the generic message for a non-conflicting filter combination", () => {
		render(
			<RoadmapEmptyState
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(/no work items match these filters/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/sync date range only applies/i),
		).not.toBeInTheDocument();
	});

	it("renders the only-Unsynced hint when sync=[unsynced] + sync-date range", () => {
		render(
			<RoadmapEmptyState
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					sync: ["unsynced"],
					syncedFrom: "2026-05-18",
				}}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(
				/Synced date range only applies when Synced is in the Sync Status filter/i,
			),
		).toBeInTheDocument();
	});

	it("renders the only-Unsynced hint even on the duplicate URL shape sync=[unsynced,unsynced]", () => {
		render(
			<RoadmapEmptyState
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					// Shape produced by a hand-edited `?sync=unsynced,unsynced` URL —
					// nuqs' parseAsArrayOf doesn't dedupe.
					sync: ["unsynced", "unsynced"],
					syncedFrom: "2026-05-18",
				}}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(
				/Synced date range only applies when Synced is in the Sync Status filter/i,
			),
		).toBeInTheDocument();
	});

	it("renders the both-buckets hint when sync=[synced,unsynced] + sync-date range", () => {
		render(
			<RoadmapEmptyState
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					sync: ["synced", "unsynced"],
					syncedFrom: "2026-05-18",
				}}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(
				/Unsynced items don't have a sync date, so the Synced date range excludes them/i,
			),
		).toBeInTheDocument();
	});

	it("renders the generic message when sync=[synced] + sync-date range yields zero", () => {
		render(
			<RoadmapEmptyState
				filters={{
					...EMPTY_ROADMAP_FILTERS,
					sync: ["synced"],
					syncedFrom: "2026-05-18",
				}}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(/no work items match these filters/i),
		).toBeInTheDocument();
	});

	it("renders the generic message when sync filter is set but no date range", () => {
		render(
			<RoadmapEmptyState
				filters={{ ...EMPTY_ROADMAP_FILTERS, sync: ["unsynced"] }}
				onClearFilters={onClearFilters}
			/>,
		);
		expect(
			screen.getByText(/no work items match these filters/i),
		).toBeInTheDocument();
	});

	it("renders a Clear filters button that calls the callback", () => {
		const onClear = vi.fn();
		render(
			<RoadmapEmptyState
				filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["BUG"] }}
				onClearFilters={onClear}
			/>,
		);
		const btn = screen.getByRole("button", { name: /clear filters/i });
		btn.click();
		expect(onClear).toHaveBeenCalledTimes(1);
	});
});
