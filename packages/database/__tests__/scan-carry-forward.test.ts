import { beforeEach, describe, expect, it, vi } from "vitest";

const { scanFindFirst, findingFindMany, findingCreateMany } = vi.hoisted(
	() => ({
		scanFindFirst: vi.fn(),
		findingFindMany: vi.fn(),
		findingCreateMany: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		projectScan: {
			findFirst: (...args: unknown[]) => scanFindFirst(...args),
		},
		scanFinding: {
			findMany: (...args: unknown[]) => findingFindMany(...args),
			createMany: (...args: unknown[]) => findingCreateMany(...args),
		},
	},
	Prisma: {},
}));

import {
	carryForwardFindings,
	codePathWasRescanned,
	findingWasRescanned,
} from "../prisma/queries/projects/scan";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findingWasRescanned — planning-item carry-forward selection", () => {
	it("returns true when the finding's feature was re-scanned", () => {
		expect(
			findingWasRescanned("Feature F-003", [
				"F-003",
				"Architecture Spec",
			]),
		).toBe(true);
	});

	it("returns false when the finding's feature was NOT re-scanned (→ carry)", () => {
		expect(findingWasRescanned("Feature F-003", ["F-010", "F-011"])).toBe(
			false,
		);
	});

	it("matches a document finding by its title", () => {
		expect(
			findingWasRescanned("Document: Architecture Spec", [
				"Architecture Spec",
			]),
		).toBe(true);
	});

	it("carries forward a finding with no location (conservative)", () => {
		expect(findingWasRescanned(null, ["F-003"])).toBe(false);
		expect(findingWasRescanned("", ["F-003"])).toBe(false);
	});

	it("carries forward everything when nothing was re-scanned", () => {
		expect(findingWasRescanned("Feature F-003", [])).toBe(false);
		// Empty keys are ignored, so a stray "" never matches everything.
		expect(findingWasRescanned("Feature F-003", [""])).toBe(false);
	});
});

describe("codePathWasRescanned — exact code-path match (Semgrep DIFF)", () => {
	it("matches a `path:line` location by its exact changed file path", () => {
		expect(codePathWasRescanned("src/foo.ts:42", ["src/foo.ts"])).toBe(
			true,
		);
	});

	it("matches a bare path with no line suffix", () => {
		expect(codePathWasRescanned("src/foo.ts", ["src/foo.ts"])).toBe(true);
	});

	it("does NOT substring-match — a changed `app.ts` never drops `app.ts.snap:3`", () => {
		expect(codePathWasRescanned("app.ts.snap:3", ["app.ts"])).toBe(false);
	});

	it("does not match an unchanged file", () => {
		expect(codePathWasRescanned("src/bar.ts:10", ["src/foo.ts"])).toBe(
			false,
		);
	});

	it("handles null / empty conservatively", () => {
		expect(codePathWasRescanned(null, ["src/foo.ts"])).toBe(false);
		expect(codePathWasRescanned("src/foo.ts:1", [])).toBe(false);
	});
});

describe("carryForwardFindings — type-aware code carry-forward", () => {
	const priorFinding = (over: Record<string, unknown>) => ({
		scanId: "prev",
		projectId: "p1",
		storyId: null,
		category: "SECURITY",
		severity: "HIGH",
		title: "t",
		description: "d",
		remediation: null,
		ruleSource: "Semgrep: x",
		isCustomRule: false,
		location: null,
		sourceUrl: null,
		evidence: null,
		status: "OPEN",
		confidence: null,
		fingerprint: null,
		firstDetectedAt: new Date("2026-01-01T00:00:00Z"),
		userId: "u1",
		organizationId: null,
		...over,
	});

	const carriedLocations = (): (string | null)[] => {
		const data = findingCreateMany.mock.calls[0]?.[0]?.data ?? [];
		return (data as { location: string | null }[]).map((f) => f.location);
	};

	beforeEach(() => {
		// A previous COMPLETED scan exists to carry from.
		scanFindFirst.mockResolvedValue({ id: "prev" });
	});

	it("CARRIES a git-history secret whose file was re-scanned (HIGH-severity regression)", async () => {
		findingFindMany.mockResolvedValue([
			priorFinding({
				ruleSource: "Secret history: aws-access-key",
				location: "src/config.ts, line 12, commit abcd1234ef",
			}),
		]);
		await carryForwardFindings("cur", "p1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
			rescannedCodePaths: ["src/config.ts"],
		});
		// gitleaks DIFF (base..HEAD) never re-detects a pre-base secret, so dropping
		// it by the changed file path would silently lose it — it MUST carry forward.
		expect(carriedLocations()).toContain(
			"src/config.ts, line 12, commit abcd1234ef",
		);
	});

	it("DROPS a Semgrep finding on a re-scanned code path (the fresh scan supersedes it)", async () => {
		findingFindMany.mockResolvedValue([
			priorFinding({
				ruleSource: "Semgrep: xss",
				location: "src/config.ts:12",
			}),
		]);
		await carryForwardFindings("cur", "p1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
			rescannedCodePaths: ["src/config.ts"],
		});
		expect(findingCreateMany).not.toHaveBeenCalled();
	});

	it("does NOT drop a Semgrep finding by a substring path (app.ts vs app.ts.snap)", async () => {
		findingFindMany.mockResolvedValue([
			priorFinding({
				ruleSource: "Semgrep: x",
				location: "app.ts.snap:3",
			}),
		]);
		await carryForwardFindings("cur", "p1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
			rescannedCodePaths: ["app.ts"],
		});
		expect(carriedLocations()).toContain("app.ts.snap:3");
	});

	it("DROPS a carried finding whose fingerprint is already in the fresh set (no double-count)", async () => {
		findingFindMany.mockResolvedValue([
			priorFinding({
				ruleSource: "Semgrep: x",
				location: "src/z.ts:1",
				fingerprint: "fp-1",
			}),
		]);
		await carryForwardFindings("cur", "p1", {
			targetType: "PROJECT",
			scannedItemKeys: [],
			rescannedCodePaths: [],
			freshFingerprints: new Set(["fp-1"]),
		});
		expect(findingCreateMany).not.toHaveBeenCalled();
	});
});
