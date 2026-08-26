import { describe, expect, it } from "vitest";
import {
	computeTestingVerdict,
	type TestingVerdictInput,
} from "../testing-verdict";

const clean: TestingVerdictInput = {
	criteriaCount: 7,
	uncoveredCount: 0,
	ambiguousCount: 0,
	analysisStale: false,
	analysisMissing: false,
	failingCases: 0,
	casesTruncated: false,
};

const at = (patch: Partial<TestingVerdictInput>) =>
	computeTestingVerdict({ ...clean, ...patch });

describe("computeTestingVerdict", () => {
	it("is ready when every criterion is covered and nothing is failing", () => {
		expect(at({})).toEqual({
			level: "ready",
			headlineKey: "ready",
			reasons: [],
		});
	});

	it("never reports ready with no criteria to be ready against", () => {
		// The single most misleading thing this card could say: a feature with
		// no acceptance criteria has nothing to test, not nothing wrong.
		expect(at({ criteriaCount: 0 })).toMatchObject({
			level: "unknown",
			headlineKey: "noCriteria",
		});
	});

	it("does not hide a failing case behind 'nothing to test against'", () => {
		// Regression: the no-criteria early return fired even when reasons had
		// already been collected, so a feature with no parsed criteria but a
		// failing linked case rendered the muted "Nothing to test against yet"
		// headline directly above "1 linked case is failing". `failingCases` is
		// counted over linked cases, not over the matrix, so the two are
		// simultaneously reachable.
		const verdict = at({ criteriaCount: 0, failingCases: 1 });
		expect(verdict.level).toBe("blocked");
		expect(verdict.reasons.map((r) => r.key)).toContain("failing");
	});

	it("still reports no-criteria when that is genuinely the only thing wrong", () => {
		expect(
			at({ criteriaCount: 0, analysisMissing: false, failingCases: 0 }),
		).toMatchObject({ level: "unknown", headlineKey: "noCriteria" });
	});

	it("withholds a clean verdict while the case list is truncated", () => {
		// The failures that would change the answer may be on a page nobody
		// loaded, so "ready" would be a claim about data we do not have.
		expect(at({ casesTruncated: true })).toMatchObject({
			level: "unknown",
			headlineKey: "partial",
		});
	});

	it("still blocks on a real problem even when truncated", () => {
		expect(at({ casesTruncated: true, failingCases: 2 })).toMatchObject({
			level: "blocked",
		});
	});

	it.each([
		["an uncovered criterion", { uncoveredCount: 1 }],
		["a failing case", { failingCases: 1 }],
	])("blocks on %s", (_label, patch) => {
		expect(at(patch).level).toBe("blocked");
	});

	it.each([
		["ambiguity", { ambiguousCount: 3 }],
		["a stale analysis", { analysisStale: true }],
		["a missing analysis", { analysisMissing: true }],
	])("cautions — but does not block — on %s", (_label, patch) => {
		// A person can read these and decide it is fine; an untested criterion
		// or a known failure is not theirs to wave through.
		expect(at(patch).level).toBe("caution");
	});

	it("ranks a known defect above an untested criterion", () => {
		const { reasons } = at({ failingCases: 1, uncoveredCount: 2 });
		expect(reasons.map((r) => r.key)).toEqual(["failing", "uncovered"]);
	});

	it("reports staleness last, but never drops it", () => {
		const { reasons } = at({ uncoveredCount: 1, analysisStale: true });
		expect(reasons.map((r) => r.key)).toEqual(["uncovered", "stale"]);
	});

	it("says 'missing' rather than 'stale' when there is no analysis at all", () => {
		// A never-generated analysis is trivially older than the spec; reporting
		// both would state the same gap twice.
		const { reasons } = at({ analysisMissing: true, analysisStale: true });
		expect(reasons.map((r) => r.key)).toEqual(["missing"]);
	});

	it("carries the counts the copy interpolates", () => {
		const { reasons } = at({ uncoveredCount: 2, failingCases: 5 });
		expect(reasons).toEqual([
			{ key: "failing", count: 5 },
			{ key: "uncovered", count: 2 },
		]);
	});
});
