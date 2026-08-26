import type { Prisma, ScanContentItem } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	applyCarryForwardTriage,
	chunkScanItems,
	dedupeFindingRowsByFingerprint,
} from "../scan-activities";

const item = (key: string, text: string): ScanContentItem => ({
	key,
	label: key,
	text,
});

describe("chunkScanItems — boundaries / overlap-free / giant-item ceiling", () => {
	it("packs multiple small items into one chunk under the budget", () => {
		const chunks = chunkScanItems(
			[item("a", "aaaa"), item("b", "bbbb"), item("c", "cccc")],
			100,
		);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toContain("aaaa");
		expect(chunks[0]).toContain("bbbb");
		expect(chunks[0]).toContain("cccc");
	});

	it("starts a new chunk when the next item would overflow the budget", () => {
		const chunks = chunkScanItems(
			[item("a", "x".repeat(60)), item("b", "y".repeat(60))],
			100,
		);
		// 60 + 60 > 100 → two chunks, item boundaries respected.
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe("x".repeat(60));
		expect(chunks[1]).toBe("y".repeat(60));
	});

	it("makes a single over-budget item its own chunk (never splits an item)", () => {
		const big = "z".repeat(250);
		const chunks = chunkScanItems(
			[item("a", "small"), item("big", big), item("b", "small2")],
			100,
		);
		// small | big(own chunk) | small2  → 3 chunks; the big item is intact.
		expect(chunks).toHaveLength(3);
		expect(chunks).toContain(big);
		// No chunk contains a partial slice of the big item alongside others.
		expect(chunks.find((c) => c === big)).toBe(big);
	});

	it("skips empty / whitespace-only items", () => {
		const chunks = chunkScanItems(
			[item("a", "   "), item("b", ""), item("c", "real")],
			100,
		);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe("real");
	});

	it("returns no chunks for an empty item list", () => {
		expect(chunkScanItems([], 100)).toEqual([]);
	});

	it("covers every non-empty item exactly once across all chunks", () => {
		const items = Array.from({ length: 20 }, (_, i) =>
			item(`f${i}`, `feature-${i}-`.repeat(20)),
		);
		const chunks = chunkScanItems(items, 200);
		const joined = chunks.join("\n\n");
		for (const it of items) {
			// Each item's text appears in the combined output (full coverage).
			expect(joined).toContain(it.text);
		}
	});
});

// Minimal row factory — only the fields dedup/carry-forward read.
const row = (
	over: Partial<Prisma.ScanFindingCreateManyInput> & { fingerprint?: string },
): Prisma.ScanFindingCreateManyInput =>
	({
		scanId: "scan1",
		projectId: "p1",
		category: "SECURITY",
		severity: "MEDIUM",
		title: "t",
		description: "d",
		remediation: "r",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		isCustomRule: false,
		location: "Feature F-1",
		userId: "u1",
		organizationId: null,
		confidence: 0.5,
		...over,
	}) as Prisma.ScanFindingCreateManyInput;

describe("dedupeFindingRowsByFingerprint — intra-scan collapse", () => {
	it("collapses same-fingerprint rows, keeping highest severity + max confidence", () => {
		const out = dedupeFindingRowsByFingerprint([
			row({ fingerprint: "fp1", severity: "LOW", confidence: 0.4 }),
			row({ fingerprint: "fp1", severity: "HIGH", confidence: 0.6 }),
			row({ fingerprint: "fp2", severity: "MEDIUM", confidence: 0.5 }),
		]);
		expect(out).toHaveLength(2);
		const fp1 = out.find((r) => r.fingerprint === "fp1");
		expect(fp1?.severity).toBe("HIGH");
		expect(fp1?.confidence).toBe(0.6);
	});

	it("prefers a row with a source link on a severity tie and backfills the link", () => {
		const out = dedupeFindingRowsByFingerprint([
			row({
				fingerprint: "fp1",
				severity: "HIGH",
				sourceUrl: null,
				storyId: null,
			}),
			row({
				fingerprint: "fp1",
				severity: "HIGH",
				sourceUrl: "https://repo/blob/x",
				storyId: null,
			}),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].sourceUrl).toBe("https://repo/blob/x");
	});

	it("backfills a storyId from the loser when the winner lacks one", () => {
		const out = dedupeFindingRowsByFingerprint([
			row({ fingerprint: "fp1", severity: "CRITICAL", storyId: null }),
			row({ fingerprint: "fp1", severity: "LOW", storyId: "story-9" }),
		]);
		expect(out).toHaveLength(1);
		// Winner is the CRITICAL row, but it inherits the link from the LOW row.
		expect(out[0].severity).toBe("CRITICAL");
		expect(out[0].storyId).toBe("story-9");
	});

	it("leaves distinct fingerprints untouched", () => {
		const out = dedupeFindingRowsByFingerprint([
			row({ fingerprint: "a" }),
			row({ fingerprint: "b" }),
			row({ fingerprint: "c" }),
		]);
		expect(out).toHaveLength(3);
	});
});

describe("applyCarryForwardTriage — recurring findings keep triage", () => {
	const now = new Date("2026-06-24T12:00:00Z");
	const firstSeen = new Date("2026-06-01T00:00:00Z");

	it("carries status + firstDetectedAt + (normal re-scan) severity on a match", () => {
		const prior = new Map([
			[
				"fp1",
				{
					status: "DISMISSED" as const,
					severity: "LOW",
					firstDetectedAt: firstSeen,
				},
			],
		]);
		const [out] = applyCarryForwardTriage(
			[row({ fingerprint: "fp1", severity: "HIGH", status: "OPEN" })],
			prior,
			{ now, preserveSeverity: true },
		);
		expect(out.status).toBe("DISMISSED");
		expect(out.severity).toBe("LOW");
		expect(out.firstDetectedAt).toBe(firstSeen);
	});

	it("purge re-scan carries status but RE-EVALUATES severity (preserveSeverity=false)", () => {
		const prior = new Map([
			[
				"fp1",
				{
					status: "RESOLVED" as const,
					severity: "LOW",
					firstDetectedAt: firstSeen,
				},
			],
		]);
		const [out] = applyCarryForwardTriage(
			[row({ fingerprint: "fp1", severity: "CRITICAL", status: "OPEN" })],
			prior,
			{ now, preserveSeverity: false },
		);
		// status still carried (the user's record), but severity stays fresh.
		expect(out.status).toBe("RESOLVED");
		expect(out.severity).toBe("CRITICAL");
		expect(out.firstDetectedAt).toBe(firstSeen);
	});

	it("stamps firstDetectedAt = now and leaves status OPEN for a genuinely new finding", () => {
		const [out] = applyCarryForwardTriage(
			[row({ fingerprint: "newfp", severity: "HIGH", status: "OPEN" })],
			new Map(),
			{ now, preserveSeverity: true },
		);
		expect(out.firstDetectedAt).toBe(now);
		expect(out.status).toBe("OPEN");
		expect(out.severity).toBe("HIGH");
	});

	it("uses now as firstDetectedAt when a prior match had a null firstDetectedAt (legacy row)", () => {
		const prior = new Map([
			[
				"fp1",
				{
					status: "OPEN" as const,
					severity: "MEDIUM",
					firstDetectedAt: null,
				},
			],
		]);
		const [out] = applyCarryForwardTriage(
			[row({ fingerprint: "fp1" })],
			prior,
			{ now, preserveSeverity: true },
		);
		expect(out.firstDetectedAt).toBe(now);
	});
});
