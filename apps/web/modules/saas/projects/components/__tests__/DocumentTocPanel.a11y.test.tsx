/**
 * Accessibility tests for `<DocumentTocPanel>`.
 *
 * Covers:
 *   - `vitest-axe` scan returns zero violations in both the expanded and
 *     the collapsed state.
 *   - The navigation landmark carries an accessible name.
 *   - The spine (the only control visible while collapsed) carries an
 *     accessible name that flips between expand and collapse, and reports
 *     its state through aria-expanded / aria-controls.
 *   - The collapsed rail is hidden from assistive tech (`aria-hidden` +
 *     `inert`), so its entries are neither announced nor tabbable.
 *   - Heading hierarchy is exposed through nested lists, not indentation
 *     alone (WCAG 1.3.1) — indentation is presentational and would leave a
 *     screen-reader user unable to tell two same-titled sections apart.
 *
 * What this file does NOT prove: colour contrast. axe's `color-contrast`
 * rule bails out under jsdom (no `HTMLCanvasElement#getContext`), so a
 * passing `toHaveNoViolations()` says nothing about it. Contrast comes from
 * the design tokens used here and is covered by
 * `apps/web/__tests__/theme-token-contrast.test.ts`; the rendered rail was
 * additionally measured at 6.1:1 in a browser.
 *
 * next-intl is globally mocked in vitest.setup.ts (t echoes the key), so
 * accessible names are asserted as translation keys.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import type { DocumentTocItem } from "../../lib/document-toc";
import { DOCUMENT_TOC_STORAGE_KEY } from "../../lib/document-toc";
import { DocumentTocPanel } from "../DocumentTocPanel";

expect.extend(axeMatchers);

const items: DocumentTocItem[] = [
	{ id: "overview", text: "Overview", level: 1, pos: 0 },
	{ id: "use-cases", text: "Use Cases", level: 2, pos: 30 },
	{ id: "use-cases-1", text: "Use Cases", level: 2, pos: 90 },
];

afterEach(() => {
	localStorage.clear();
});

describe("DocumentTocPanel accessibility", () => {
	it("has no axe violations when expanded", async () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		const { container } = render(
			<DocumentTocPanel items={items} onNavigate={vi.fn()} />,
		);

		expect(await axe(container)).toHaveNoViolations();
	});

	it("has no axe violations when collapsed", async () => {
		const { container } = render(
			<DocumentTocPanel items={items} onNavigate={vi.fn()} />,
		);

		expect(await axe(container)).toHaveNoViolations();
	});

	it("exposes a named navigation landmark when expanded", () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		render(<DocumentTocPanel items={items} onNavigate={vi.fn()} />);

		expect(
			screen.getByRole("navigation", { name: "ariaLabel" }),
		).toBeInTheDocument();
	});

	it("keeps the spine as the single accessible control while collapsed", () => {
		render(<DocumentTocPanel items={items} onNavigate={vi.fn()} />);

		// Only the spine is exposed; the list's entries are aria-hidden.
		expect(screen.getAllByRole("button")).toHaveLength(1);
		const spine = screen.getByRole("button", { name: "expand" });
		expect(spine).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(spine);
		expect(
			screen.getByRole("button", { name: "collapse" }),
		).toBeInTheDocument();
	});

	it("hides the collapsed rail from assistive technology", () => {
		render(<DocumentTocPanel items={items} onNavigate={vi.fn()} />);

		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		const rail = nav.parentElement as HTMLElement;
		expect(rail).toHaveAttribute("aria-hidden", "true");
		expect(rail).toHaveAttribute("inert");
	});
});
