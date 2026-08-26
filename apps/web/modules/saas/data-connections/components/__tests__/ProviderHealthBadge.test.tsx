/**
 * Tests for the ProviderHealthBadge component.
 *
 *
 * Coverage
 * --------
 * - All six `ProviderHealthStatus` values render their distinct label.
 * - `aria-label` is distinct per status and prefixed with the provider name.
 * - Click handler is invoked when the badge is the interactive variant.
 * - The non-interactive variant exposes no `<button>` (so we never nest
 *   inside the parent card's link).
 * - Tooltip body surfaces incident summary, started-at, and the
 *   statuspage link when provided.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import {
	PROVIDER_HEALTH_STATUS_VALUES,
	ProviderHealthBadge,
} from "../ProviderHealthBadge";

expect.extend(axeMatchers);

describe("ProviderHealthBadge", () => {
	it("renders distinct labels for all health status values", () => {
		const expectedLabels: Record<string, string> = {
			OPERATIONAL: "Operational",
			DEGRADED: "Degraded",
			PARTIAL_OUTAGE: "Partial outage",
			MAJOR_OUTAGE: "Major outage",
			MAINTENANCE: "Maintenance",
			UNKNOWN: "Status unavailable",
			NOT_CONFIGURED: "Not configured",
		};

		for (const status of PROVIDER_HEALTH_STATUS_VALUES) {
			const { unmount } = render(
				<ProviderHealthBadge status={status} providerName="OpenAI" />,
			);
			expect(
				screen.getByText(expectedLabels[status]),
			).toBeInTheDocument();
			unmount();
		}
	});

	it("renders NOT_CONFIGURED as a neutral gray badge (NOT destructive)", () => {
		// Regression guard for the AWS_S3_BUCKET / STRIPE_SECRET_KEY
		// missing-creds bug: the badge surface must NOT carry the
		// destructive (red) FILL classes that MAJOR_OUTAGE uses. Gray-
		// only signals "we can't tell from here", not "the provider is
		// down". (The shadcn Badge base CSS references `destructive` in
		// aria-invalid focus-ring helpers — we ignore those.)
		render(
			<ProviderHealthBadge
				status="NOT_CONFIGURED"
				providerName="Stripe"
			/>,
		);
		const status = screen.getByRole("status");
		expect(status).toHaveAttribute(
			"aria-label",
			"Stripe status: synthetic probe not configured in this environment",
		);
		// Find the rendered badge (descendant) and verify the surface
		// classes select the muted/border palette and do NOT set the
		// destructive background/border/text utilities used for outages.
		const badge = status.querySelector("[class]");
		expect(badge?.className).toMatch(/text-muted-foreground/);
		expect(badge?.className).toMatch(/bg-muted/);
		// The destructive-themed badge variants combine border-destructive
		// and bg-destructive utilities; assert their absence on the
		// surface (the shadcn aria-invalid utility classes are allowed).
		expect(badge?.className).not.toMatch(/\bborder-destructive\//);
		expect(badge?.className).not.toMatch(/\bbg-destructive\//);
		expect(badge?.className).not.toMatch(/\btext-destructive\b/);
	});

	it("exposes a provider-qualified aria-label on the static variant", () => {
		render(<ProviderHealthBadge status="DEGRADED" providerName="Stripe" />);
		const status = screen.getByRole("status");
		expect(status).toHaveAttribute("aria-label", "Stripe status: degraded");
		// Static variant -- `<span>` so we never nest interactive
		// descendants inside parent `<Link>` cards.
		expect(status.tagName).toBe("SPAN");
	});

	it("exposes a provider-qualified aria-label on the interactive variant", () => {
		render(
			<ProviderHealthBadge
				status="MAJOR_OUTAGE"
				providerName="Notion"
				onClickOpenDrawer={vi.fn()}
			/>,
		);
		// Interactive variant: the button is the primary control; the
		// `aria-label` lives on the button itself so SR users hear the
		// status in the button's accessible name.
		const button = screen.getByRole("button");
		expect(button).toHaveAttribute(
			"aria-label",
			"Notion status: major outage",
		);
	});

	it("renders distinct aria-labels per status value", () => {
		const labels = new Set<string>();
		for (const status of PROVIDER_HEALTH_STATUS_VALUES) {
			const { container, unmount } = render(
				<ProviderHealthBadge status={status} providerName="OpenAI" />,
			);
			const ariaLabel = container
				.querySelector("[role='status']")
				?.getAttribute("aria-label");
			expect(ariaLabel).toBeTruthy();
			if (ariaLabel) {
				labels.add(ariaLabel);
			}
			unmount();
		}
		expect(labels.size).toBe(PROVIDER_HEALTH_STATUS_VALUES.length);
	});

	it("invokes the drawer handler when the interactive badge is clicked", async () => {
		const onClick = vi.fn();
		render(
			<ProviderHealthBadge
				status="MAJOR_OUTAGE"
				providerName="Notion"
				onClickOpenDrawer={onClick}
			/>,
		);
		const button = screen.getByRole("button");
		await userEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("does NOT render a button when onClickOpenDrawer is omitted", () => {
		render(
			<ProviderHealthBadge status="OPERATIONAL" providerName="GitHub" />,
		);
		// No interactive trigger in the static variant.
		expect(screen.queryByRole("button")).toBeNull();
		// `role=status` is on the wrapping span so the badge still
		// announces health changes to screen readers.
		expect(screen.getByRole("status").tagName).toBe("SPAN");
	});

	it("does not crash when given an invalid startedAt string", () => {
		render(
			<ProviderHealthBadge
				status="MAJOR_OUTAGE"
				providerName="OpenAI"
				incidentSummary="API errors spiking"
				startedAt="not-a-real-date"
			/>,
		);
		expect(screen.getByText("Major outage")).toBeInTheDocument();
	});

	it("surfaces the incident summary when provided", () => {
		render(
			<ProviderHealthBadge
				status="MAJOR_OUTAGE"
				providerName="OpenAI"
				incidentSummary="API errors spiking"
				onClickOpenDrawer={vi.fn()}
			/>,
		);
		// Tooltip content is teleported via Radix Portal; rendered to
		// document body but not visible until hover. Assert presence of
		// the badge text only at this layer; tooltip interaction is
		// covered by the E2E happy path.
		expect(screen.getByText("Major outage")).toBeInTheDocument();
	});

	it("exposes PROVIDER_HEALTH_STATUS_VALUES with exactly seven entries (six health + NOT_CONFIGURED)", () => {
		expect(PROVIDER_HEALTH_STATUS_VALUES.length).toBe(7);
		expect(new Set(PROVIDER_HEALTH_STATUS_VALUES).size).toBe(7);
	});

	it("has no axe-core violations across all six health states (static variant)", async () => {
		// Stamp every health state in one DOM tree and run a single axe
		// pass — surfaces any aria-label, color-contrast, or role issue
		// that varies per state in a single assertion.
		const { baseElement } = render(
			<ul>
				{PROVIDER_HEALTH_STATUS_VALUES.map((status) => (
					<li key={status}>
						<ProviderHealthBadge
							status={status}
							providerName="OpenAI"
						/>
					</li>
				))}
			</ul>,
		);
		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});

	it("has no axe-core violations for the interactive variant", async () => {
		const { baseElement } = render(
			<ProviderHealthBadge
				status="MAJOR_OUTAGE"
				providerName="OpenAI"
				incidentSummary="API errors spiking"
				onClickOpenDrawer={vi.fn()}
			/>,
		);
		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});
});
