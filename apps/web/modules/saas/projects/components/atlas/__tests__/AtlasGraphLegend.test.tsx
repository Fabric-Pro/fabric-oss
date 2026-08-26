/**
 * Component tests for `<AtlasGraphLegend />` — the on-map colour key,
 * reworked from an (i)-popover into a collapsible panel docked over the canvas.
 *
 * Coverage:
 *   - Expanded by default, it lists only the product CATEGORIES actually present
 *     on the graph (data-driven via `categorizeNode`; absent categories never
 *     appear), each with an accessible translated label.
 *   - Works for both business (capabilities) and technical (modules) graphs.
 *   - The header toggle collapses the panel to a single labelled icon button and
 *     back; both states expose an aria-label and aria-expanded.
 *   - An empty graph renders nothing at all.
 *
 * next-intl is stubbed globally (vitest.setup) to echo its key, so category rows
 * assert on the category id (e.g. "security") and the toggle on "collapse" /
 * "expand".
 */

import type { GraphNode } from "@repo/atlas/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AtlasGraphLegend } from "../AtlasGraphLegend";

function node(
	partial: Partial<GraphNode> & Pick<GraphNode, "key" | "kind" | "label">,
): GraphNode {
	return {
		key: partial.key,
		kind: partial.kind,
		label: partial.label,
		filePath: partial.filePath ?? null,
		language: partial.language ?? null,
		parentKey: null,
		description: partial.description ?? null,
		category: partial.category ?? null,
		isUserCategory: partial.isUserCategory ?? false,
		metrics: null,
		layout: null,
	};
}

describe("AtlasGraphLegend", () => {
	it("renders nothing when there are no nodes", () => {
		const { container } = render(<AtlasGraphLegend nodes={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("expanded by default: lists only the categories present on the graph", () => {
		render(
			<AtlasGraphLegend
				nodes={[
					node({
						key: "auth",
						kind: "MODULE",
						label: "modules/saas/auth",
					}),
					node({
						key: "ai",
						kind: "CAPABILITY",
						label: "AI Agent Orchestration",
					}),
					node({ key: "ui", kind: "MODULE", label: "modules/ui" }),
				]}
			/>,
		);

		// Title + present categories (echoed i18n keys).
		expect(screen.getByText("title")).toBeInTheDocument();
		expect(screen.getByText("security")).toBeInTheDocument();
		expect(screen.getByText("ai")).toBeInTheDocument();
		expect(screen.getByText("experience")).toBeInTheDocument();
		// Absent categories must not appear.
		expect(screen.queryByText("integration")).toBeNull();
		expect(screen.queryByText("data")).toBeNull();
		expect(screen.queryByText("infra")).toBeNull();
	});

	it("works for a business graph (capabilities) the same way", () => {
		render(
			<AtlasGraphLegend
				nodes={[
					node({
						key: "bill",
						kind: "CAPABILITY",
						label: "Billing & Payments",
					}),
					node({
						key: "store",
						kind: "CAPABILITY",
						label: "Data Persistence & Storage",
					}),
				]}
			/>,
		);

		expect(screen.getByText("ops")).toBeInTheDocument();
		expect(screen.getByText("data")).toBeInTheDocument();
		expect(screen.queryByText("security")).toBeNull();
	});

	it("prefers the persisted effective category over keyword categorisation", () => {
		render(
			<AtlasGraphLegend
				nodes={[
					// Label keywords as "experience", but a persisted override
					// re-categorises it as "security" — the override must win.
					node({
						key: "ui",
						kind: "MODULE",
						label: "modules/ui",
						category: "security",
						isUserCategory: true,
					}),
				]}
			/>,
		);

		expect(screen.getByText("security")).toBeInTheDocument();
		// The keyword category it would otherwise have shown is absent.
		expect(screen.queryByText("experience")).toBeNull();
	});

	it("lists user-defined custom categories with their raw name + a swatch", () => {
		render(
			<AtlasGraphLegend
				nodes={[
					node({
						key: "auth",
						kind: "MODULE",
						label: "modules/saas/auth",
					}),
					node({
						key: "pay",
						kind: "CAPABILITY",
						label: "Checkout",
						category: "payments-team",
						isUserCategory: true,
					}),
				]}
			/>,
		);

		// Known preset (security) renders by its echoed i18n key…
		expect(screen.getByText("security")).toBeInTheDocument();
		// …and the custom category renders by its raw value (not an i18n key).
		expect(screen.getByText("payments-team")).toBeInTheDocument();
	});

	it("collapses to a single labelled icon button and expands again", async () => {
		const user = userEvent.setup();
		render(
			<AtlasGraphLegend
				nodes={[
					node({
						key: "auth",
						kind: "MODULE",
						label: "modules/saas/auth",
					}),
				]}
			/>,
		);

		// The expanded header toggle carries a "collapse" accessible name.
		const collapse = screen.getByRole("button", { name: "collapse" });
		expect(collapse).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("security")).toBeInTheDocument();

		await user.click(collapse);

		// Collapsed: the list is gone and only an "expand" icon button remains.
		expect(screen.queryByText("security")).toBeNull();
		const expand = screen.getByRole("button", { name: "expand" });
		expect(expand).toHaveAttribute("aria-expanded", "false");

		await user.click(expand);
		expect(screen.getByText("security")).toBeInTheDocument();
	});
});
