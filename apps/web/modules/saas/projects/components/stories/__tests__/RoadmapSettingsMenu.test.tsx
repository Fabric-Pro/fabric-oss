import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The menu takes only constants and types from the view hook's module; the
// hook itself, and the API client it would reach, are never used here.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import { DEFAULT_ROADMAP_COLUMN_ORDER } from "../../../hooks/useRoadmapView";
import { RoadmapSettingsMenu } from "../RoadmapSettingsMenu";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

/** Render the menu on a view that differs from every default, then reset it. */
async function resetToDefaults() {
	const onModeChange = vi.fn();
	const onColumnsChange = vi.fn();
	render(
		<RoadmapSettingsMenu
			mode="board"
			onModeChange={onModeChange}
			groupBy="stage"
			onGroupByChange={vi.fn()}
			columns={{
				stage: false,
				sync: false,
				size: true,
				source: false,
				tags: false,
				flags: false,
			}}
			onColumnsChange={onColumnsChange}
			columnOrder={[...DEFAULT_ROADMAP_COLUMN_ORDER]}
			onColumnOrderChange={vi.fn()}
			isDirty={false}
			onSave={vi.fn()}
			onCancel={vi.fn()}
		/>,
	);
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Roadmap view settings" }),
	);
	await user.click(screen.getByRole("button", { name: "Reset" }));
	await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
	return { onModeChange, onColumnsChange };
}

describe("RoadmapSettingsMenu — reset to defaults", () => {
	it("returns to the plain layout", async () => {
		const { onModeChange } = await resetToDefaults();

		expect(onModeChange).toHaveBeenCalledWith("plain");
	});

	it("hides the size field and shows every other card field", async () => {
		const { onColumnsChange } = await resetToDefaults();

		expect(onColumnsChange).toHaveBeenCalledWith({
			stage: true,
			sync: true,
			size: false,
			source: true,
			tags: true,
			flags: true,
		});
	});
});
