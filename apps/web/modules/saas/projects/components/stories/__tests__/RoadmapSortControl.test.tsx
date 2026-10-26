import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
	await user.click(
		screen.getByRole("button", { name: /^Sort work items: / }),
	);
	return user;
}

describe("RoadmapSortControl", () => {
	it("names created date as the sort in effect by default", () => {
		renderSortControl();

		expect(
			screen.getByRole("button", { name: /^Sort work items: / }),
		).toHaveTextContent("Created: newest first");
	});

	it("offers only the seven original sort options", async () => {
		renderSortControl();
		await openSortMenu();

		expect(
			screen.queryByRole("button", { name: "Recently approved" }),
		).not.toBeInTheDocument();
		for (const label of [
			"Roadmap order",
			"Priority",
			"Maturity stage",
			"Last updated",
			"Created",
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

it("shows oldest first for ascending created sort", () => {
	render(
		<RoadmapSortControl
			sort={{ key: "created", direction: "asc" }}
			onSortChange={vi.fn()}
			mode="plain"
			groupBy="priority"
		/>,
	);
	expect(
		screen.getByRole("button", { name: /^Sort work items: / }),
	).toHaveTextContent("Created: oldest first");
});

const locale = vi.hoisted(() => ({ value: "en" }));
beforeEach(() => {
	locale.value = "en";
});
it("includes sort direction in its name and limits its visible width", () => {
	renderSortControl();
	const button = screen.getByRole("button", {
		name: "Sort work items: Created: newest first",
	});
	expect(button.querySelector("span")).toHaveClass(
		"hidden",
		"sm:inline",
		"max-w-32",
	);
});
it("localizes sort field and direction in German", async () => {
	locale.value = "de";
	render(
		<RoadmapSortControl
			sort={{ key: "updated", direction: "asc" }}
			onSortChange={vi.fn()}
			mode="plain"
			groupBy="priority"
		/>,
	);
	const user = userEvent.setup();
	const button = screen.getByRole("button", {
		name: "Arbeitselemente sortieren: Zuletzt aktualisiert: älteste zuerst",
	});
	expect(button).toHaveTextContent("Zuletzt aktualisiert: älteste zuerst");
	await user.click(button);
	for (const name of [
		"Roadmap-Reihenfolge",
		"Priorität",
		"Reifegrad",
		"Zuletzt aktualisiert",
		"Erstellt",
		"Synchronisierungsstatus",
		"Quelle",
	]) {
		expect(
			screen.getByRole("button", { name, exact: true }),
		).toBeInTheDocument();
	}
});

it.each(["en", "de"])(
	"labels saved recentlyApproved preferences in %s",
	(language) => {
		locale.value = language;
		render(
			<RoadmapSortControl
				sort={{ key: "recentlyApproved", direction: "desc" }}
				onSortChange={vi.fn()}
				mode="plain"
				groupBy="priority"
			/>,
		);
		const label =
			language === "en"
				? "Recently approved: newest first"
				: "Kürzlich genehmigt: neueste zuerst";
		expect(
			screen.getByRole("button", { name: new RegExp(label) }),
		).toHaveTextContent(label);
	},
);

it.each(["asc", "desc"] as const)(
	"shows Roadmap order without a direction for saved %s",
	async (direction) => {
		render(
			<RoadmapSortControl
				sort={{ key: "roadmapOrder", direction }}
				onSortChange={vi.fn()}
				mode="table"
				groupBy="priority"
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "Sort work items: Roadmap order",
			exact: true,
		});
		expect(trigger).toHaveTextContent(/^Roadmap order$/);
		const user = userEvent.setup();
		await user.click(trigger);
		expect(
			screen.queryByRole("button", { name: "Ascending", exact: true }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Descending", exact: true }),
		).not.toBeInTheDocument();
	},
);
