import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	baseModelName,
	buildDetectionText,
	buildVerifierPrompt,
	CANDIDATE_COSINE_THRESHOLD,
	canonicalPair,
	classifyVerdict,
	cosineSimilarity,
	DETECTION_VERSION,
	type DetectionItem,
	detectionTextForStory,
	hashDetectionText,
	isProximatePair,
	normalizeVerifierRelationship,
	PROXIMITY_RELAXATION,
	PROXIMITY_WINDOW_MS,
	pairKey,
	selectCandidatePairs,
	selectCandidatePairsForTargets,
} from "../prisma/queries/projects/duplicate-detection";

/** Unit vector at a chosen cosine similarity to [1, 0, 0]. */
function vectorAtSimilarity(cos: number): number[] {
	return [cos, Math.sqrt(1 - cos * cos), 0];
}

describe("cosineSimilarity", () => {
	it("returns 1 for identical vectors", () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
	});

	it("returns 0 for orthogonal vectors", () => {
		expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
	});

	it("returns 0 for a zero vector", () => {
		expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
	});

	it("returns 0 on length mismatch (never throws)", () => {
		expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
	});
});

describe("canonicalPair / pairKey", () => {
	it("orders ids lexicographically regardless of argument order", () => {
		expect(canonicalPair("b", "a")).toEqual(["a", "b"]);
		expect(canonicalPair("a", "b")).toEqual(["a", "b"]);
	});

	it("produces an order-independent key", () => {
		expect(pairKey("z", "a")).toBe(pairKey("a", "z"));
		expect(pairKey("a", "z")).toBe("a:z");
	});
});

describe("selectCandidatePairs — precision", () => {
	it("never flags unrelated (orthogonal) items", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: [1, 0, 0] },
			{ storyId: "s2", embedding: [0, 1, 0] },
			{ storyId: "s3", embedding: [0, 0, 1] },
		];
		const { pairs, truncated } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(0);
		expect(truncated).toBe(0);
	});

	it("flags near-identical items (genuine duplicates) above the threshold", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: [1, 1, 0] },
			{ storyId: "s2", embedding: [1, 1, 0.02] }, // ~identical direction
			{ storyId: "s3", embedding: [0, 0, 1] }, // unrelated
		];
		const { pairs } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ storyAId: "s1", storyBId: "s2" });
		expect(pairs[0].similarity).toBeGreaterThanOrEqual(
			CANDIDATE_COSINE_THRESHOLD,
		);
	});

	it("catches differently-framed same-capability pairs the old 0.86 gate missed (Fizzy #2018, items 573/595)", () => {
		// A 573/595-style pair: strong-but-not-near-identical similarity. Such
		// pairs sat below the old strict 0.86 gate and were never even sent to
		// the verifier — the miss this rework exists to close. They must now be
		// candidates, with the LLM verdict (not the cosine gate) deciding the
		// duplicate/overlap/distinct tier.
		const items: DetectionItem[] = [
			{ storyId: "s573", embedding: vectorAtSimilarity(1) },
			{ storyId: "s595", embedding: vectorAtSimilarity(0.78) },
		];
		const { pairs } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].similarity).toBeLessThan(0.86);
	});

	it("emits canonically-ordered pairs regardless of input order", () => {
		const items: DetectionItem[] = [
			{ storyId: "zebra", embedding: [1, 1, 0] },
			{ storyId: "alpha", embedding: [1, 1, 0] },
		];
		const { pairs } = selectCandidatePairs(items);
		expect(pairs[0].storyAId).toBe("alpha");
		expect(pairs[0].storyBId).toBe("zebra");
	});

	it("skips pairs whose key is in excludeKeys (dismissed)", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: [1, 1, 0] },
			{ storyId: "s2", embedding: [1, 1, 0] },
		];
		const { pairs } = selectCandidatePairs(items, {
			excludeKeys: new Set([pairKey("s1", "s2")]),
		});
		expect(pairs).toHaveLength(0);
	});

	it("caps candidates, reports the truncated count, and returns the dropped pairs for per-item retry", () => {
		// 5 near-identical items → 10 candidate pairs; cap at 3.
		const items: DetectionItem[] = Array.from({ length: 5 }, (_, i) => ({
			storyId: `s${i}`,
			embedding: [1, 1, i * 0.001],
		}));
		const { pairs, truncated, droppedPairs } = selectCandidatePairs(items, {
			cap: 3,
		});
		expect(pairs).toHaveLength(3);
		expect(truncated).toBe(7);
		// The overflow is returned as pairs (not just a count) so callers can
		// keep exactly the involved items stale in the embedding cache.
		expect(droppedPairs).toHaveLength(7);
		// Highest-similarity pairs are kept (descending order); every dropped
		// pair ranks at/below the kept ones.
		for (let i = 1; i < pairs.length; i++) {
			expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(
				pairs[i].similarity,
			);
		}
		expect(
			Math.max(...droppedPairs.map((p) => p.similarity)),
		).toBeLessThanOrEqual(pairs[pairs.length - 1].similarity);
	});

	it("reports just-below-threshold pairs as near-misses (log-diagnosable, never flagged)", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: vectorAtSimilarity(1) },
			// Inside the near-miss margin below the threshold.
			{
				storyId: "s2",
				embedding: vectorAtSimilarity(
					CANDIDATE_COSINE_THRESHOLD - 0.04,
				),
			},
			// Orthogonal to both in-plane vectors — not even a near-miss.
			{ storyId: "s3", embedding: [0, 0, 1] },
		];
		const { pairs, nearMisses } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(0);
		expect(nearMisses).toHaveLength(1);
		expect(nearMisses[0]).toMatchObject({ storyAId: "s1", storyBId: "s2" });
	});
});

describe("proximity relaxation (create-date signal)", () => {
	const base = new Date("2026-07-09T19:44:45Z");
	const nextDay = new Date("2026-07-10T19:12:01Z"); // the real 573/595 gap
	const weeksLater = new Date("2026-07-30T00:00:00Z");
	// Just below the base threshold, inside the relaxed band.
	const borderline = CANDIDATE_COSINE_THRESHOLD - PROXIMITY_RELAXATION / 2;

	it("isProximatePair honours the window and tolerates missing/invalid dates", () => {
		expect(isProximatePair(base, nextDay)).toBe(true);
		expect(isProximatePair(base.toISOString(), nextDay.toISOString())).toBe(
			true,
		);
		expect(isProximatePair(base, weeksLater)).toBe(false);
		expect(isProximatePair(base, null)).toBe(false);
		expect(isProximatePair(undefined, nextDay)).toBe(false);
		expect(isProximatePair("not-a-date", nextDay)).toBe(false);
		expect(
			isProximatePair(
				base,
				new Date(base.getTime() + PROXIMITY_WINDOW_MS),
			),
		).toBe(true);
		expect(
			isProximatePair(
				base,
				new Date(base.getTime() + PROXIMITY_WINDOW_MS + 1),
			),
		).toBe(false);
	});

	it("a borderline pair created close together IS a candidate (marked proximate)", () => {
		const items: DetectionItem[] = [
			{
				storyId: "s1",
				embedding: vectorAtSimilarity(1),
				createdAt: base,
			},
			{
				storyId: "s2",
				embedding: vectorAtSimilarity(borderline),
				createdAt: nextDay,
			},
		];
		const { pairs } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].proximate).toBe(true);
	});

	it("the same borderline pair created weeks apart is NOT a candidate", () => {
		const items: DetectionItem[] = [
			{
				storyId: "s1",
				embedding: vectorAtSimilarity(1),
				createdAt: base,
			},
			{
				storyId: "s2",
				embedding: vectorAtSimilarity(borderline),
				createdAt: weeksLater,
			},
		];
		const { pairs, nearMisses } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(0);
		expect(nearMisses).toHaveLength(1);
		expect(nearMisses[0].proximate).toBe(false);
	});

	it("items without createdAt never get the relaxation", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: vectorAtSimilarity(1) },
			{ storyId: "s2", embedding: vectorAtSimilarity(borderline) },
		];
		const { pairs } = selectCandidatePairs(items);
		expect(pairs).toHaveLength(0);
	});
});

describe("normalizeVerifierRelationship", () => {
	it("maps the three canonical values", () => {
		expect(
			normalizeVerifierRelationship({ relationship: "same_work_item" }),
		).toBe("same_work_item");
		expect(
			normalizeVerifierRelationship({
				relationship: "overlapping_scope",
			}),
		).toBe("overlapping_scope");
		expect(
			normalizeVerifierRelationship({ relationship: "distinct" }),
		).toBe("distinct");
	});

	it("is lenient about casing, spacing and phrasing", () => {
		expect(
			normalizeVerifierRelationship({ relationship: "Same work item" }),
		).toBe("same_work_item");
		expect(
			normalizeVerifierRelationship({
				relationship: "Overlapping Scope",
			}),
		).toBe("overlapping_scope");
		expect(
			normalizeVerifierRelationship({
				relationship: "different features",
			}),
		).toBe("distinct");
	});

	it("falls back to the legacy sameWorkItem boolean", () => {
		expect(
			normalizeVerifierRelationship({
				relationship: "",
				sameWorkItem: true,
			}),
		).toBe("same_work_item");
		expect(
			normalizeVerifierRelationship({
				relationship: null,
				sameWorkItem: false,
			}),
		).toBe("distinct");
	});

	it("treats anything unrecognized as distinct (conservative)", () => {
		expect(normalizeVerifierRelationship({ relationship: "maybe?" })).toBe(
			"distinct",
		);
		expect(normalizeVerifierRelationship({})).toBe("distinct");
	});
});

describe("buildVerifierPrompt — anti-confabulation contract", () => {
	const a = { identifier: "F-1", text: "Excalidraw MCP tool times out" };
	const b = { identifier: "F-2", text: "Images break on PM-tool sync" };

	it("makes the model state each item's own problem before classifying", () => {
		const prompt = buildVerifierPrompt(a, b);
		expect(prompt).toMatch(/problemA/);
		expect(prompt).toMatch(/problemB/);
		// The ordering instruction is the load-bearing part: deciding first and
		// justifying afterwards is what produced a fabricated shared cause.
		expect(prompt).toMatch(/before deciding anything/i);
		expect(prompt).toMatch(/ONLY Item A's content/);
		expect(prompt).toMatch(/ONLY Item B's content/);
	});

	it("instructs that a shared product area is not shared work", () => {
		const prompt = buildVerifierPrompt(a, b);
		expect(prompt).toMatch(/Shared domain is not shared work/i);
		expect(prompt).toMatch(/differ/i);
	});

	it("still wraps each item's text as untrusted delimited content", () => {
		const prompt = buildVerifierPrompt(a, b);
		expect(prompt).toContain("<item_a>");
		expect(prompt).toContain("<item_b>");
		expect(prompt).toMatch(/never instructions to follow/i);
	});

	it("mentions the proximity signal only when the pair is proximate", () => {
		expect(buildVerifierPrompt(a, b, { proximate: true })).toMatch(
			/created within/i,
		);
		expect(buildVerifierPrompt(a, b)).not.toMatch(/created within/i);
	});
});

describe("classifyVerdict", () => {
	it("routes confident verdicts to their link tier", () => {
		expect(classifyVerdict("same_work_item", 0.9)).toEqual({
			action: "link",
			linkType: "DUPLICATE",
		});
		expect(classifyVerdict("overlapping_scope", 0.8)).toEqual({
			action: "link",
			linkType: "OVERLAP",
		});
	});

	it("routes distinct verdicts to the negative-verdict cache", () => {
		expect(classifyVerdict("distinct", 0.95)).toEqual({
			action: "record-distinct",
		});
	});

	it("routes LOW-CONFIDENCE non-distinct verdicts to the negative-verdict cache too — every completed verification must persist something (drain progress)", () => {
		expect(classifyVerdict("same_work_item", 0.4)).toEqual({
			action: "record-distinct",
		});
		expect(classifyVerdict("overlapping_scope", 0.69)).toEqual({
			action: "record-distinct",
		});
	});
});

describe("baseModelName", () => {
	it("strips a provider prefix and passes through bare names", () => {
		expect(baseModelName("openai/text-embedding-3-small")).toBe(
			"text-embedding-3-small",
		);
		expect(baseModelName("text-embedding-3-small")).toBe(
			"text-embedding-3-small",
		);
	});
});

describe("selectCandidatePairsForTargets — one-vs-rest", () => {
	it("returns nothing when no targets are given", () => {
		const items: DetectionItem[] = [
			{ storyId: "s1", embedding: [1, 1, 0] },
			{ storyId: "s2", embedding: [1, 1, 0] },
		];
		const { pairs, truncated } = selectCandidatePairsForTargets(
			new Set(),
			items,
		);
		expect(pairs).toHaveLength(0);
		expect(truncated).toBe(0);
	});

	it("flags a new target against an existing duplicate", () => {
		const items: DetectionItem[] = [
			{ storyId: "existing", embedding: [1, 1, 0] },
			{ storyId: "new", embedding: [1, 1, 0.02] },
		];
		const { pairs } = selectCandidatePairsForTargets(
			new Set(["new"]),
			items,
		);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({
			storyAId: canonicalPair("existing", "new")[0],
			storyBId: canonicalPair("existing", "new")[1],
		});
	});

	it("ignores duplicate pairs that lie entirely between non-targets", () => {
		// e1/e2 are an existing duplicate pair; only `n` is a target and it is
		// unrelated to both — so nothing should be flagged.
		const items: DetectionItem[] = [
			{ storyId: "e1", embedding: [1, 1, 0] },
			{ storyId: "e2", embedding: [1, 1, 0.01] },
			{ storyId: "n", embedding: [0, 0, 1] },
		];
		const { pairs } = selectCandidatePairsForTargets(new Set(["n"]), items);
		expect(pairs).toHaveLength(0);
	});

	it("flags two new targets that duplicate each other", () => {
		const items: DetectionItem[] = [
			{ storyId: "n1", embedding: [1, 1, 0] },
			{ storyId: "n2", embedding: [1, 1, 0.01] },
			{ storyId: "existing", embedding: [0, 0, 1] },
		];
		const { pairs } = selectCandidatePairsForTargets(
			new Set(["n1", "n2"]),
			items,
		);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ storyAId: "n1", storyBId: "n2" });
	});

	it("still honours excludeKeys (dismissed pairs stay dismissed)", () => {
		const items: DetectionItem[] = [
			{ storyId: "existing", embedding: [1, 1, 0] },
			{ storyId: "new", embedding: [1, 1, 0] },
		];
		const { pairs } = selectCandidatePairsForTargets(
			new Set(["new"]),
			items,
			{ excludeKeys: new Set([pairKey("existing", "new")]) },
		);
		expect(pairs).toHaveLength(0);
	});
});

describe("buildDetectionText", () => {
	it("returns empty string for a blank title", () => {
		expect(buildDetectionText("   ")).toBe("");
		expect(buildDetectionText("", "has description")).toBe("");
	});

	it("returns the title alone when there is no description", () => {
		expect(buildDetectionText("Fix login")).toBe("Fix login");
	});

	it("joins title and description", () => {
		expect(buildDetectionText("Fix login", "users cannot sign in")).toBe(
			"Fix login\n\nusers cannot sign in",
		);
	});

	it("reads far more of a long description than the old 1,500-char window", () => {
		// v4 widened this deliberately: a long ticket's distinguishing detail
		// often sits well past 1,500 characters, and a matcher that never reads
		// it cannot match on it. Boilerplate is now handled by stripping the
		// shared headings rather than by truncating before them.
		const longDesc = "x".repeat(50_000);
		const result = buildDetectionText("T", longDesc);
		// title + "\n\n" + 8000 chars
		expect(result.length).toBe(1 + 2 + 8000);
	});

	it("keeps the assembled text inside the embedding model's input ceiling", () => {
		// The one hard limit that cannot be lifted: ~8k tokens. Everything
		// else is a tuning choice; this is physics.
		const result = buildDetectionText(
			"T",
			"x".repeat(50_000),
			"y".repeat(50_000),
			Array.from({ length: 50 }, (_, i) => ({
				title: `Part ${i}`,
				description: "z".repeat(5000),
			})),
		);
		expect(result.length).toBeLessThanOrEqual(20_000);
	});

	it("includes acceptance criteria — part of what the feature IS, and where the maturation flow's output lands", () => {
		const result = buildDetectionText(
			"Export roadmap",
			"Lets a PM download the roadmap.",
			"AC1: Given a roadmap, When I click Export, Then a CSV downloads.",
		);
		expect(result).toContain("Export roadmap");
		expect(result).toContain("Lets a PM download the roadmap.");
		expect(result).toContain("Then a CSV downloads.");
	});

	it("still budgets acceptance criteria below the description so formulaic AC can't dominate", () => {
		const result = buildDetectionText("T", "d", "y".repeat(50_000));
		// title + "\n\n" + desc + "\n\n" + 4000 chars of AC
		expect(result.length).toBe(1 + 2 + 1 + 2 + 4000);
	});

	it("folds in a split ticket's parts, where its real wording often lives", () => {
		// A split parent frequently degrades to a one-line umbrella while the
		// words an action item will echo sit in the parts. Comparing only the
		// parent makes exactly those tickets look unrelated to their own work.
		const result = buildDetectionText("Umbrella", "See parts.", null, [
			{
				title: "Rate limit the export endpoint",
				description: "429 after 100/min",
			},
			{ title: "Backfill audit rows", description: null },
		]);
		expect(result).toContain("Rate limit the export endpoint");
		expect(result).toContain("429 after 100/min");
		expect(result).toContain("Backfill audit rows");
	});

	it("strips shared template headings, which carry no discriminative signal", () => {
		const spec = [
			"## Overview",
			"Lets a PM export the roadmap.",
			"## Acceptance Criteria",
			"AC1: a CSV downloads.",
		].join("\n");
		const result = buildDetectionText("Export roadmap", spec);
		expect(result).not.toContain("## Overview");
		expect(result).not.toContain("## Acceptance Criteria");
		expect(result).toContain("Lets a PM export the roadmap.");
		expect(result).toContain("AC1: a CSV downloads.");
	});

	it("only strips heading lines, never prose that mentions a section word", () => {
		const result = buildDetectionText(
			"T",
			"The scope of this change is the export endpoint.",
		);
		expect(result).toContain(
			"The scope of this change is the export endpoint.",
		);
	});

	it("omits acceptance criteria cleanly when absent or blank (no empty separator)", () => {
		expect(buildDetectionText("T", "d", null)).toBe("T\n\nd");
		expect(buildDetectionText("T", "d", "   ")).toBe("T\n\nd");
		expect(buildDetectionText("T", null, "AC1: x")).toBe("T\n\nAC1: x");
	});
});

describe("hashDetectionText", () => {
	it("is deterministic for the same text", () => {
		const text = buildDetectionText("Fix login", "users cannot sign in");
		expect(hashDetectionText(text)).toBe(hashDetectionText(text));
	});

	it("produces a 64-char hex sha256 digest", () => {
		expect(hashDetectionText("anything")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes when the content changes (any edit invalidates the cache)", () => {
		const before = hashDetectionText(buildDetectionText("Fix login"));
		const after = hashDetectionText(
			buildDetectionText("Fix login", "now with a description"),
		);
		expect(before).not.toBe(after);
	});

	it("is sensitive to even a one-character edit", () => {
		expect(hashDetectionText("Fix login")).not.toBe(
			hashDetectionText("Fix login."),
		);
	});

	it("folds the detection version into the hash — a version bump invalidates every cached embedding and pair verdict", () => {
		const text = "Fix login";
		expect(hashDetectionText(text)).toBe(
			createHash("sha256")
				.update(`v${DETECTION_VERSION}\n${text}`)
				.digest("hex"),
		);
		// A plain content hash (no version) must NOT match — otherwise a logic
		// change could never force a re-verify of unchanged texts.
		expect(hashDetectionText(text)).not.toBe(
			createHash("sha256").update(text).digest("hex"),
		);
	});
});

describe("detectionTextForStory — the shared-cache invariant", () => {
	/**
	 * All three matchers (duplicate scan, meeting-digest linker, action-item
	 * routing) key one embedding cache on the hash of this text. If any of them
	 * computed it differently for the same story, they would invalidate each
	 * other's cached vector on every run — the cache would thrash and each
	 * feature would silently pay to re-embed the whole backlog.
	 */
	const story = {
		id: "s1",
		identifier: "F-1",
		title: "Export throttling",
		description: "## Overview\nExports need a queue.",
		acceptanceCriteria: "AC1: queued.",
		tasks: [{ title: "Rate limit", description: "429 after 100/min" }],
		createdAt: new Date("2026-08-01T00:00:00Z"),
	};

	it("reads every part of the row, so no caller can omit one by accident", () => {
		const text = detectionTextForStory(story);
		expect(text).toContain("Export throttling");
		expect(text).toContain("Exports need a queue.");
		expect(text).toContain("AC1: queued.");
		// The part is the piece a hand-rolled call would most easily forget.
		expect(text).toContain("Rate limit");
		expect(text).toContain("429 after 100/min");
	});

	it("hashes identically for the same story, whichever matcher asks", () => {
		expect(hashDetectionText(detectionTextForStory(story))).toBe(
			hashDetectionText(detectionTextForStory({ ...story })),
		);
	});

	it("changes the hash when a part changes, so a split ticket re-embeds", () => {
		const edited = {
			...story,
			tasks: [{ title: "Rate limit", description: "429 after 10/min" }],
		};
		expect(hashDetectionText(detectionTextForStory(edited))).not.toBe(
			hashDetectionText(detectionTextForStory(story)),
		);
	});
});
