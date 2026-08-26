import { describe, expect, it } from "vitest";
import {
	applyDeploymentsResult,
	assembleFinalBrief, // ← add
	briefHasDisplayableContent,
	PROD_ANCHOR_SUMMARY, // ← add
	resolveBriefCompletion,
} from "../src/workflows/daily-brief-completion";

describe("resolveBriefCompletion", () => {
	it("fatals when all core failed and deployments did not contribute", () => {
		const r = resolveBriefCompletion({
			coreFulfilledCount: 0,
			deploymentsRan: false,
			deploymentsContributed: false,
		});
		expect(r.allCollectorsFailed).toBe(true);
		expect(r.completedSources).toBe(0);
	});

	it("does NOT fatal when deployments contributed real items (feature preserved)", () => {
		const r = resolveBriefCompletion({
			coreFulfilledCount: 0,
			deploymentsRan: true,
			deploymentsContributed: true,
		});
		expect(r.allCollectorsFailed).toBe(false);
		expect(r.completedSources).toBe(1);
	});

	it("still fatals when deployments ran but contributed nothing (no-repos / all-repos-failed / truncated-no-items)", () => {
		const r = resolveBriefCompletion({
			coreFulfilledCount: 0,
			deploymentsRan: true,
			deploymentsContributed: false,
		});
		expect(r.allCollectorsFailed).toBe(true);
		// cosmetic counter still reflects that the source ran
		expect(r.completedSources).toBe(1);
	});

	it("does not fatal on a normal run with core sources fulfilled", () => {
		const r = resolveBriefCompletion({
			coreFulfilledCount: 3,
			deploymentsRan: true,
			deploymentsContributed: false,
		});
		expect(r.allCollectorsFailed).toBe(false);
		expect(r.completedSources).toBe(4);
	});
});

const dep = {
	occurredAt: new Date("2026-06-05T10:00:00Z"),
	title: "v1.0.0",
	repoFullName: "o/r",
	tagName: "v1.0.0",
	url: "https://x/y",
};

describe("applyDeploymentsResult", () => {
	it("returns inert values when deployments are disabled (undefined settled)", () => {
		const a = applyDeploymentsResult(undefined);
		expect(a.deploymentsRan).toBe(false);
		expect(a.deploymentsContributed).toBe(false);
		expect(a.deployments).toBeUndefined();
		expect(a.deploymentsError).toBeUndefined();
	});

	it("marks ran+contributed and summarizes per-repo failures into deploymentsError", () => {
		const a = applyDeploymentsResult({
			ok: true,
			value: {
				items: [dep],
				failures: [{ repoFullName: "o/r", reason: "truncated" }],
			},
		});
		expect(a.deploymentsRan).toBe(true);
		expect(a.deploymentsContributed).toBe(true);
		expect(a.deployments).toHaveLength(1);
		expect(a.deploymentsError).toBe("o/r: truncated");
	});

	it("has no deploymentsError on a clean fetch", () => {
		const a = applyDeploymentsResult({
			ok: true,
			value: { items: [dep], failures: [] },
		});
		expect(a.deploymentsContributed).toBe(true);
		expect(a.deploymentsError).toBeUndefined();
	});

	it("marks ran but NOT contributed when fulfilled with no items", () => {
		const a = applyDeploymentsResult({
			ok: true,
			value: {
				items: [],
				failures: [{ repoFullName: "o/r", reason: "401" }],
			},
		});
		expect(a.deploymentsRan).toBe(true);
		expect(a.deploymentsContributed).toBe(false);
		expect(a.deploymentsError).toBe("o/r: 401");
	});

	it("records deploymentsError and stays not-ran when the activity rejected", () => {
		const a = applyDeploymentsResult({
			ok: false,
			reason: new Error("boom"),
		});
		expect(a.deploymentsRan).toBe(false);
		expect(a.deploymentsContributed).toBe(false);
		expect(a.deploymentsError).toMatch(/boom/);
	});
});

describe("briefHasDisplayableContent", () => {
	it("is false for a truly empty brief", () => {
		expect(
			briefHasDisplayableContent({
				executiveSummary: "",
				priorityActionCount: 0,
			}),
		).toBe(false);
	});

	it("is true when only a deploymentsError is present (quiet window + deploy outage)", () => {
		expect(
			briefHasDisplayableContent({
				executiveSummary: "",
				priorityActionCount: 0,
				deploymentsError: "o/r: down",
			}),
		).toBe(true);
	});

	it("is true with an executive summary or priority actions", () => {
		expect(
			briefHasDisplayableContent({
				executiveSummary: "x",
				priorityActionCount: 0,
			}),
		).toBe(true);
		expect(
			briefHasDisplayableContent({
				executiveSummary: "",
				priorityActionCount: 2,
			}),
		).toBe(true);
	});

	it("is true when deployment rows are present even with an empty summary", () => {
		expect(
			briefHasDisplayableContent({
				executiveSummary: "",
				priorityActionCount: 0,
				deploymentCount: 1,
			}),
		).toBe(true);
	});
});

describe("eager rejection handling (workflow scheduling slice)", () => {
	it("a fast releases rejection is captured, never an unhandled rejection", async () => {
		let unhandled = false;
		const onUnhandled = () => {
			unhandled = true;
		};
		process.on("unhandledRejection", onUnhandled);

		// Mirror the workflow: attach the settle handler EAGERLY at creation, then
		// await a slow "core fan-out" before resolving deployments.
		const releasesSettled = Promise.reject(new Error("boom")).then(
			(value) => ({ ok: true as const, value }),
			(reason) => ({ ok: false as const, reason }),
		);
		await new Promise((res) => setTimeout(res, 10)); // slow core
		const applied = applyDeploymentsResult(await releasesSettled);

		process.off("unhandledRejection", onUnhandled);
		expect(unhandled).toBe(false);
		expect(applied.deploymentsRan).toBe(false);
		expect(applied.deploymentsError).toMatch(/boom/);
	});
});

const anchor = {
	occurredAt: new Date("2026-06-05T10:00:00Z"),
	title: "v1.3.6",
	repoFullName: "o/r",
	tagName: "v1.3.6",
	url: "https://github.com/o/r/releases/tag/v1.3.6",
};
const anchor2 = {
	occurredAt: new Date("2026-06-04T10:00:00Z"),
	title: "v2.0.0",
	repoFullName: "o/r2",
	tagName: "v2.0.0",
	url: "https://github.com/o/r2/releases/tag/v2.0.0",
};
const emptySummaryContent = {
	schemaVersion: 2 as const,
	executiveSummary: "",
	priorityActions: [],
	sections: {},
};

describe("applyDeploymentsResult latestProdRelease passthrough", () => {
	it("passes latestRelease through on ok", () => {
		const out = applyDeploymentsResult({
			ok: true,
			value: { items: [], failures: [], latestRelease: anchor },
		});
		expect(out.latestProdRelease).toEqual(anchor);
	});
	it("omits it on reject", () => {
		expect(
			applyDeploymentsResult({ ok: false, reason: "x" })
				.latestProdRelease,
		).toBeUndefined();
	});
	it("passes latestReleasesByRepo through to latestProdReleasesByRepo", () => {
		const out = applyDeploymentsResult({
			ok: true,
			value: {
				items: [],
				failures: [],
				latestRelease: anchor,
				latestReleasesByRepo: [anchor, anchor2],
			},
		});
		expect(out.latestProdReleasesByRepo).toEqual([anchor, anchor2]);
	});
	it("omits latestProdReleasesByRepo for legacy results (single field only)", () => {
		const out = applyDeploymentsResult({
			ok: true,
			value: { items: [], failures: [], latestRelease: anchor },
		});
		expect(out.latestProdReleasesByRepo).toBeUndefined();
		expect(out.latestProdRelease).toEqual(anchor); // single still works
	});
	it("orders section-level (*) truncation notes before per-repo errors", () => {
		const out = applyDeploymentsResult({
			ok: true,
			value: {
				items: [],
				failures: [
					{ repoFullName: "o/r", reason: "down" },
					{
						repoFullName: "*",
						reason: "Deployments list truncated to 50 most recent",
					},
				],
			},
		});
		expect(out.deploymentsError).toBe(
			"Deployments list truncated to 50 most recent; o/r: down",
		);
	});
});

describe("assembleFinalBrief — v5 OFF (legacy parity)", () => {
	it("ignores latestProdRelease and matches legacy EMPTY", () => {
		const { status, content } = assembleFinalBrief({
			anchorV5: false,
			summaryContent: emptySummaryContent,
			latestProdRelease: anchor,
		});
		expect(status).toBe("EMPTY");
		expect(content).not.toHaveProperty("latestProdRelease");
		expect(content.executiveSummary).toBe("");
	});
});

describe("assembleFinalBrief — v5 ON", () => {
	it("writes the deterministic anchor summary on a truly-quiet brief", () => {
		const { status, content } = assembleFinalBrief({
			anchorV5: true,
			summaryContent: emptySummaryContent,
			latestProdRelease: anchor,
		});
		expect(status).toBe("READY");
		expect(content.latestProdRelease).toEqual(anchor);
		expect(content.executiveSummary).toBe(
			`${PROD_ANCHOR_SUMMARY} Latest production release: v1.3.6 (o/r).`,
		);
	});

	it("writes latestProdReleasesByRepo into content (v5 ON)", () => {
		const { content } = assembleFinalBrief({
			anchorV5: true,
			summaryContent: emptySummaryContent,
			latestProdRelease: anchor,
			latestProdReleasesByRepo: [anchor, anchor2],
		});
		expect(content.latestProdReleasesByRepo).toEqual([anchor, anchor2]);
		// EMPTY-gate unchanged: single field still drives READY when summary empty.
		expect(content.latestProdRelease).toEqual(anchor);
	});

	// Table-driven false-EMPTY/false-quiet guard over EVERY signal.
	it.each([
		[
			"priorityActions",
			{
				...emptySummaryContent,
				priorityActions: [{ kind: "blocker" } as never],
			},
		],
		[
			"github",
			{ ...emptySummaryContent, sections: { github: [{} as never] } },
		],
		[
			"storyChanges",
			{
				...emptySummaryContent,
				sections: { storyChanges: [{} as never] },
			},
		],
		[
			"taskChanges",
			{
				...emptySummaryContent,
				sections: { taskChanges: [{} as never] },
			},
		],
		[
			"documents",
			{ ...emptySummaryContent, sections: { documents: [{} as never] } },
		],
		[
			"meetings",
			{ ...emptySummaryContent, sections: { meetings: [{} as never] } },
		],
		[
			"teamsProposals",
			{
				...emptySummaryContent,
				sections: { teamsProposals: [{} as never] },
			},
		],
		[
			"deployments",
			{
				...emptySummaryContent,
				sections: { deployments: [{} as never] },
			},
		],
		["storylines", { ...emptySummaryContent, storylines: [{} as never] }],
		["ahead", { ...emptySummaryContent, ahead: [{} as never] }],
		[
			"partialFailures",
			{
				...emptySummaryContent,
				partialFailures: [
					{ source: "github", reason: "boom" } as never,
				],
			},
		],
	])(
		"does NOT write the quiet line and stays READY when %s present",
		(_label, summaryContent) => {
			const { status, content } = assembleFinalBrief({
				anchorV5: true,
				summaryContent: summaryContent as never,
				latestProdRelease: anchor,
			});
			expect(status).toBe("READY");
			expect(content.executiveSummary).toBe(""); // never the quiet line
		},
	);

	it("stays READY without the quiet line when deploymentsError present", () => {
		const { status, content } = assembleFinalBrief({
			anchorV5: true,
			summaryContent: emptySummaryContent,
			latestProdRelease: anchor,
			deploymentsError: "o/r: boom",
		});
		expect(status).toBe("READY");
		expect(content.executiveSummary).toBe("");
		expect(content.deploymentsError).toBe("o/r: boom");
	});

	it("stays READY without the quiet line when releaseNotesSummary present", () => {
		const { status, content } = assembleFinalBrief({
			anchorV5: true,
			summaryContent: emptySummaryContent,
			latestProdRelease: anchor,
			releaseNotesSummary: { prod: "shipped" },
		});
		expect(status).toBe("READY");
		expect(content.executiveSummary).toBe("");
		expect(content.releaseNotesSummary).toEqual({ prod: "shipped" });
	});

	it("EMPTY when no signal and no anchor", () => {
		expect(
			assembleFinalBrief({
				anchorV5: true,
				summaryContent: emptySummaryContent,
			}).status,
		).toBe("EMPTY");
	});

	it("never overwrites a non-empty LLM summary", () => {
		const { content } = assembleFinalBrief({
			anchorV5: true,
			summaryContent: {
				...emptySummaryContent,
				executiveSummary: "real summary",
			},
			latestProdRelease: anchor,
		});
		expect(content.executiveSummary).toBe("real summary");
	});
});
