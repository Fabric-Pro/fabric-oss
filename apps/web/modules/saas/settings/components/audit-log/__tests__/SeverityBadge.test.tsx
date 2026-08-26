/**
 * Tests for SeverityBadge.
 *
 * Asserts the rendered text matches the severities i18n keys (the global
 * test mock returns the key) and that the role + aria-label semantics
 * surface for assistive tech.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeverityBadge } from "../SeverityBadge";

describe("SeverityBadge", () => {
	it("renders info as a muted dot with the info label", () => {
		render(<SeverityBadge severity="info" />);
		const badge = screen.getByRole("status");
		expect(badge.getAttribute("aria-label")).toContain("severity");
		expect(badge.textContent).toContain(
			"settings.auditLog.severities.info",
		);
	});

	it("renders warning with the highlight token", () => {
		render(<SeverityBadge severity="warning" />);
		const badge = screen.getByRole("status");
		expect(badge.className).toContain("text-highlight");
	});

	it("renders error with the destructive token", () => {
		render(<SeverityBadge severity="error" />);
		const badge = screen.getByRole("status");
		expect(badge.className).toContain("text-destructive");
	});

	it("renders critical as a solid pill", () => {
		render(<SeverityBadge severity="critical" />);
		const badge = screen.getByRole("status");
		// critical uses the solid destructive background variant
		expect(badge.className).toContain("bg-destructive");
	});

	it("falls back to info for unknown severity strings", () => {
		render(<SeverityBadge severity="garbage" />);
		const badge = screen.getByRole("status");
		expect(badge.textContent).toContain(
			"settings.auditLog.severities.info",
		);
	});

	it("forwards className to the wrapper", () => {
		render(<SeverityBadge severity="info" className="custom-cls" />);
		const badge = screen.getByRole("status");
		expect(badge.className).toContain("custom-cls");
	});
});
