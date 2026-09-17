/**
 * Tests for the server-side monitoring kill switch.
 *
 * One flag remains server-side, `feature-burn-rate-alerts`, default ON. The
 * three monitoring UI flags are read only by the web app's `NEXT_PUBLIC_*`
 * reader; their server twins were removed (Fizzy #2300) because nothing read
 * them.
 *
 * Falsy parsing: `"false"`, `"0"`, `"no"`, `"off"` (case-insensitive,
 * trimmed) disables the flag. Anything else — including unset, empty,
 * `"true"`, `"1"`, `"yes"`, `"on"` — keeps the flag enabled.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as flags from "../lib/feature-flags";
import {
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
	it("exports only the server-side burn-rate kill switch", () => {
		expect([...MONITORING_FEATURE_FLAGS]).toEqual([
			"feature-burn-rate-alerts",
		]);
	});

	it("no longer exports a bulk reader (#2300)", () => {
		expect("getMonitoringFeatureFlags" in flags).toBe(false);
	});

	it("maps the flag to its screaming-snake env var", () => {
		expect(MONITORING_FEATURE_ENV_VARS["feature-burn-rate-alerts"]).toBe(
			"FABRIC_FEATURE_BURN_RATE_ALERTS",
		);
		for (const name of Object.values(MONITORING_FEATURE_ENV_VARS)) {
			expect(name).toMatch(/^FABRIC_FEATURE_[A-Z_]+$/);
		}
	});
});

describe("isMonitoringFeatureEnabled — default ON kill switch", () => {
	it("returns true when the env var is unset", () => {
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			true,
		);
	});

	it("returns true when the env var is empty", () => {
		process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = "";
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			true,
		);
	});

	it.each(["false", "FALSE", "False", "0", "no", "NO", "off", "OFF"])(
		"returns false when the env var is the falsy-looking string %s",
		(value) => {
			process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = value;
			expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
				false,
			);
		},
	);

	it("treats unrecognized strings as enabled (default ON)", () => {
		// Only explicit falsy values disable; a typo such as "disabled" keeps
		// the alert pipeline ON rather than muting it by accident.
		process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = "disabled";
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			true,
		);
	});
});

describe("isMonitoringFeatureEnabled — explicit env var override", () => {
	it.each(["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"])(
		"returns true when the env var is the explicitly truthy string %s",
		(value) => {
			process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = value;
			expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
				true,
			);
		},
	);

	it("trims whitespace before parsing", () => {
		process.env.FABRIC_FEATURE_BURN_RATE_ALERTS = "   false   ";
		expect(isMonitoringFeatureEnabled("feature-burn-rate-alerts")).toBe(
			false,
		);
	});

	it("does not cache — picks up a mid-process env var flip", () => {
		const flag: MonitoringFeatureFlag = "feature-burn-rate-alerts";
		const envVar = MONITORING_FEATURE_ENV_VARS[flag];

		expect(isMonitoringFeatureEnabled(flag)).toBe(true);
		process.env[envVar] = "false";
		expect(isMonitoringFeatureEnabled(flag)).toBe(false);
		process.env[envVar] = "true";
		expect(isMonitoringFeatureEnabled(flag)).toBe(true);
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
