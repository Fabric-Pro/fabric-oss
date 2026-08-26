/**
 * The Job Hub renders only the counter keys it lists and only the labels it
 * has, so a new job kind needs both or it lands in the panel half-drawn
 * (Fizzy #1850).
 */

import en from "@repo/i18n/translations/en.json";
import { formatJobCounts } from "@saas/jobs/lib/format-job";
import { describe, expect, it } from "vitest";

describe("formatJobCounts — publishing", () => {
	it("renders the suggested-topic counter", () => {
		expect(
			formatJobCounts(
				{ topicsSuggested: 4 },
				(key, v) => `${key}:${v.count}`,
			),
		).toEqual(["topicsSuggested:4"]);
	});

	it("renders nothing for a run that suggested none — the panel's zero-suppression, not a missing key", () => {
		expect(formatJobCounts({ topicsSuggested: 0 }, (key) => key)).toEqual(
			[],
		);
	});
});

describe("Job Hub copy", () => {
	it("labels the publishing job kind, so the card does not print a raw enum value", () => {
		expect(en.app.jobs.kinds).toHaveProperty("PUBLISHING_TOPIC_GENERATION");
	});

	it("labels every publishing step key", () => {
		for (const key of ["collect", "summarize", "persist"]) {
			expect(en.app.jobs.steps).toHaveProperty(key);
		}
	});

	it("labels the publishing counter", () => {
		expect(en.app.jobs.counts).toHaveProperty("topicsSuggested");
	});

	it("mentions publishing in the empty state, which enumerates what can appear there", () => {
		expect(en.app.jobs.empty.description.toLowerCase()).toContain(
			"publishing",
		);
	});
});
