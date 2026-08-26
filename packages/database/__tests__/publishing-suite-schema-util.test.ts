import { describe, expect, it } from "vitest";
import {
	computeDedupeKey,
	computeSubjectKey,
	evaluateSufficiency,
	normalizeTopicEnrichment,
	PublishingTopicSuggestionsSchema,
	SUBJECT_MAX,
} from "../src/publishing-suite-schema";

describe("computeDedupeKey", () => {
	it("is stable across whitespace/case of the subject", () => {
		const a = computeDedupeKey("p1", "  We Cut  p95 Latency 40% ");
		const b = computeDedupeKey("p1", "we cut p95 latency 40%");
		expect(a).toBe(b);
	});
	it("differs by project", () => {
		expect(computeDedupeKey("p1", "x")).not.toBe(
			computeDedupeKey("p2", "x"),
		);
	});
});

describe("evaluateSufficiency", () => {
	const zero = {
		stories: 0,
		documents: 0,
		transcripts: 0,
		pullRequests: 0,
		releases: 0,
	};
	it("false when nothing clears any bar", () => {
		expect(evaluateSufficiency(zero)).toBe(false);
	});
	it("true on >=1 transcript alone", () => {
		expect(evaluateSufficiency({ ...zero, transcripts: 1 })).toBe(true);
	});
	it("true on >=3 PRs; false on 2", () => {
		expect(evaluateSufficiency({ ...zero, pullRequests: 3 })).toBe(true);
		expect(evaluateSufficiency({ ...zero, pullRequests: 2 })).toBe(false);
	});
	it("true on >=2 documents; false on 1", () => {
		expect(evaluateSufficiency({ ...zero, documents: 2 })).toBe(true);
		expect(evaluateSufficiency({ ...zero, documents: 1 })).toBe(false);
	});
	it("false on stories alone — story-completion is deferred to 1C (M5)", () => {
		expect(evaluateSufficiency({ ...zero, stories: 99 })).toBe(false);
	});
});

describe("PublishingTopicSuggestionsSchema", () => {
	it("accepts a well-formed topic", () => {
		const r = PublishingTopicSuggestionsSchema.safeParse({
			topics: [
				{ title: "T", pitch: "P", provenance: { storyIds: ["s1"] } },
			],
		});
		expect(r.success).toBe(true);
	});
});

describe("normalizeTopicEnrichment — angle (FR9/10)", () => {
	it("keeps a valid angle, trimmed", () => {
		expect(
			normalizeTopicEnrichment({ angle: "  Engineering deep-dive  " })
				.angle,
		).toBe("Engineering deep-dive");
	});
	it("omits angle when absent", () => {
		expect(normalizeTopicEnrichment({}).angle).toBeUndefined();
	});
	it("drops a non-string angle", () => {
		expect(normalizeTopicEnrichment({ angle: 42 }).angle).toBeUndefined();
	});
	it("drops a whitespace-only angle", () => {
		expect(
			normalizeTopicEnrichment({ angle: "   " }).angle,
		).toBeUndefined();
	});
	it("truncates an over-length angle to ANGLE_MAX (60)", () => {
		expect(
			normalizeTopicEnrichment({ angle: "x".repeat(200) }).angle,
		).toHaveLength(60);
	});
});

describe("PublishingTopicSuggestionsSchema — angle", () => {
	it("accepts a topic with a valid angle", () => {
		const r = PublishingTopicSuggestionsSchema.safeParse({
			topics: [
				{
					title: "T",
					pitch: "P",
					provenance: {},
					angle: "Exec summary",
				},
			],
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.topics[0].angle).toBe("Exec summary");
		}
	});
	it("accepts a topic with no angle", () => {
		const r = PublishingTopicSuggestionsSchema.safeParse({
			topics: [{ title: "T", pitch: "P", provenance: {} }],
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.topics[0].angle).toBeUndefined();
		}
	});
	it("rejects an angle over ANGLE_MAX", () => {
		const r = PublishingTopicSuggestionsSchema.safeParse({
			topics: [
				{
					title: "T",
					pitch: "P",
					provenance: {},
					angle: "x".repeat(61),
				},
			],
		});
		expect(r.success).toBe(false);
	});
});

describe("computeSubjectKey", () => {
	it("is stable across whitespace/case of the subject", () => {
		expect(computeSubjectKey("p1", "  We Shipped  RLS ")).toBe(
			computeSubjectKey("p1", "we shipped rls"),
		);
	});
	it("differs by project", () => {
		expect(computeSubjectKey("p1", "x")).not.toBe(
			computeSubjectKey("p2", "x"),
		);
	});
	it("groups two different titles under one subject, and equals computeDedupeKey when passed a title", () => {
		// Two distinct titles that share a subject → same subjectKey.
		const k = computeSubjectKey("p1", "We shipped RLS");
		expect(computeSubjectKey("p1", "we shipped rls")).toBe(k);
		// Passing a title (no separate subject) keys by that title — identical
		// derivation to computeDedupeKey, so a subject-less record groups by title.
		expect(computeSubjectKey("p1", "Some title")).toBe(
			computeDedupeKey("p1", "Some title"),
		);
	});
});

describe("normalizeTopicEnrichment — subject", () => {
	it("trims a string subject", () => {
		expect(
			normalizeTopicEnrichment({ subject: "  Ship RLS  " }).subject,
		).toBe("Ship RLS");
	});
	it("coerces blank/non-string subject to undefined", () => {
		expect(
			normalizeTopicEnrichment({ subject: "   " }).subject,
		).toBeUndefined();
		expect(
			normalizeTopicEnrichment({ subject: 123 }).subject,
		).toBeUndefined();
		expect(normalizeTopicEnrichment({}).subject).toBeUndefined();
	});
	it("caps an oversized subject at SUBJECT_MAX", () => {
		const long = "s".repeat(SUBJECT_MAX + 50);
		expect(
			normalizeTopicEnrichment({ subject: long }).subject,
		).toHaveLength(SUBJECT_MAX);
	});
});

describe("PublishingTopicSuggestionsSchema — subject", () => {
	it("accepts an optional subject and omits it when absent", () => {
		const parsed = PublishingTopicSuggestionsSchema.parse({
			topics: [
				{ title: "T", pitch: "p", provenance: {}, subject: "S" },
				{ title: "U", pitch: "p", provenance: {} },
			],
		});
		expect(parsed.topics[0].subject).toBe("S");
		expect(parsed.topics[1].subject).toBeUndefined();
	});
});
