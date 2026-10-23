import type { RawErrorGroup } from "@repo/ai/lib/log-context";
import { describe, expect, it } from "vitest";
import {
	clusterByEdges,
	fingerprintCluster,
	fingerprintErrorGroup,
	matchClusterToSignature,
	mergeErrorGroups,
	normalizeErrorMessage,
} from "../fingerprint";

function group(overrides: Partial<RawErrorGroup> = {}): RawErrorGroup {
	return {
		kind: "trace",
		key: "Payment failed",
		occurrences: 5,
		firstSeen: "2026-10-21T10:00:00Z",
		lastSeen: "2026-10-21T12:00:00Z",
		affectedUsers: 1,
		components: ["checkout-api"],
		sampleMessages: ["Payment failed"],
		...overrides,
	};
}

describe("normalizeErrorMessage", () => {
	it("masks values that vary between occurrences of one failure", () => {
		const a = normalizeErrorMessage(
			"Order 18342 failed for user 5f1c9a2e-0b6d-4c41-9a51-7a3a2f0d9e11 at 2026-10-21T10:00:01.123Z",
		);
		const b = normalizeErrorMessage(
			"Order 99 failed for user 0c2d6c3e-8a1f-4f8e-b0f6-2e8d5b9d1a77 at 2026-10-22T23:59:59Z",
		);
		expect(a).toBe(b);
		expect(a).toBe("order <n> failed for user <id> at <ts>");
	});

	it("masks URLs, query strings, e-mail addresses and hex ids", () => {
		expect(
			normalizeErrorMessage(
				"GET https://api.example.com/v1/orders/42?token=abc failed for dev@example.com (0x1f, deadbeef1234)",
			),
		).toBe("get <url> failed for <email> (<hex>, <hex>)");
		expect(
			normalizeErrorMessage("POST /api/items?id=3&page=2 returned 500"),
		).toBe("post /api/items<query> returned <n>");
	});

	it("masks quoted values but not apostrophes inside words", () => {
		expect(
			normalizeErrorMessage(`Can't find table 'orders_2026' or "tmp_x"`),
		).toBe(`can't find table '<v>' or "<v>"`);
	});

	it("keeps genuinely different failures apart", () => {
		expect(normalizeErrorMessage("Payment failed: card declined")).not.toBe(
			normalizeErrorMessage("Payment failed: gateway timeout"),
		);
	});

	it("collapses whitespace, folds case and caps the length", () => {
		expect(normalizeErrorMessage("  Disk   FULL \n now ")).toBe(
			"disk full now",
		);
		expect(normalizeErrorMessage("x".repeat(1000))).toHaveLength(300);
	});
});

describe("fingerprintErrorGroup", () => {
	it("is stable across occurrences and independent of the component", () => {
		expect(
			fingerprintErrorGroup({ kind: "trace", key: "Job 12 failed" }),
		).toBe(fingerprintErrorGroup({ kind: "trace", key: "Job 7 failed" }));
	});

	it("separates exceptions from traces with the same text", () => {
		expect(fingerprintErrorGroup({ kind: "trace", key: "boom" })).not.toBe(
			fingerprintErrorGroup({ kind: "exception", key: "boom" }),
		);
	});
});

describe("mergeErrorGroups", () => {
	it("merges groups the platform split only by a varying value", () => {
		const [merged, ...rest] = mergeErrorGroups([
			group({ key: "Job 1 failed", occurrences: 3, components: ["a"] }),
			group({
				key: "Job 2 failed",
				occurrences: 4,
				firstSeen: "2026-10-20T00:00:00Z",
				lastSeen: "2026-10-22T00:00:00Z",
				affectedUsers: 7,
				components: ["b"],
				sampleMessages: ["Job 2 failed"],
			}),
		]);
		expect(rest).toEqual([]);
		expect(merged.occurrences).toBe(7);
		expect(merged.firstSeen).toBe("2026-10-20T00:00:00Z");
		expect(merged.lastSeen).toBe("2026-10-22T00:00:00Z");
		expect(merged.affectedUsers).toBe(7);
		expect(merged.components).toEqual(["a", "b"]);
	});

	it("keeps distinct failures as separate groups, most frequent first", () => {
		const merged = mergeErrorGroups([
			group({ key: "Card declined", occurrences: 6 }),
			group({ key: "Gateway timeout", occurrences: 9 }),
		]);
		expect(merged.map((g) => g.key)).toEqual([
			"Gateway timeout",
			"Card declined",
		]);
		expect(new Set(merged.map((g) => g.fingerprint)).size).toBe(2);
	});
});

describe("clusterByEdges", () => {
	it("returns connected components at or above the minimum size", () => {
		const clusters = clusterByEdges(
			["a", "b", "c", "d", "e", "f"],
			[
				{ storyAId: "a", storyBId: "b" },
				{ storyAId: "b", storyBId: "c" },
				{ storyAId: "d", storyBId: "e" },
			],
			3,
		);
		expect(clusters).toEqual([["a", "b", "c"]]);
	});

	it("ignores edges to stories outside the open set and is order-independent", () => {
		const nodes = ["s1", "s2", "s3"];
		const edges = [
			{ storyAId: "s3", storyBId: "s2" },
			{ storyAId: "s2", storyBId: "s1" },
			{ storyAId: "s1", storyBId: "closed" },
		];
		expect(clusterByEdges(nodes, edges, 2)).toEqual([["s1", "s2", "s3"]]);
		expect(clusterByEdges(nodes, [...edges].reverse(), 2)).toEqual([
			["s1", "s2", "s3"],
		]);
	});

	it("never reports a single story as a cluster", () => {
		expect(clusterByEdges(["a"], [], 1)).toEqual([]);
	});
});

describe("matchClusterToSignature", () => {
	it("continues the signature sharing the most members", () => {
		const signatures = [
			{ fingerprint: "f1", sourceStoryIds: ["a", "x"] },
			{ fingerprint: "f2", sourceStoryIds: ["a", "b", "c"] },
		];
		expect(
			matchClusterToSignature(["a", "b", "c", "d"], signatures)
				?.fingerprint,
		).toBe("f2");
		expect(matchClusterToSignature(["q", "r"], signatures)).toBeNull();
	});

	it("gives a new cluster a fingerprint independent of member order", () => {
		expect(fingerprintCluster(["b", "a"])).toBe(
			fingerprintCluster(["a", "b"]),
		);
	});
});
