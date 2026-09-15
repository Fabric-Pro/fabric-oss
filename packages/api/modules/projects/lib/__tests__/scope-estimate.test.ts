/**
 * Scope estimate roll-up (plan Slice 7).
 *
 * The Heritage appendix fixture lives in the temporal package and is not
 * loadable from here, so the 100-line scope is rebuilt programmatically:
 * 20 areas × 5 lines (FND-01 … ), phases 1/2/3, Must/Nice priorities, with
 * the phase-3 "Nice" lines deferred and a handful of open spikes.
 */

import { describe, expect, it } from "vitest";
import {
	buildScopeEstimate,
	escapeCsvCell,
	formatPointTotals,
	orderPhases,
	type PointTotals,
	phaseFromLabels,
	renderScopeEstimateCsv,
	renderScopeEstimateMarkdown,
	type ScopeEstimateStoryInput,
	scopeEstimateFilename,
} from "../scope-estimate";

const AREAS = [
	"FND",
	"VIS",
	"INT",
	"SEC",
	"RPT",
	"USR",
	"ORG",
	"BIL",
	"NOT",
	"SRC",
	"AUD",
	"API",
	"MOB",
	"OPS",
	"DAT",
	"IMP",
	"EXP",
	"CFG",
	"LOC",
	"SUP",
] as const;

function totalsOf(group: { totals: PointTotals } | undefined): PointTotals {
	if (!group) {
		throw new Error("expected a group");
	}
	return group.totals;
}

function heritageScope(): ScopeEstimateStoryInput[] {
	const rows: ScopeEstimateStoryInput[] = [];
	let n = 0;
	for (const area of AREAS) {
		for (let line = 1; line <= 5; line++) {
			n += 1;
			const phase = String(((line - 1) % 3) + 1); // 1,2,3,1,2
			const must = line !== 5;
			const isSpike = line === 3; // every area's phase-3 line is an open question
			rows.push({
				identifier: `F-${String(n).padStart(3, "0")}`,
				sourceRef: `${area}-${String(line).padStart(2, "0")}`,
				title: `${area} line ${line}`,
				labels: [
					`phase:${phase}`,
					must ? "priority:must" : "priority:nice",
				],
				deliveryTrack: isSpike ? "SPIKE" : must ? "SPECIFY" : "DEFER",
				priority: must ? "P1_HIGH" : "P3_LOW",
				size: isSpike ? "S" : "M",
				storyPoints: isSpike ? 3 : must ? 5 : 2,
				estimateConfidence: isSpike ? "LOW" : must ? "HIGH" : "MEDIUM",
				dependsOnPhases:
					phase === "1" ? [] : [String(Number(phase) - 1)],
				dependsOnRefs: line === 1 ? [] : [`${area}-01`],
			});
		}
	}
	return rows;
}

describe("phaseFromLabels / orderPhases", () => {
	it("reads the phase from a phase:N label and ignores other labels", () => {
		expect(phaseFromLabels(["priority:must", "phase:2"])).toBe("2");
		expect(phaseFromLabels(["priority:must"])).toBeNull();
		expect(phaseFromLabels(undefined)).toBeNull();
		expect(phaseFromLabels(["phase:"])).toBeNull();
	});

	it("orders quoted phases first, then the rest numerically, unassigned last", () => {
		expect(
			orderPhases(["unassigned", "10", "2", "1", "pilot"], ["2", "1"]),
		).toEqual(["2", "1", "10", "pilot", "unassigned"]);
	});
});

describe("buildScopeEstimate (Heritage-shaped scope)", () => {
	const estimate = buildScopeEstimate(heritageScope(), ["1", "2"]);

	it("produces 100 rows grouped by phase in quoted order", () => {
		expect(estimate.rows).toHaveLength(100);
		expect(estimate.byPhase.map((g) => g.key)).toEqual(["1", "2", "3"]);
		expect(estimate.byPhase.map((g) => g.rows.length)).toEqual([
			40, 40, 20,
		]);
		expect(estimate.totals.rowCount).toBe(100);
	});

	it("sorts rows by phase, then sourceRef, then identifier", () => {
		const phase1 = estimate.byPhase[0]?.rows ?? [];
		expect(phase1[0]?.sourceRef).toBe("API-01");
		expect(phase1[1]?.sourceRef).toBe("API-04");
		const refs = phase1.map((r) => r.sourceRef);
		expect([...refs].sort((a, b) => a.localeCompare(b))).toEqual(refs);
	});

	it("reports a phase with spike lines as a min–max range", () => {
		// Phase 3 holds every area's spike (LOW, 3 pt): 20 × 3 = 60 pt, all LOW.
		const phase3 = estimate.byPhase.find((g) => g.key === "3");
		expect(phase3?.totals.hasLowConfidence).toBe(true);
		expect(phase3?.totals.points).toBe(60);
		expect(phase3?.totals.confidentPoints).toBe(0);
		expect(formatPointTotals(totalsOf(phase3))).toBe("0–60");

		// Phase 1 has no LOW rows: 20 must (5 pt) + 20 must (5 pt) = 200 pt.
		const phase1 = estimate.byPhase.find((g) => g.key === "1");
		expect(phase1?.totals.hasLowConfidence).toBe(false);
		expect(formatPointTotals(totalsOf(phase1))).toBe("200");

		// Phase 2: 20 must (5) + 20 nice (2, MEDIUM) = 140, no range.
		const phase2 = estimate.byPhase.find((g) => g.key === "2");
		expect(formatPointTotals(totalsOf(phase2))).toBe("140");
	});

	it("totals per track and overall with the range at the top level", () => {
		expect(estimate.byTrack.map((g) => g.key)).toEqual([
			"SPIKE",
			"SPECIFY",
			"DEFER",
		]);
		const spike = estimate.byTrack[0];
		expect(spike?.rows).toHaveLength(20);
		expect(formatPointTotals(totalsOf(spike))).toBe("0–60");
		expect(formatPointTotals(estimate.totals)).toBe("340–400");
	});

	it("puts unlabeled stories in an 'unassigned' phase that sorts last", () => {
		const withStray = buildScopeEstimate(
			[
				...heritageScope().slice(0, 3),
				{
					identifier: "F-999",
					title: "No phase yet",
					labels: [],
					deliveryTrack: "UNCLASSIFIED",
					storyPoints: null,
				},
			],
			["1", "2"],
		);
		expect(withStray.byPhase.at(-1)?.key).toBe("unassigned");
		expect(withStray.byPhase.at(-1)?.totals.unestimatedCount).toBe(1);
		expect(withStray.rows.at(-1)?.sourceRef).toBe("");
	});
});

describe("renderers", () => {
	it("escapes CSV titles containing commas, quotes and newlines", () => {
		expect(escapeCsvCell('Say "hi", then leave')).toBe(
			'"Say ""hi"", then leave"',
		);
		expect(escapeCsvCell("plain")).toBe("plain");
		expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');

		const estimate = buildScopeEstimate([
			{
				identifier: "F-001",
				sourceRef: "VIS-01",
				title: 'Import "scope" tables, fast',
				labels: ["phase:1"],
				deliveryTrack: "SPECIFY",
				priority: "P1_HIGH",
				size: "M",
				storyPoints: 5,
				estimateConfidence: "HIGH",
				dependsOnPhases: [],
				dependsOnRefs: ["FND-01", "FND-02"],
			},
		]);
		const csv = renderScopeEstimateCsv(estimate);
		const lines = csv.split("\n");
		expect(lines[0]).toBe(
			"sourceRef,identifier,title,phase,track,priority,size,points,confidence,dependsOnPhases,dependsOnRefs",
		);
		expect(lines[1]).toBe(
			'VIS-01,F-001,"Import ""scope"" tables, fast",1,SPECIFY,P1_HIGH,M,5,HIGH,,FND-01 FND-02',
		);
		expect(csv).toContain("phase,1,1,5,5,5");
		expect(csv).toContain("total,,1,5,5,5");
	});

	it("renders markdown with per-phase totals and a range where LOW rows exist", () => {
		const estimate = buildScopeEstimate(
			[
				{
					identifier: "F-001",
					sourceRef: "FND-01",
					title: "Tenant | model",
					labels: ["phase:1"],
					deliveryTrack: "SPECIFY",
					storyPoints: 8,
					estimateConfidence: "HIGH",
				},
				{
					identifier: "F-002",
					sourceRef: "FND-02",
					title: "Can we stream PDFs?",
					labels: ["phase:1"],
					deliveryTrack: "SPIKE",
					storyPoints: 3,
					estimateConfidence: "LOW",
				},
			],
			["1"],
		);
		const md = renderScopeEstimateMarkdown(estimate, {
			projectName: "Heritage",
			generatedAt: new Date("2026-09-14T10:00:00Z"),
		});
		expect(md).toContain("# Scope estimate — Heritage");
		expect(md).toContain("| Phase 1 | 2 | 8–11 | yes |");
		expect(md).toContain("| Spike | 1 | 0–3 | yes |");
		expect(md).toContain("## Phase 1 — 8–11 points across 2 items");
		// Pipes in titles are escaped so the table stays intact.
		expect(md).toContain("Tenant \\| model");
	});

	it("builds a stable filename from the project name", () => {
		expect(
			scopeEstimateFilename(
				"Heritage Bank — Origination",
				"csv",
				new Date("2026-09-14T10:00:00Z"),
			),
		).toBe("scope-estimate-heritage-bank-origination-2026-09-14.csv");
		expect(
			scopeEstimateFilename(null, "markdown", new Date("2026-09-14")),
		).toBe("scope-estimate-project-2026-09-14.md");
	});
});

describe("SPIKE rows without an explicit confidence", () => {
	it("are treated as LOW so the phase total becomes a range", () => {
		const estimate = buildScopeEstimate(
			[
				{
					identifier: "F-001",
					sourceRef: "A-01",
					title: "Known work",
					labels: ["phase:1"],
					deliveryTrack: "SPECIFY",
					storyPoints: 5,
					estimateConfidence: "HIGH",
				},
				{
					identifier: "F-002",
					sourceRef: "A-02",
					title: "Never estimated spike",
					labels: ["phase:1"],
					deliveryTrack: "SPIKE",
					storyPoints: 3,
					estimateConfidence: null,
				},
			],
			["1"],
		);
		const spike = estimate.rows.find((row) => row.identifier === "F-002");
		expect(spike?.confidence).toBe("LOW");
		// 5 firm points + 3 LOW points → range, not a single number.
		expect(estimate.totals).toMatchObject({
			points: 8,
			confidentPoints: 5,
			hasLowConfidence: true,
		});
		const csv = renderScopeEstimateCsv(estimate);
		expect(csv).toContain(
			"A-02,F-002,Never estimated spike,1,SPIKE,,,3,LOW",
		);
	});
});
