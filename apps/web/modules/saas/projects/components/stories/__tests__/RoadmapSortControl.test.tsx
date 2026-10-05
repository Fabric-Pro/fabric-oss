import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROADMAP_SORT } from "../../../lib/roadmap-sorts";
import { RoadmapSortControl } from "../RoadmapSortControl";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

function renderSortControl() {
	const onSortChange = vi.fn();
	render(
		<RoadmapSortControl
			sort={DEFAULT_ROADMAP_SORT}
			onSortChange={onSortChange}
			mode="plain"
			groupBy="priority"
		/>,
	);
	return { onSortChange };
}

async function openSortMenu() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Sort work items" }));
	return user;
}

describe("RoadmapSortControl", () => {
	it("names created date as the sort in effect by default", () => {
		renderSortControl();

		expect(
			screen.getByRole("button", { name: "Sort work items" }),
		).toHaveTextContent("Created date");
	});

	it("still offers every sort option", async () => {
		renderSortControl();
		await openSortMenu();

		for (const label of [
			"Roadmap order",
			"Priority",
			"Maturity stage",
			"Last updated",
			"Created date",
			"Sync status",
			"Source",
		]) {
			expect(
				screen.getByRole("button", { name: label }),
			).toBeInTheDocument();
		}
	});

	it("switches to priority when Priority is picked", async () => {
		const { onSortChange } = renderSortControl();
		const user = await openSortMenu();

		await user.click(screen.getByRole("button", { name: "Priority" }));

		expect(onSortChange).toHaveBeenCalledWith({
			key: "priority",
			direction: "asc",
		});
	});
});
