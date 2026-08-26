/**
 * Tests for the server-side monitoring v2 feature-flag readers.
 *
 * Rollout policy (post-App-Insights refactor):
 *   - All flags default ON — these are KILL SWITCHES
 *   - Per-env disable via env vars (no per-org overrides)
 *
 * Falsy parsing: `"false"`, `"0"`, `"no"`, `"off"` (case-insensitive,
 * trimmed) disables the flag. Anything else — including unset, empty,
 * `"true"`, `"1"`, `"yes"`, `"on"` — keeps the flag enabled.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getMonitoringFeatureFlags,
	isMonitoringFeatureEnabled,
	MONITORING_FEATURE_ENV_VARS,
	MONITORING_FEATURE_FLAGS,
	type MonitoringFeatureFlag,
	parseFlagValue,
} from "../lib/feature-flags";

/**
 * Snapshot + restore env vars touched by these tests so a test that
 * mutates `process.env` cannot leak state into sibling tests in the same
 * vitest worker.
 */
const envVarNames = [...Object.values(MONITORING_FEATURE_ENV_VARS)];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const name of envVarNames) {
		originalEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	for (const name of envVarNames) {
		if (originalEnv[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = originalEnv[name];
		}
	}
});

describe("MONITORING_FEATURE_FLAGS — surface area", () => {
	it("exports exactly the four flags locked by the task brief", () => {
		// Listed alphabetically to make any future addition / removal an
		// obvious diff. The spec calls out exactly these four flags.
		expect([...MONITORING_FEATURE_FLAGS].sort()).toEqual([
			"feature-admin-monitoring-dashboard",
			"feature-burn-rate-alerts",
			"feature-incident-banner",
			"feature-integration-health-badges",
		]);
	});

	it("maps every flag to a distinct env var", () => {
		const envVars = Object.values(MONITORING_FEATURE_ENV_VARS);
		const unique = new Set(envVars);
		expect(unique.size).toBe(envVars.length);
		// Defensive: env var names must be screaming-snake and prefixed.
		// We do not want a regression where a flag is silently renamed
		// to a collision with an unrelated var.
		for (const name of envVars) {
			expect(name).toMatch(/^FABRIC_FEATURE_[A-Z_]+$/);
		}
	});

	it("preserves the kebab-case flag id locked by the task brief", () => {
		// The spec mandates kebab-case flag identifiers (rolling forward
		// to a flag-management UI later, kebab-case is the GrowthBook /
		// LaunchDarkly convention). The env var on the other side is
		// SCREAMING_SNAKE. Both shapes are asserted here so a future
		// rename has to touch BOTH and re-run this test.
		expect(MONITORING_FEATURE_ENV_VARS["feature-incident-banner"]).toBe(
			"FABRIC_FEATURE_INCIDENT_BANNER",
		);
		expect(
			MONITORING_FEATURE_ENV_VARS["feature-integration-health-badges"],
		).toBe("FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES");
		expect(
			MONITORING_FEATURE_ENV_VARS["feature-admin-monitoring-dashboard"],
		).toBe("FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD");
		expect(MONITORING_FEATURE_ENV_VARS["feature-burn-rate-alerts"]).toBe(
			"FABRIC_FEATURE_BURN_RATE_ALERTS",
		);
	});
});

describe("isMonitoringFeatureEnabled — default ON kill switches", () => {
	it.each(MONITORING_FEATURE_FLAGS)(
		"returns true for %s when the env var is unset",
		(flag) => {
			// beforeEach already deleted these vars — this asserts the
			// "default ON" kill-switch semantics post-App-Insights.
			expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		},
	);

	it.each(MONITORING_FEATURE_FLAGS)(
		"returns true for %s when the env var is empty",
		(flag) => {
			process.env[MONITORING_FEATURE_ENV_VARS[flag]] = "";
			expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		},
	);

	it.each(["false", "FALSE", "False", "0", "no", "NO", "off", "OFF"])(
		"returns false when the env var is the falsy-looking string %s",
		(value) => {
			process.env[
				MONITORING_FEATURE_ENV_VARS["feature-incident-banner"]
			] = value;
			expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
				false,
			);
		},
	);

	it("treats unrecognized strings as enabled (default ON)", () => {
		// Documents kill-switch semantics: only explicit falsy values
		// disable; anything else — including typos like 'disabled' or
		// 'undefined' as a string literal — keeps the flag ON to avoid
		// accidentally muting a critical observability surface.
		process.env[MONITORING_FEATURE_ENV_VARS["feature-incident-banner"]] =
			"disabled";
		expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
			true,
		);
	});
});

describe("isMonitoringFeatureEnabled — explicit env var override", () => {
	it.each(MONITORING_FEATURE_FLAGS)(
		"returns true for %s when the env var is the literal string true",
		(flag) => {
			process.env[MONITORING_FEATURE_ENV_VARS[flag]] = "true";
			expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		},
	);

	it.each(["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"])(
		"returns true when the env var is the explicitly truthy string %s",
		(value) => {
			process.env[
				MONITORING_FEATURE_ENV_VARS["feature-burn-rate-alerts"]
			] = value;
			expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
				true,
			);
		},
	);

	it("trims whitespace before parsing", () => {
		process.env[
			MONITORING_FEATURE_ENV_VARS["feature-admin-monitoring-dashboard"]
		] = "   false   ";
		expect(
			isMonitoringFeatureEnabled("feature-admin-monitoring-dashboard"),
		).toBe(false);
	});

	it("does not cache — picks up a mid-process env var flip", () => {
		// Documents the reader's runtime semantics: every call re-reads
		// `process.env`, so an admin flipping the var (or a test
		// toggling it) takes effect on the next call.
		const flag: MonitoringFeatureFlag = "feature-integration-health-badges";
		const envVar = MONITORING_FEATURE_ENV_VARS[flag];

		expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		process.env[envVar] = "false";
		expect(isMonitoringFeatureEnabled(flag)).toBe(false);
		process.env[envVar] = "true";
		expect(isMonitoringFeatureEnabled(flag)).toBe(true);
	});

	it("flags are independent — disabling one does not affect siblings", () => {
		process.env[MONITORING_FEATURE_ENV_VARS["feature-incident-banner"]] =
			"false";
		expect(isMonitoringFeatureEnabled("feature-incident-banner")).toBe(
			false,
		);
		expect(
			isMonitoringFeatureEnabled("feature-integration-health-badges"),
		).toBe(true);
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			true,
		);
		expect(
			isMonitoringFeatureEnabled("feature-admin-monitoring-dashboard"),
		).toBe(true);
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
		});
	});

	it("reflects partial env var configuration", () => {
		process.env[MONITORING_FEATURE_ENV_VARS["feature-incident-banner"]] =
			"false";
		process.env[
			MONITORING_FEATURE_ENV_VARS["feature-admin-monitoring-dashboard"]
		] = "0";

		const flags = getMonitoringFeatureFlags();
		expect(flags["feature-incident-banner"]).toBe(false);
		expect(flags["feature-admin-monitoring-dashboard"]).toBe(false);
		expect(flags["feature-integration-health-badges"]).toBe(true);
		expect(flags["feature-burn-rate-alerts"]).toBe(true);
	});

	it("returns an object with the full flag set, never a partial", () => {
		// Defends against a regression where someone refactors the
		// reader to only emit keys for set vars. Callers depend on
		// `flags["feature-x"]` always returning a boolean, never
		// `undefined`.
		const flags = getMonitoringFeatureFlags();
		for (const flag of MONITORING_FEATURE_FLAGS) {
			expect(flags).toHaveProperty(flag);
			expect(typeof flags[flag]).toBe("boolean");
		}
	});
});

describe("parseFlagValue — primitives", () => {
	it("returns true for undefined (default ON)", () => {
		expect(parseFlagValue(undefined)).toBe(true);
	});

	it("returns true for an empty string (default ON)", () => {
		expect(parseFlagValue("")).toBe(true);
	});

	it.each(["true", "TRUE", "True", "tRuE", "1", "yes", "YES", "on", "ON"])(
		"returns true for the explicitly truthy string %s",
		(value) => {
			expect(parseFlagValue(value)).toBe(true);
		},
	);

	it.each(["false", "FALSE", "False", "0", "no", "NO", "off", "OFF"])(
		"returns false for the falsy string %s",
		(value) => {
			expect(parseFlagValue(value)).toBe(false);
		},
	);

	it.each(["disabled", "enabled", "2", "truthy", "undefined", "null"])(
		"returns true for the unrecognized string %s (default ON)",
		(value) => {
			expect(parseFlagValue(value)).toBe(true);
		},
	);
});

describe("type safety", () => {
	it("MonitoringFeatureFlag is a string-literal union, not just string", () => {
		// This is mostly a TypeScript compile-time assertion. At runtime
		// we just verify the value passes through unchanged so the test
		// fails loudly if the type narrowing ever regresses.
		const flag: MonitoringFeatureFlag = "feature-incident-banner";
		expect(MONITORING_FEATURE_FLAGS).toContain(flag);
	});
});
