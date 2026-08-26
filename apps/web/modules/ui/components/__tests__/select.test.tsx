import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../select";

// Radix Select internals use ResizeObserver + pointer capture + scrollIntoView;
// jsdom provides none of these. Mirrors the polyfill block in
// destructive-tooltip.test.tsx so the primitive renders without errors.
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => {};
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => {};
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => {};
	}
});

const LONG_VALUE =
	"As an enterprise administrator, I want a comprehensive audit trail that records who performed what actions and why, so that I can maintain accountability and meet enterprise security requirements";

// When a value is selected, Radix also renders a hidden native <select> for form
// integration, which ALSO has role="combobox". Grab the trigger <button> so the
// query is unambiguous regardless of selection state.
function getTriggerButton(): HTMLElement {
	const trigger = screen
		.getAllByRole("combobox")
		.find((element) => element.tagName === "BUTTON");
	if (!trigger) {
		throw new Error("SelectTrigger button not found");
	}
	return trigger;
}

describe("SelectTrigger truncation guards", () => {
	// Regression guard for the New Plan "Link to Feature" overlap bug: a long
	// selected value must clamp to one line inside the fixed-height trigger
	// instead of overflowing and overlapping the label above / helper text below.
	it("clamps the value span to one line and lets it shrink", () => {
		render(
			<Select>
				<SelectTrigger>
					<SelectValue placeholder="No feature selected" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">Option A</SelectItem>
				</SelectContent>
			</Select>,
		);

		const trigger = getTriggerButton();
		// `line-clamp-1` provides the single-line clamp + ellipsis; `min-w-0`
		// lets the flex child shrink so the clamp actually engages.
		expect(trigger.className).toContain("[&>span]:line-clamp-1");
		expect(trigger.className).toContain("[&>span]:min-w-0");
	});

	it("keeps the chevron icon from being squeezed (shrink-0)", () => {
		render(
			<Select>
				<SelectTrigger>
					<SelectValue placeholder="No feature selected" />
				</SelectTrigger>
			</Select>,
		);

		const trigger = getTriggerButton();
		const icon = trigger.querySelector("svg");
		expect(icon).not.toBeNull();
		expect(icon?.getAttribute("class")).toContain("shrink-0");
	});
});

describe("SelectTrigger full-value-on-hover title", () => {
	it("exposes the full selected value as a title on hover", async () => {
		const user = userEvent.setup();
		render(
			<Select>
				<SelectTrigger>
					<SelectValue placeholder="No feature selected" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="long">{LONG_VALUE}</SelectItem>
				</SelectContent>
			</Select>,
		);

		// Open the dropdown and pick the long option. Selecting closes the
		// dropdown and leaves the trigger displaying the selected value (a real
		// "value selected" state, with data-placeholder cleared).
		await user.click(getTriggerButton());
		await user.click(
			await screen.findByRole("option", { name: LONG_VALUE }),
		);

		const trigger = getTriggerButton();
		expect(trigger.textContent).toContain(LONG_VALUE);

		await user.hover(trigger);

		expect(trigger.title).toBe(LONG_VALUE);
	});

	it("does not set a misleading title in the placeholder state", async () => {
		const user = userEvent.setup();
		// No value selected → Radix renders the placeholder and marks the
		// trigger with data-placeholder.
		render(
			<Select>
				<SelectTrigger>
					<SelectValue placeholder="No feature selected" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="long">{LONG_VALUE}</SelectItem>
				</SelectContent>
			</Select>,
		);

		const trigger = getTriggerButton();
		await user.hover(trigger);

		expect(trigger.title).toBe("");
	});
});
