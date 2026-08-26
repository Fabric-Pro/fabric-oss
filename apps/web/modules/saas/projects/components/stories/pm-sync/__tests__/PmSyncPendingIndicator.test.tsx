import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmSyncPendingIndicator } from "../PmSyncPendingIndicator";

describe("PmSyncPendingIndicator", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders an aria-live status with the default label", () => {
		render(<PmSyncPendingIndicator />);

		const status = screen.getByRole("status");
		expect(status).toHaveAttribute("aria-live", "polite");
		expect(status).toHaveTextContent("Syncing to PM…");
	});

	it("personalizes the label with the PM tool name", () => {
		render(<PmSyncPendingIndicator pmToolName="Fizzy" />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Syncing to Fizzy…",
		);
	});

	it("uses motion-safe variant so animation is disabled when reduced motion is preferred", () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn().mockImplementation((query: string) => ({
				matches: query === "(prefers-reduced-motion: reduce)",
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		);

		render(<PmSyncPendingIndicator />);

		const status = screen.getByRole("status");
		expect(status.className).toContain("motion-safe:animate-pulse");
		expect(status.className).not.toMatch(/(?:^|\s)animate-pulse(?:\s|$)/);
	});
});
