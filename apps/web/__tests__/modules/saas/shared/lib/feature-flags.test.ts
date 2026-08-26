/**
 * Tests for the client / SSR-safe monitoring v2 feature-flag readers.
 *
 * Mirrors the server-side tests under
 * `packages/observability/__tests__/feature-flags.test.ts`. The two readers
 * share semantics (default ON kill switches, kebab-case flag ids, the same
 * falsy-string parsing), but the client reader uses `NEXT_PUBLIC_*` env
 * vars so Next.js inlines values at build time.
 *
 * Tests run under Vitest (jsdom env), so `process.env.NEXT_PUBLIC_*` is a
 * normal property access at runtime — `vi.stubEnv` works as expected.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMonitoringFeatureFlags,
	isMonitoringFeatureEnabled,
	MONITORING_FEATURE_FLAGS,
	type MonitoringFeatureFlag,
	parseFlagValue,
} from "../../../../../modules/saas/shared/lib/feature-flags";
import { useMonitoringFeatureFlag } from "../../../../../modules/saas/shared/lib/use-monitoring-feature-flag";

/**
 * The NEXT_PUBLIC_ env vars consumed by the client reader. Kept in
 * a local constant so each test resets a known set — and so a regression
 * where someone renames a var without updating the reader stays visible.
 */
const CLIENT_ENV_VARS = [
	"NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES",
	"NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER",
	"NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD",
	"NEXT_PUBLIC_FABRIC_FEATURE_BURN_RATE_ALERTS",
	"NEXT_PUBLIC_FABRIC_FEATURE_GOOGLE_DOCS_CONTEXT",
	"NEXT_PUBLIC_FABRIC_FEATURE_GET_STARTED",
] as const;

beforeEach(() => {
	// Reset every flag-controlling env var to "unset" so each test starts
	// from the documented default-ON kill-switch baseline.
	for (const name of CLIENT_ENV_VARS) {
		vi.stubEnv(name, "");
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("MONITORING_FEATURE_FLAGS — client surface", () => {
	it("exports exactly the locked flag set", () => {
		expect([...MONITORING_FEATURE_FLAGS].sort()).toEqual([
			"feature-admin-monitoring-dashboard",
			"feature-burn-rate-alerts",
			"feature-get-started",
			"feature-google-docs-context",
			"feature-incident-banner",
			"feature-inline-job-progress",
			"feature-integration-health-badges",
			"feature-job-hub",
		]);
	});
});

describe("isMonitoringFeatureEnabled — default ON kill switches", () => {
	it.each(MONITORING_FEATURE_FLAGS)(
		"returns true for %s when no env var is set",
		(flag) => {
			expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		},
	);

	it.each(["false", "0", "no", "off"])(
		"returns false when the env var is the falsy string %s",
		(value) => {
			vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", value);
			expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
				false,
			);
		},
	);

	it.each(["disabled", "undefined", "null"])(
		"returns true for unrecognized string %s (default ON)",
		(value) => {
			vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", value);
			expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
				true,
			);
		},
	);
});

describe("isMonitoringFeatureEnabled — explicit env var override", () => {
	it("disables feature-integration-health-badges when its env var is false", () => {
		vi.stubEnv(
			"NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES",
			"false",
		);
		expect(
			isMonitoringFeatureEnabled("feature-integration-health-badges"),
		).toBe(false);
	});

	it("disables feature-incident-banner when its env var is false", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", "false");
		expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
			false,
		);
	});

	it("disables feature-admin-monitoring-dashboard when its env var is false", () => {
		vi.stubEnv(
			"NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD",
			"false",
		);
		expect(
			isMonitoringFeatureEnabled("feature-admin-monitoring-dashboard"),
		).toBe(false);
	});

	it("disables feature-burn-rate-alerts when its env var is false", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_BURN_RATE_ALERTS", "false");
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			false,
		);
	});

	it.each(["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"])(
		"accepts the explicitly truthy string %s",
		(value) => {
			vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", value);
			expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
				true,
			);
		},
	);

	it("trims whitespace before parsing", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", "  false  ");
		expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
			false,
		);
	});

	it("flags are independent — disabling one does not affect siblings", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", "false");
		expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
			false,
		);
		expect(
			isMonitoringFeatureEnabled("feature-integration-health-badges"),
		).toBe(true);
		expect(
			isMonitoringFeatureEnabled("feature-admin-monitoring-dashboard"),
		).toBe(true);
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			true,
		);
	});
});

describe("getMonitoringFeatureFlags — bulk reader", () => {
	it("returns every flag as true when no env vars are set", () => {
		const flags = getMonitoringFeatureFlags();
		expect(flags).toEqual({
			"feature-integration-health-badges": true,
			"feature-incident-banner": true,
			"feature-admin-monitoring-dashboard": true,
			"feature-burn-rate-alerts": true,
			"feature-google-docs-context": true,
			"feature-get-started": true,
			"feature-job-hub": true,
			"feature-inline-job-progress": true,
		});
	});

	it("reflects partial env var configuration", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", "false");
		vi.stubEnv(
			"NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD",
			"0",
		);

		const flags = getMonitoringFeatureFlags();
		expect(flags["feature-incident-banner"]).toBe(false);
		expect(flags["feature-admin-monitoring-dashboard"]).toBe(false);
		expect(flags["feature-integration-health-badges"]).toBe(true);
		expect(flags["feature-burn-rate-alerts"]).toBe(true);
	});

	it("returns an object with the full flag set, never a partial", () => {
		const flags = getMonitoringFeatureFlags();
		for (const flag of MONITORING_FEATURE_FLAGS) {
			expect(flags).toHaveProperty(flag);
			expect(typeof flags[flag]).toBe("boolean");
		}
	});
});

describe("useMonitoringFeatureFlag — React hook", () => {
	it("returns the current value of the flag (default ON)", () => {
		const { result } = renderHook(() =>
			useMonitoringFeatureFlag("feature-incident-banner"),
		);
		expect(result.current).toBe(true);
	});

	it("returns false when the flag is explicitly disabled", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER", "false");
		const { result } = renderHook(() =>
			useMonitoringFeatureFlag("feature-incident-banner"),
		);
		expect(result.current).toBe(false);
	});

	it("renders for every flag without throwing", () => {
		// Sanity: the hook routes through `isMonitoringFeatureEnabled`,
		// which is a switch over the literal union. This catches any
		// future flag that has been added to the union but not wired
		// into the switch — that branch would fall through to the
		// exhaustiveness guard and the hook would return false silently
		// instead of erroring; we accept that and just verify the hook
		// does not throw for any documented flag.
		for (const flag of MONITORING_FEATURE_FLAGS) {
			const { result } = renderHook(() => useMonitoringFeatureFlag(flag));
			expect(typeof result.current).toBe("boolean");
		}
	});
});

describe("parseFlagValue", () => {
	it("returns true for undefined (default ON)", () => {
		expect(parseFlagValue(undefined)).toBe(true);
	});

	it("returns true for empty string (default ON)", () => {
		expect(parseFlagValue("")).toBe(true);
	});

	it.each(["true", "TRUE", "1", "yes", "on"])(
		"returns true for the explicitly truthy string %s",
		(value) => {
			expect(parseFlagValue(value)).toBe(true);
		},
	);

	it.each(["false", "0", "no", "off"])(
		"returns false for the falsy string %s",
		(value) => {
			expect(parseFlagValue(value)).toBe(false);
		},
	);

	it.each(["enabled", "truthy", "2", "disabled"])(
		"returns true for the unrecognized string %s (default ON)",
		(value) => {
			expect(parseFlagValue(value)).toBe(true);
		},
	);
});

describe("type safety", () => {
	it("MonitoringFeatureFlag is a string-literal union, not just string", () => {
		const flag: MonitoringFeatureFlag = "feature-incident-banner";
		expect(MONITORING_FEATURE_FLAGS).toContain(flag);
	});
});
