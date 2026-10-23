/**
 * `siteStatusOf` — what the Brand kit shows for its stored website's fetch.
 */

import { describe, expect, it } from "vitest";
import { siteStatusOf } from "../brand-kit/use-brand-kit-site-fetch";

type Attempt = NonNullable<Parameters<typeof siteStatusOf>[0]>;

function attemptOf(overrides: Partial<Attempt> = {}): Attempt {
	return {
		website: "https://example.com",
		status: "SUCCEEDED",
		failureCode: null,
		requestedAt: new Date("2026-09-01T10:00:00.000Z"),
		fetchedAt: new Date("2026-09-01T10:00:05.000Z"),
		resultWebsite: "https://example.com",
		primaryColor: "#0a2540",
		accentColors: ["#f59e0b"],
		...overrides,
	};
}

const idle = { pending: false, fetchError: null };

describe("siteStatusOf", () => {
	it("shows the stored website's own colors, primary first", () => {
		expect(siteStatusOf(attemptOf(), idle)).toEqual({
			state: "found",
			colors: ["#0a2540", "#f59e0b"],
		});
	});

	it("shows nothing fetched without an attempt", () => {
		expect(siteStatusOf(null, idle)).toEqual({ state: "none" });
	});

	it("ignores a result that answered for another website", () => {
		expect(
			siteStatusOf(
				attemptOf({ resultWebsite: "https://old.example.com" }),
				idle,
			),
		).toEqual({ state: "none" });
	});

	it("reads a result without colors as no_colors", () => {
		expect(
			siteStatusOf(
				attemptOf({ primaryColor: null, accentColors: [] }),
				idle,
			),
		).toEqual({ state: "failed", code: "no_colors" });
	});

	it("shows a stored failure's code, and failed when it has none", () => {
		expect(
			siteStatusOf(
				attemptOf({ status: "FAILED", failureCode: "unreachable" }),
				idle,
			),
		).toEqual({ state: "failed", code: "unreachable" });
		expect(siteStatusOf(attemptOf({ status: "FAILED" }), idle)).toEqual({
			state: "failed",
			code: "failed",
		});
	});

	it("shows a running attempt as running", () => {
		expect(siteStatusOf(attemptOf({ status: "RUNNING" }), idle)).toEqual({
			state: "running",
		});
	});

	it("puts a request in flight, then an explicit request's refusal, before the stored attempt", () => {
		expect(
			siteStatusOf(attemptOf(), {
				pending: true,
				fetchError: "rate_limited",
			}),
		).toEqual({ state: "running" });
		expect(
			siteStatusOf(attemptOf(), {
				pending: false,
				fetchError: "rate_limited",
			}),
		).toEqual({ state: "failed", code: "rate_limited" });
	});
});
