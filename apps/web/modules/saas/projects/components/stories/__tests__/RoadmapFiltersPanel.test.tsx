import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { RoadmapFilterChips } from "../RoadmapFilterChips";
import { RoadmapFiltersPanel } from "../RoadmapFiltersPanel";

const locale = vi.hoisted(() => ({ value: "en" }));
beforeEach(() => {
	locale.value = "en";
});

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
		await user.click(screen.getByRole("button", { name: /^Type:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Type:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Type:/ }));
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
			screen.getByRole("button", { name: /^Type:/ }),
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
		await user.click(screen.getByRole("button", { name: /^Type:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Priority:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Stage:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Stage:/ }));
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
		expect(
			screen.getByRole("button", { name: /^Type:/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Source:/ }),
		).not.toBeInTheDocument();
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
		await user.click(screen.getByRole("button", { name: /^Flags:/ }));
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

	it.each([
		["Approved", "recentlyApproved"],
		["Added", "recentlyAdded"],
		["Edited", "recentlyChanged"],
	] as const)(
		"%s select preserves its numeric and null values",
		async (label, key) => {
			const user = userEvent.setup();
			const onChange = vi.fn();
			function Filters() {
				const [filters, setFilters] = useState(EMPTY_ROADMAP_FILTERS);
				return (
					<RoadmapFiltersPanel
						tier="more"
						filters={filters}
						onChange={(next) => {
							onChange(next);
							setFilters((prev) => ({ ...prev, ...next }));
						}}
					/>
				);
			}
			render(<Filters />);
			for (const [name, value] of [
				["Last 7 days", 7],
				["Last 30 days", 30],
				["Last 90 days", 90],
				["Any time", null],
			] as const) {
				await user.click(
					screen.getByRole("button", { name: new RegExp(label) }),
				);
				await user.click(
					screen.getByRole("option", { name, exact: true }),
				);
				expect(onChange).toHaveBeenLastCalledWith({ [key]: value });
			}
		},
	);

	it("names each range trigger with its label and value", () => {
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={vi.fn()}
			/>,
		);
		for (const label of ["Created", "Last activity", "Last synced"]) {
			expect(
				screen.getByRole("button", {
					name: `${label}: Any`,
					exact: true,
				}),
			).toBeInTheDocument();
		}
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
		expect(
			screen.getByRole("button", { name: /^Source:/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Sync:/ }),
		).toBeInTheDocument();
		expect(screen.queryByText("Type")).not.toBeInTheDocument();
		// Source is a multiselect dropdown — open it to reveal the options.
		await user.click(screen.getByRole("button", { name: /^Source:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Source:/ }));
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
		await user.click(screen.getByRole("button", { name: /^Sync:/ }));
		await user.click(await screen.findByRole("option", { name: "Synced" }));
		expect(onChange).toHaveBeenCalledWith({ sync: ["synced"] });
	});
});

vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: messages } = await import(
		"@repo/i18n/translations/en.json"
	);
	const { default: de } = await import("@repo/i18n/translations/de.json");
	return {
		...actual,
		useLocale: () => locale.value,
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: locale.value,
				messages: locale.value === "de" ? de : messages,
				namespace,
			}),
	};
});

it.each([
	["Created", "createdFrom", "createdTo"],
	["Last activity", "updatedFrom", "updatedTo"],
	["Last synced", "syncedFrom", "syncedTo"],
] as const)(
	"%s range writes local inclusive YYYY-MM-DD filter fields together",
	async (label, fromKey, toKey) => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		function Filters() {
			const [filters, setFilters] = useState({
				...EMPTY_ROADMAP_FILTERS,
				[fromKey]: "2026-10-01",
				[toKey]: "2026-10-02",
			});
			return (
				<RoadmapFiltersPanel
					tier="more"
					filters={filters}
					onChange={(next) => {
						onChange(next);
						setFilters((prev) => ({ ...prev, ...next }));
					}}
				/>
			);
		}
		render(<Filters />);
		await user.click(
			screen.getByRole("button", { name: new RegExp(`^${label}:`) }),
		);
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /October 5th, 2026/,
			}),
		);
		expect(onChange).toHaveBeenCalledExactlyOnceWith({
			[fromKey]: "2026-10-05",
			[toKey]: null,
		});
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: /October 15th, 2026/,
			}),
		);
		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenLastCalledWith({
			[fromKey]: "2026-10-05",
			[toKey]: "2026-10-15",
		});
	},
);
it("shows active date ranges in the expanded panel and chips, and clears both bounds", async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	const filters = {
		...EMPTY_ROADMAP_FILTERS,
		createdFrom: "2026-10-01",
		createdTo: "2026-10-15",
	};
	render(
		<>
			<RoadmapFiltersPanel
				tier="more"
				filters={filters}
				onChange={onChange}
			/>
			<RoadmapFilterChips filters={filters} onRemoveFilter={vi.fn()} />
		</>,
	);
	const trigger = screen.getByRole("button", {
		name: "Created: Oct 1 – Oct 15, 2026",
	});
	expect(trigger).toHaveAccessibleName(trigger.textContent ?? "");
	expect(
		screen.getByRole("button", { name: "Remove created date filter" }),
	).toBeInTheDocument();
	expect(screen.getByText(/2026-10-01.*2026-10-15/)).toBeInTheDocument();
	await user.click(trigger);
	await user.click(
		screen.getByRole("button", { name: "Clear", exact: true }),
	);
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		createdFrom: null,
		createdTo: null,
	});
});

it("keeps secondary facets and conditional Tags in one wrapping row", () => {
	const { rerender } = render(
		<RoadmapFiltersPanel
			tier="more"
			filters={EMPTY_ROADMAP_FILTERS}
			onChange={vi.fn()}
			tagOptions={["Release"]}
		/>,
	);
	const sync = screen.getByRole("button", { name: /^Sync:/ });
	const row = sync.parentElement?.parentElement;
	expect(row).toHaveClass("flex", "flex-wrap", "gap-2");
	for (const name of [/^Source:/, /^Size:/, /^Flags:/, /^Tags:/]) {
		expect(row).toContainElement(screen.getByRole("button", { name }));
	}
	rerender(
		<RoadmapFiltersPanel
			tier="more"
			filters={EMPTY_ROADMAP_FILTERS}
			onChange={vi.fn()}
		/>,
	);
	expect(
		screen.queryByRole("button", { name: /^Tags:/ }),
	).not.toBeInTheDocument();
	rerender(
		<RoadmapFiltersPanel
			tier="more"
			filters={{ ...EMPTY_ROADMAP_FILTERS, tags: ["Release"] }}
			onChange={vi.fn()}
		/>,
	);
	expect(screen.getByRole("button", { name: /^Tags:/ })).toBeInTheDocument();
});

it("exposes facet values and all compact date controls in one wrapping row", async () => {
	render(
		<RoadmapFiltersPanel
			tier="primary"
			filters={{ ...EMPTY_ROADMAP_FILTERS, kind: ["FEATURE"] }}
			onChange={vi.fn()}
		/>,
	);
	const facet = screen.getByRole("button", { name: "Type: Feature" });
	expect(facet).not.toHaveAttribute("aria-label");
	render(
		<RoadmapFiltersPanel
			tier="more"
			filters={{ ...EMPTY_ROADMAP_FILTERS, recentlyChanged: 7 }}
			onChange={vi.fn()}
		/>,
	);

	for (const name of [/^Approved:/, /^Added:/, /^Edited:/]) {
		const trigger = screen.getByRole("button", { name });
		expect(trigger).not.toHaveAttribute("aria-label");
		expect(trigger).toHaveClass("h-9", "text-xs");
	}

	const range = screen.getByRole("button", { name: "Created: Any" });
	expect(range).toHaveClass("h-9", "w-40", "text-xs");
	const row = range.parentElement;
	expect(row).toHaveClass("flex", "flex-wrap", "gap-2");
	for (const control of [
		...[/^Approved:/, /^Added:/, /^Edited:/].map((name) =>
			screen.getByRole("button", { name }),
		),
		screen.getByRole("button", { name: "Last activity: Any" }),
		screen.getByRole("button", { name: "Last synced: Any" }),
	]) {
		expect(row).toContainElement(control);
	}
});

it("a single range click activates only the from-bound and clears an old to-bound", async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	render(
		<RoadmapFiltersPanel
			tier="more"
			filters={{ ...EMPTY_ROADMAP_FILTERS, createdTo: "2026-10-20" }}
			onChange={onChange}
		/>,
	);
	await user.click(screen.getByRole("button", { name: /^Created:/ }));
	await user.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: /October 5th, 2026/,
		}),
	);
	expect(onChange).toHaveBeenCalledExactlyOnceWith({
		createdFrom: "2026-10-05",
		createdTo: null,
	});
	expect(screen.getByRole("dialog")).toBeInTheDocument();
});
it.each(["en", "de"])(
	"keeps compact recency labels and their values in filter order in %s",
	(language) => {
		locale.value = language;
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={{ ...EMPTY_ROADMAP_FILTERS, recentlyAdded: 7 }}
				onChange={vi.fn()}
				tagOptions={["Release"]}
			/>,
		);
		const row = screen.getByRole("button", {
			name: language === "en" ? /^Sync:/ : /^Synchronisierung:/,
		}).parentElement?.parentElement;
		const labels =
			language === "en"
				? [
						"Approved: Any time",
						"Added: Last 7 days",
						"Edited: Any time",
					]
				: [
						"Freigabe: Jederzeit",
						"Neu: Letzte 7 Tage",
						"Bearbeitet: Jederzeit",
					];
		const controls = Array.from(row?.querySelectorAll("button") ?? []);
		const dates =
			language === "en"
				? ["Created: Any", "Last activity: Any", "Last synced: Any"]
				: [
						"Erstellt: Beliebig",
						"Letzte Aktivität: Beliebig",
						"Zuletzt synchronisiert: Beliebig",
					];
		const any = language === "en" ? "Any" : "Beliebig";
		expect(
			controls.map((control) =>
				control.textContent?.replace(/\s+/g, " ").trim(),
			),
		).toEqual([
			...(language === "en"
				? ["Sync", "Source", "Size", "Flags", "Tags"]
				: [
						"Synchronisierung",
						"Quelle",
						"Größe",
						"Markierungen",
						"Tags",
					]
			).map((label) => `${label}: ${any}`),
			...labels,
			...dates,
		]);
		expect(row).toHaveClass("flex", "flex-wrap", "gap-2");
		for (const name of labels) {
			const select = screen.getByRole("button", { name, exact: true });
			expect(select).toHaveClass("w-40");
			expect(select.textContent).toBe(name);
			expect(select).toHaveClass("text-xs", "font-medium");
			expect(select.querySelector("svg")).toHaveClass(
				"lucide-chevron-down",
				"size-3.5",
			);
		}
	},
);

it.each(["en", "de"])(
	"renders recency triggers identically to inactive facets in %s",
	(language) => {
		locale.value = language;
		render(
			<RoadmapFiltersPanel
				tier="more"
				filters={EMPTY_ROADMAP_FILTERS}
				onChange={vi.fn()}
			/>,
		);
		const facet = screen.getByRole("button", {
			name: language === "en" ? /^Sync:/ : /^Synchronisierung:/,
		});
		const labels =
			language === "en"
				? ["Approved: Any time", "Added: Any time", "Edited: Any time"]
				: [
						"Freigabe: Jederzeit",
						"Neu: Jederzeit",
						"Bearbeitet: Jederzeit",
					];
		for (const name of labels) {
			const trigger = screen.getByRole("button", { name, exact: true });
			expect(trigger.textContent).toBe(name);
			expect(
				within(trigger).getByText(
					language === "en" ? "Any time" : "Jederzeit",
					{ exact: true },
				),
			).toHaveClass("max-w-full", "shrink-0");
			expect(trigger.className).toBe(facet.className);
			expect(trigger.querySelectorAll("svg")).toHaveLength(1);
			expect(trigger.querySelector("svg")?.getAttribute("class")).toBe(
				facet.querySelector("svg")?.getAttribute("class"),
			);
			expect(trigger.querySelector("svg")).toHaveClass(
				"lucide-chevron-down",
				"size-3.5",
				"shrink-0",
			);
		}
	},
);

it("supports keyboard recency selection and returns focus to the unchanged trigger", async () => {
	const user = userEvent.setup();
	const onChange = vi.fn();
	function Filters() {
		const [filters, setFilters] = useState(EMPTY_ROADMAP_FILTERS);
		return (
			<RoadmapFiltersPanel
				tier="more"
				filters={filters}
				onChange={(next) => {
					onChange(next);
					setFilters((prev) => ({ ...prev, ...next }));
				}}
			/>
		);
	}
	render(<Filters />);
	const trigger = screen.getByRole("button", { name: "Added: Any time" });
	await user.click(trigger);
	await user.keyboard("{ArrowDown}{Enter}");
	expect(onChange).toHaveBeenCalledExactlyOnceWith({ recentlyAdded: 7 });
	expect(screen.getByRole("button", { name: "Added: Last 7 days" })).toBe(
		trigger,
	);
	expect(trigger).toHaveFocus();
});

it("keeps selected facet tooltips closed while its popover owns focus", async () => {
	const user = userEvent.setup();
	render(
		<RoadmapFiltersPanel
			tier="more"
			filters={{
				...EMPTY_ROADMAP_FILTERS,
				tags: ["A long synthetic tag name"],
			}}
			tagOptions={["A long synthetic tag name"]}
			onChange={vi.fn()}
		/>,
	);
	const trigger = screen.getByRole("button", { name: /^Tags:/ });
	await user.hover(trigger);
	expect(await screen.findByRole("tooltip")).toHaveTextContent(
		"A long synthetic tag name",
	);
	await user.click(trigger);
	expect(screen.getByRole("dialog")).toContainElement(
		document.activeElement as HTMLElement,
	);
	await user.unhover(trigger);
	await user.hover(trigger);
	await new Promise((resolve) => setTimeout(resolve, 800));
	expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
