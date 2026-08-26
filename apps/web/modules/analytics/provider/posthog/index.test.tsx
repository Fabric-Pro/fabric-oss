import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
});

const posthog = vi.hoisted(() => ({
	__loaded: false,
	capture: vi.fn(),
	init: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("next/navigation", () => ({ usePathname: () => "/en/docs" }));

import { AnalyticsScript, isTechFabricContactUrl } from ".";

describe("Fabric PostHog contract", () => {
	beforeEach(() => {
		posthog.__loaded = false;
		posthog.capture.mockReset();
		posthog.init.mockReset();
		posthog.init.mockImplementation(() => {
			posthog.__loaded = true;
		});
	});

	it("uses consent-safe cross-subdomain configuration and explicit page views", () => {
		render(<AnalyticsScript />);

		expect(posthog.init).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				autocapture: false,
				capture_pageleave: false,
				capture_pageview: false,
				cross_subdomain_cookie: true,
				disable_session_recording: true,
				person_profiles: "identified_only",
			}),
		);
		expect(posthog.capture).toHaveBeenCalledWith(
			"fabric_page_viewed",
			expect.objectContaining({ product: "suite", surface: "docs" }),
		);
	});

	it("captures direct contact intent without identifying the visitor", () => {
		render(
			<>
				<AnalyticsScript />
				<a
					href="https://techfabric.com/contact"
					data-fabric-placement="test"
					onClick={(event) => event.preventDefault()}
				>
					Contact TechFabric
				</a>
			</>,
		);

		fireEvent.click(
			screen.getByRole("link", { name: "Contact TechFabric" }),
		);
		expect(posthog.capture).toHaveBeenCalledWith(
			"fabric_contact_clicked",
			expect.objectContaining({ placement: "test", product: "suite" }),
		);
	});

	it("attributes contact intent on a www. host too", () => {
		render(
			<>
				<AnalyticsScript />
				<a
					href="https://www.techfabric.com/contact"
					data-fabric-placement="footer"
					onClick={(event) => event.preventDefault()}
				>
					Contact TechFabric
				</a>
			</>,
		);

		fireEvent.click(
			screen.getByRole("link", { name: "Contact TechFabric" }),
		);
		expect(posthog.capture).toHaveBeenCalledWith(
			"fabric_contact_clicked",
			expect.objectContaining({ placement: "footer" }),
		);
	});

	it("ignores lookalike hosts and non-contact TechFabric paths", () => {
		render(
			<>
				<AnalyticsScript />
				<a
					href="https://nottechfabric.com/contact"
					onClick={(event) => event.preventDefault()}
				>
					Lookalike
				</a>
				<a
					href="https://techfabric.com/contactless-pricing"
					onClick={(event) => event.preventDefault()}
				>
					Other page
				</a>
			</>,
		);

		fireEvent.click(screen.getByRole("link", { name: "Lookalike" }));
		fireEvent.click(screen.getByRole("link", { name: "Other page" }));
		expect(posthog.capture).not.toHaveBeenCalledWith(
			"fabric_contact_clicked",
			expect.anything(),
		);
	});
});

describe("isTechFabricContactUrl", () => {
	const cases: Array<[string, boolean]> = [
		["https://techfabric.com/contact", true],
		["https://www.techfabric.com/contact", true],
		["https://techfabric.com/contact/sales", true],
		["https://nottechfabric.com/contact", false],
		["https://techfabric.com.evil.test/contact", false],
		["https://techfabric.com/contactless-pricing", false],
		["https://fabric.pro/contact", false],
	];

	it.each(cases)("%s → %s", (href, expected) => {
		expect(isTechFabricContactUrl(new URL(href))).toBe(expected);
	});
});
