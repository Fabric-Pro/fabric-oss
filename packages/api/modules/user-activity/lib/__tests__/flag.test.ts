import { afterEach, describe, expect, it, vi } from "vitest";
import { isUserActivityDashboardEnabled } from "../flag";

describe("isUserActivityDashboardEnabled", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("defaults ON when unset", () => {
		vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", "");
		expect(isUserActivityDashboardEnabled()).toBe(true);
	});

	it.each(["false", "0", "no", "off", " FALSE ", "Off"])(
		"treats %j as OFF",
		(value) => {
			vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", value);
			expect(isUserActivityDashboardEnabled()).toBe(false);
		},
	);

	it.each(["true", "1", "yes", "anything"])("treats %j as ON", (value) => {
		vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", value);
		expect(isUserActivityDashboardEnabled()).toBe(true);
	});
});
