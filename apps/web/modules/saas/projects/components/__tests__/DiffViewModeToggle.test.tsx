/**
 * Component tests for DiffViewModeToggle — the accessible three-option
 * segmented control that picks the document diff review mode
 * (Inline / Side by side / Full preview).
 *
 * Behavior under test (not internals):
 *  1. Renders exactly three options with the accessible names
 *     Inline / Side by side / Full preview, in that order.
 *  2. The option matching `value` exposes the selected state
 *     (`aria-checked="true"`); the others are unchecked.
 *  3. Clicking an option calls `onChange` with the corresponding
 *     DiffViewMode.
 *  4. Keyboard: the group is a single tab stop (roving tabindex); once
 *     focused, ArrowRight / ArrowDown move selection forward and
 *     ArrowLeft / ArrowUp move it back (Radix RadioGroup semantics).
 *  5. a11y: the group carries an accessible label; every option carries
 *     an `aria-label`; and no option uses a native `title=""` attribute
 *     (informational copy is delivered via <Tooltip>, not the title attr).
 */

import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DiffViewMode } from "../../lib/diff-view-modes";

// ── jsdom polyfills ────────────────────────────────────────────────────────
// Radix RadioGroup / Tooltip reach for pointer-capture + ResizeObserver on
// mount; ResizeObserver is polyfilled globally in vitest.setup.ts, but
// hasPointerCapture is not.
beforeAll(() => {
	if (typeof Element.prototype.hasPointerCapture !== "function") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.setPointerCapture !== "function") {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (typeof Element.prototype.releasePointerCapture !== "function") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
});

// Override the global next-intl mock (vitest.setup.ts returns the raw key) so
// accessible names resolve to the REAL strings. Sourced from en.json directly
// so the test stays in lock-step with the shipped translations.
const docEditor = en.tooltips.documentEditor as Record<string, string>;
vi.mock("next-intl", () => ({
	useTranslations: (_namespace?: string) => (key: string) =>
		docEditor[key] ?? key,
}));

import { DiffViewModeToggle } from "../DiffViewModeToggle";

const INLINE = docEditor.diffModeInline;
const SIDE_BY_SIDE = docEditor.diffModeSideBySide;
const FULL_PREVIEW = docEditor.diffModeFullPreview;

function getRadios(): HTMLElement[] {
	return screen.getAllByRole("radio");
}

/**
 * Controlled harness that mirrors real usage: the parent owns the mode and
 * re-renders on change (the toggle itself is presentational). `onSpy` observes
 * every committed change so keyboard-driven selection is assertable.
 */
function ControlledToggle({
	initial,
	onSpy,
}: {
	initial: DiffViewMode;
	onSpy: (mode: DiffViewMode) => void;
}) {
	const [mode, setMode] = useState<DiffViewMode>(initial);
	return (
		<DiffViewModeToggle
			value={mode}
			onChange={(next) => {
				onSpy(next);
				setMode(next);
			}}
		/>
	);
}

describe("DiffViewModeToggle", () => {
	it("renders exactly three options with accessible names in order", () => {
		render(<DiffViewModeToggle value="inline" onChange={() => {}} />);

		const radios = getRadios();
		expect(radios).toHaveLength(3);

		// Order: Inline → Side by side → Full preview.
		const names = radios.map((r) => r.getAttribute("aria-label"));
		expect(names).toEqual([INLINE, SIDE_BY_SIDE, FULL_PREVIEW]);

		// And each is discoverable by its accessible name.
		expect(screen.getByRole("radio", { name: INLINE })).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: SIDE_BY_SIDE }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: FULL_PREVIEW }),
		).toBeInTheDocument();
	});

	it("exposes the active option via aria-checked", () => {
		render(<DiffViewModeToggle value="sideBySide" onChange={() => {}} />);

		expect(screen.getByRole("radio", { name: SIDE_BY_SIDE })).toBeChecked();
		expect(screen.getByRole("radio", { name: INLINE })).not.toBeChecked();
		expect(
			screen.getByRole("radio", { name: FULL_PREVIEW }),
		).not.toBeChecked();
	});

	it("applies the selected styling to the active segment only (driven by `value`, not data-state)", () => {
		// Regression guard. Each Item is also a `TooltipTrigger asChild`, so the
		// Tooltip overwrites Radix's `data-state="checked"` with its own
		// ("closed"/"open") on the same element — a `data-[state=checked]:` class
		// would NEVER match and the active mode would render unhighlighted. The
		// selected styling must therefore key off the `value` prop. Assert the
		// active segment carries the elevated-pill accent classes and the others
		// do not.
		render(<DiffViewModeToggle value="sideBySide" onChange={() => {}} />);

		const active = screen.getByRole("radio", { name: SIDE_BY_SIDE });
		expect(active.className).toMatch(/\bbg-card\b/);
		expect(active.className).toMatch(/\btext-primary\b/);

		for (const name of [INLINE, FULL_PREVIEW]) {
			const inactive = screen.getByRole("radio", { name });
			expect(inactive.className).not.toMatch(/\bbg-card\b/);
			expect(inactive.className).not.toMatch(/\btext-primary\b/);
		}
	});

	it("calls onChange with the right mode when an option is clicked", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<DiffViewModeToggle value="inline" onChange={onChange} />);

		await user.click(screen.getByRole("radio", { name: FULL_PREVIEW }));
		expect(onChange).toHaveBeenCalledWith("fullPreview");

		await user.click(screen.getByRole("radio", { name: SIDE_BY_SIDE }));
		expect(onChange).toHaveBeenCalledWith("sideBySide");
	});

	it("is a single tab stop with roving-tabindex arrow-key navigation", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<ControlledToggle initial="inline" onSpy={onChange} />);

		// One Tab enters the whole group (roving tabindex) and lands on the
		// checked option — proving the group is a single tab stop, not three.
		await user.tab();
		expect(screen.getByRole("radio", { name: INLINE })).toHaveFocus();

		// Arrow keys roam focus across the segments in both axes (with no fixed
		// orientation, Right/Down are "next" and Left/Up are "prev").
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("radio", { name: SIDE_BY_SIDE })).toHaveFocus();

		await user.keyboard("{ArrowDown}");
		expect(screen.getByRole("radio", { name: FULL_PREVIEW })).toHaveFocus();

		await user.keyboard("{ArrowLeft}");
		expect(screen.getByRole("radio", { name: SIDE_BY_SIDE })).toHaveFocus();

		await user.keyboard("{ArrowUp}");
		expect(screen.getByRole("radio", { name: INLINE })).toHaveFocus();
	});

	it("selects the focused option with Space", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<ControlledToggle initial="inline" onSpy={onChange} />);

		// Focus the group, roam to "Side by side", commit with Space.
		await user.tab();
		await user.keyboard("{ArrowRight}");
		await user.keyboard(" ");
		expect(onChange).toHaveBeenLastCalledWith("sideBySide");
		expect(screen.getByRole("radio", { name: SIDE_BY_SIDE })).toBeChecked();

		// Roam on to "Full preview" and commit it too.
		await user.keyboard("{ArrowRight}");
		await user.keyboard(" ");
		expect(onChange).toHaveBeenLastCalledWith("fullPreview");
		expect(screen.getByRole("radio", { name: FULL_PREVIEW })).toBeChecked();
	});

	it("labels the group and every option, and uses no native title attribute", () => {
		const { container } = render(
			<DiffViewModeToggle value="inline" onChange={() => {}} />,
		);

		// Accessible group label.
		expect(
			screen.getByRole("radiogroup", {
				name: docEditor.diffViewModeLabel,
			}),
		).toBeInTheDocument();

		// Every option carries a non-empty aria-label.
		for (const radio of getRadios()) {
			expect(radio.getAttribute("aria-label")).toBeTruthy();
		}

		// No native title="" on any element (tooltips are delivered via <Tooltip>).
		expect(container.querySelector("[title]")).toBeNull();
	});
});
