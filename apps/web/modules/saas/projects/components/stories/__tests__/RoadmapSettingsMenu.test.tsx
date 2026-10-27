import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The menu takes only constants and types from the view hook's module; the
// hook itself, and the API client it would reach, are never used here.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import {
	DEFAULT_ROADMAP_COLUMN_ORDER,
	DEFAULT_ROADMAP_COLUMNS,
} from "../../../hooks/useRoadmapView";
import { RoadmapSettingsMenu } from "../RoadmapSettingsMenu";

const locale = vi.hoisted(() => ({ value: "en" }));
beforeEach(() => {
	locale.value = "en";
});

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
	await user.click(screen.getByRole("button", { name: "View: Board" }));
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

vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: en } = await import("@repo/i18n/translations/en.json");
	const { default: de } = await import("@repo/i18n/translations/de.json");
	return {
		...actual,
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: locale.value,
				messages: locale.value === "de" ? de : en,
				namespace,
			}),
	};
});

it("names the layout and toggles hidden items inside View", async () => {
	const onShowHiddenChange = vi.fn();
	const user = userEvent.setup();
	render(
		<RoadmapSettingsMenu
			mode="plain"
			onModeChange={vi.fn()}
			groupBy="priority"
			onGroupByChange={vi.fn()}
			columns={{
				stage: true,
				sync: true,
				size: false,
				source: true,
				tags: true,
				flags: true,
			}}
			onColumnsChange={vi.fn()}
			columnOrder={[...DEFAULT_ROADMAP_COLUMN_ORDER]}
			onColumnOrderChange={vi.fn()}
			isDirty={false}
			onSave={vi.fn()}
			onCancel={vi.fn()}
			showHidden={false}
			onShowHiddenChange={onShowHiddenChange}
		/>,
	);
	const view = screen.getByRole("button", { name: "View: Plain" });
	expect(view).toHaveTextContent("View: Plain");
	expect(
		screen.queryByRole("checkbox", { name: "Show hidden" }),
	).not.toBeInTheDocument();
	await user.click(view);
	await user.click(screen.getByRole("checkbox", { name: "Show hidden" }));
	expect(onShowHiddenChange).toHaveBeenCalledWith(true);
});

it("translates the personal settings note and save, cancel, reset and draft copy into German", async () => {
	locale.value = "de";
	render(
		<RoadmapSettingsMenu
			mode="plain"
			onModeChange={vi.fn()}
			groupBy="priority"
			onGroupByChange={vi.fn()}
			columns={DEFAULT_ROADMAP_COLUMNS}
			onColumnsChange={vi.fn()}
			columnOrder={[...DEFAULT_ROADMAP_COLUMN_ORDER]}
			onColumnOrderChange={vi.fn()}
			isDirty
			onSave={vi.fn()}
			onCancel={vi.fn()}
		/>,
	);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /Ansicht:/ }));
	expect(
		screen.getByText(
			"Nur für Sie — diese Einstellungen ändern die Roadmap Ihrer Teammitglieder nicht.",
		),
	).toBeInTheDocument();
	expect(
		screen.getByText(
			"Ungespeicherte Änderungen — speichern Sie, um sie nach dem Neuladen beizubehalten.",
		),
	).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Abbrechen" })).toBeEnabled();
	await user.click(screen.getByRole("button", { name: "Zurücksetzen" }));
	expect(
		screen.getByText(
			"Layout, Gruppierung und Felder auf ihre Standardwerte zurücksetzen?",
		),
	).toBeInTheDocument();
	expect(
		screen.getByRole("button", { name: "Auf Standardwerte zurücksetzen" }),
	).toBeInTheDocument();
});
