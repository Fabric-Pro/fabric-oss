/**
 * Tests for the shared `HelpTooltip` / `InlineTooltip` components used
 * throughout the admin monitoring dashboard to explain opaque terms in
 * plain English.
 *
 * Verifies:
 *   - The `(?)` help trigger renders with a proper `aria-label`
 *     ("What is {label}?") so screen readers announce the affordance.
 *   - The trigger is a real `<button>` so it joins the tab order without
 *     custom event wiring.
 *   - The tooltip is reachable by keyboard (the button is focusable;
 *     Radix's data-state attributes handle the open/close lifecycle).
 *   - `InlineTooltip` exposes the wrapped element as a button with its own
 *     `aria-label`, so non-icon UI (badges, pills) can still be tooltipped.
 *
 * Why we don't assert the tooltip *content* renders on hover
 * --------------------------------------------------------
 * Radix Tooltip opens its content via a portal driven by pointer/keyboard
 * events whose timing is delicate inside jsdom. We test for the structural
 * pieces (trigger, aria-label, content prop) and let Radix's own test
 * suite cover the open/close lifecycle. This is the same trade-off the
 * sibling `ProviderHealthBadge.test.tsx` makes.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	HelpTooltip,
	InlineTooltip,
} from "../../../../../modules/saas/admin/component/monitoring/HelpTooltip";

describe("HelpTooltip", () => {
	it("renders a button with aria-label derived from the label prop", () => {
		render(
			<HelpTooltip label="severity">Severity tooltip body</HelpTooltip>,
		);
		const trigger = screen.getByRole("button", {
			name: /What is severity\?/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger.tagName).toBe("BUTTON");
	});

	it("uses a real <button> so it joins the tab order", () => {
		render(
			<HelpTooltip label="hysteresis">
				Hysteresis is the cool-down before auto-resolve.
			</HelpTooltip>,
		);
		const trigger = screen.getByRole("button", {
			name: /What is hysteresis\?/i,
		});
		// Buttons have implicit tabindex of 0 — assert we did not opt out
		// with `tabindex="-1"`.
		expect(trigger.getAttribute("tabindex")).toBeNull();
		// The button is keyboard-focusable -- programmatic focus succeeds.
		trigger.focus();
		expect(document.activeElement).toBe(trigger);
	});

	it("nests an aria-hidden help icon inside the trigger", () => {
		const { container } = render(
			<HelpTooltip label="burn rate">Burn rate body</HelpTooltip>,
		);
		const icon = container.querySelector("svg[aria-hidden='true']");
		expect(icon).not.toBeNull();
	});
});

describe("InlineTooltip", () => {
	it("wraps the child in a button with the provided aria-label", () => {
		render(
			<InlineTooltip
				label="Severity SEV1"
				content="SEV-1 — customer-impacting outage."
			>
				<span data-testid="badge-content">SEV1</span>
			</InlineTooltip>,
		);
		const trigger = screen.getByRole("button", {
			name: /Severity SEV1/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(screen.getByTestId("badge-content")).toBeInTheDocument();
	});

	it("keeps the wrapped element keyboard-focusable", () => {
		render(
			<InlineTooltip
				label="Status FIRING"
				content="Active and unacknowledged."
			>
				<span>FIRING</span>
			</InlineTooltip>,
		);
		const trigger = screen.getByRole("button", {
			name: /Status FIRING/i,
		});
		trigger.focus();
		expect(document.activeElement).toBe(trigger);
	});
});
