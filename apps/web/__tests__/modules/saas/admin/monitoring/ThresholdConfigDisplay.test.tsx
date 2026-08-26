/**
 * Unit tests for the read-only `ThresholdConfigDisplay`. Asserts the
 * canonical strings mirror the YAML rules so any drift between the prose
 * and the rules surfaces in the test suite — see the file header of the
 * component for the rationale.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	ERROR_RATE_THRESHOLDS,
	HYSTERESIS_POLICY,
	INTEGRATION_THRESHOLDS,
	ThresholdConfigDisplay,
} from "../../../../../modules/saas/admin/component/monitoring/ThresholdConfigDisplay";

describe("ThresholdConfigDisplay", () => {
	it("renders the SEV-1 / SEV-2 / SEV-3 error-rate rows in order", () => {
		render(<ThresholdConfigDisplay />);
		const errorRateTable = screen.getByRole("table", {
			name: /Error-rate burn-rate thresholds/i,
		});
		const rows = within(errorRateTable).getAllByRole("row");
		// Header + 3 data rows = 4.
		expect(rows).toHaveLength(4);
		expect(within(rows[1]).getByText("SEV-1")).toBeInTheDocument();
		expect(within(rows[2]).getByText("SEV-2")).toBeInTheDocument();
		expect(within(rows[3]).getByText("SEV-3")).toBeInTheDocument();
	});

	it("shows the 14.4x SEV-1 burn rate", () => {
		render(<ThresholdConfigDisplay />);
		expect(screen.getByText("14.4x")).toBeInTheDocument();
		expect(screen.getByText("> 10 in 1h")).toBeInTheDocument();
	});

	it("includes a row for every provider-side signal", () => {
		render(<ThresholdConfigDisplay />);
		const integrationTable = screen.getByRole("table", {
			name: /Integration provider alert thresholds/i,
		});
		for (const row of INTEGRATION_THRESHOLDS) {
			expect(
				within(integrationTable).getByText(row.signal),
			).toBeInTheDocument();
		}
	});

	it("captures the canonical hysteresis policy from L14", () => {
		render(<ThresholdConfigDisplay />);
		// Each policy string appears at least once on the page (the table
		// rows + the dl summary). `getAllByText` keeps the test happy when
		// the same canonical text is rendered in both places.
		expect(
			screen.getAllByText(HYSTERESIS_POLICY.errorRate).length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText(HYSTERESIS_POLICY.statuspage).length,
		).toBeGreaterThan(0);
		expect(
			screen.getAllByText(HYSTERESIS_POLICY.syntheticProbe).length,
		).toBeGreaterThan(0);
	});

	it("freezes the locked threshold values", () => {
		// If the constants change, the test should fail loudly so we can
		// confirm the YAML rules were updated in lock-step.
		expect(ERROR_RATE_THRESHOLDS.length).toBe(3);
		expect(ERROR_RATE_THRESHOLDS[0]).toEqual({
			severity: "SEV-1",
			longWindow: "1h",
			shortWindow: "5m",
			burnRate: "14.4x",
			minCount: "> 10 in 1h",
		});
		expect(ERROR_RATE_THRESHOLDS[1]).toEqual({
			severity: "SEV-2",
			longWindow: "6h",
			shortWindow: "30m",
			burnRate: "6x",
			minCount: "> 30 in 6h",
		});
		expect(ERROR_RATE_THRESHOLDS[2]).toEqual({
			severity: "SEV-3",
			longWindow: "3d",
			shortWindow: "6h",
			burnRate: "1x",
			minCount: "> 100 in 3d",
		});
	});
});
