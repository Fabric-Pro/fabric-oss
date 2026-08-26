/**
 * Pure helpers behind Create-vs-Enrich routing.
 *
 * These are the parts that decide what the judge is even allowed to see, so a
 * silent regression here shows up as "routing stopped finding matches" long
 * before anyone suspects the shortlist. Everything under test is import-free of
 * DB/AI, so this runs in microseconds.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/action-item-routing.test.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	buildRoutingJudgePrompt,
	DEFAULT_ROUTING_CONFIDENCE_THRESHOLD,
	resolveRoutingThreshold,
	routingConfidenceThreshold,
} from "../prisma/queries/projects/action-item-routing";

describe("resolveRoutingThreshold", () => {
	const originalFloor = process.env.ACTION_ITEM_ROUTING_COSINE_FLOOR;
	const originalConfidence =
		process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD;

	afterEach(() => {
		if (originalFloor === undefined) {
			delete process.env.ACTION_ITEM_ROUTING_COSINE_FLOOR;
		} else {
			process.env.ACTION_ITEM_ROUTING_COSINE_FLOOR = originalFloor;
		}
		if (originalConfidence === undefined) {
			delete process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD;
		} else {
			process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD =
				originalConfidence;
		}
	});

	it("uses the fallback when unset or blank", () => {
		expect(resolveRoutingThreshold(undefined, 0.7)).toBe(0.7);
		expect(resolveRoutingThreshold("   ", 0.7)).toBe(0.7);
	});

	it("accepts a valid override", () => {
		expect(resolveRoutingThreshold("0.55", 0.7)).toBe(0.55);
		expect(resolveRoutingThreshold("0", 0.7)).toBe(0);
		expect(resolveRoutingThreshold("1", 0.7)).toBe(1);
	});

	it("falls back rather than accepting a value outside 0..1 or unparseable", () => {
		// A typo'd env var must not silently disable the gate: "86" would route
		// nothing and "-1" would route everything.
		expect(resolveRoutingThreshold("86", 0.7)).toBe(0.7);
		expect(resolveRoutingThreshold("-1", 0.7)).toBe(0.7);
		expect(resolveRoutingThreshold("high", 0.7)).toBe(0.7);
		expect(resolveRoutingThreshold("NaN", 0.7)).toBe(0.7);
	});

	it("reads the env var the dev team tunes", () => {
		// The cosine floor is no longer routing's to tune: the shortlist comes
		// from `action-item-link-core`, so its floor is the one that applies and
		// a second env var here would have been a lever wired to nothing.
		process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD = "0.9";
		expect(routingConfidenceThreshold()).toBe(0.9);

		delete process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD;
		expect(routingConfidenceThreshold()).toBe(
			DEFAULT_ROUTING_CONFIDENCE_THRESHOLD,
		);
	});
});

describe("buildRoutingJudgePrompt", () => {
	it("asks for an identifier and biases uncertainty toward create", () => {
		const prompt = buildRoutingJudgePrompt({
			actionItem: "Add rate limiting to the export endpoint",
			reasoning: "Raised twice in the meeting",
			candidates: [
				{
					identifier: "F-12",
					title: "Export throttling",
					content: "…",
				},
			],
		});

		expect(prompt).toContain("Add rate limiting to the export endpoint");
		expect(prompt).toContain("Raised twice in the meeting");
		expect(prompt).toContain("F-12");
		expect(prompt).toContain("targetIdentifier");
		// The safety posture is the whole reason this prompt is shared and
		// tested: a wrongly enriched ticket corrupts a live record.
		expect(prompt).toMatch(/unsure, answer "create"/i);
	});

	it("survives an empty candidate list without producing an undefined example", () => {
		const prompt = buildRoutingJudgePrompt({
			actionItem: "Something",
			candidates: [],
		});
		expect(prompt).not.toContain("undefined");
	});
});
