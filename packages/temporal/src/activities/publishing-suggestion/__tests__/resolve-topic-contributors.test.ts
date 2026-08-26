import { describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so resolveTopicContributors's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// collect-stories.test.ts / fetch-ado-states-heartbeat.test.ts). `log.warn` is
// stubbed via a hoisted spy so the degrade path's observability is assertable.
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
	log: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async (orig) => {
	const actual = await orig<typeof import("@repo/database")>();
	return { ...actual, resolveProjectContributorIds: vi.fn() };
});

import { resolveProjectContributorIds } from "@repo/database";
import { resolveTopicContributors } from "../resolve-topic-contributors";

const tenant = { projectId: "p1", organizationId: null, userId: "owner" };
const base = {
	title: "t",
	pitch: "p",
	dedupeKey: "d",
	provenance: { storyIds: ["s1"] },
	suggestedPostTypes: [],
	contributorUserIds: [],
	relevantFunctionTags: [],
	postTypeRecommendations: [],
};

describe("resolveTopicContributors", () => {
	it("fills contributorUserIds from the DB helper", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue(["u1", "u2"]);
		const out = await resolveTopicContributors({ tenant, topics: [base] });
		expect(out.topics[0].contributorUserIds).toEqual(["u1", "u2"]);
	});

	it("degrades to [] when the helper throws (never fails the cycle) and logs a warning", async () => {
		logWarn.mockClear();
		(resolveProjectContributorIds as any).mockRejectedValue(
			new Error("db down"),
		);
		const out = await resolveTopicContributors({ tenant, topics: [base] });
		expect(out.topics[0].contributorUserIds).toEqual([]);
		// Observability: the silent degrade is now logged (never swallowed).
		expect(logWarn).toHaveBeenCalledTimes(1);
	});

	it("resolves each topic independently — one topic's failure doesn't affect another's success", async () => {
		const ok = {
			...base,
			dedupeKey: "ok",
			provenance: { storyIds: ["s1"] },
		};
		const bad = {
			...base,
			dedupeKey: "bad",
			provenance: { storyIds: ["s2"] },
		};
		(resolveProjectContributorIds as any).mockImplementation(
			async (_projectId: string, provenance: { storyIds?: string[] }) => {
				if (provenance.storyIds?.[0] === "s1") {
					return ["u1"];
				}
				throw new Error("db down");
			},
		);
		const out = await resolveTopicContributors({
			tenant,
			topics: [ok, bad],
		});
		expect(out.topics[0].contributorUserIds).toEqual(["u1"]);
		expect(out.topics[1].contributorUserIds).toEqual([]);
	});

	it("passes an empty provenance through without throwing", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue([]);
		const noProv = { ...base, provenance: {} };
		const out = await resolveTopicContributors({
			tenant,
			topics: [noProv],
		});
		expect(out.topics[0].contributorUserIds).toEqual([]);
	});

	it("resolves PR authors from repoPrs via the passed map and forwards their github ids", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue(["u-pr"]);
		const topic = {
			...base,
			provenance: { repoPrs: [{ repoFullName: "o/r", prNumber: 1 }] },
		};
		const out = await resolveTopicContributors({
			tenant,
			topics: [topic],
			prAuthorGithubIdByPr: { "o/r#1": "12345" },
		});
		expect(out.topics[0].contributorUserIds).toEqual(["u-pr"]);
		expect(resolveProjectContributorIds).toHaveBeenCalledWith("p1", {
			storyIds: undefined,
			docIds: undefined,
			githubAuthorIds: ["12345"],
		});
	});

	it("omits a repoPr that has no map entry (no throw, deduped)", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue([]);
		const topic = {
			...base,
			provenance: {
				repoPrs: [
					{ repoFullName: "o/r", prNumber: 1 },
					{ repoFullName: "o/r", prNumber: 1 }, // duplicate → deduped
					{ repoFullName: "o/r", prNumber: 9 }, // no map entry → dropped
				],
			},
		};
		await resolveTopicContributors({
			tenant,
			topics: [topic],
			prAuthorGithubIdByPr: { "o/r#1": "12345" },
		});
		expect(resolveProjectContributorIds).toHaveBeenCalledWith("p1", {
			storyIds: undefined,
			docIds: undefined,
			githubAuthorIds: ["12345"],
		});
	});

	it("FR-A4: malformed repoPrs (non-array / null / non-object entries) never throws — story/doc contributors preserved", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue(["u1"]);
		// A naive `(prov.repoPrs ?? []).map(pr => `${pr.repoFullName}#...`)` would
		// throw on `null` / a non-object here, hit the activity's outer catch, and
		// return `[]` — ERASING the story contributor. This asserts the hardened
		// path: malformed repoPrs contribute no github ids, story/doc still resolve.
		const topic = {
			...base,
			provenance: { storyIds: ["s1"], repoPrs: [null, {}, 5] },
		};
		const out = await resolveTopicContributors({
			tenant,
			topics: [topic as any],
			prAuthorGithubIdByPr: { "o/r#1": "12345" },
		});
		expect(resolveProjectContributorIds).toHaveBeenCalledWith("p1", {
			storyIds: ["s1"],
			docIds: undefined,
			githubAuthorIds: [],
		});
		expect(out.topics[0].contributorUserIds).toEqual(["u1"]);
	});

	it("carries angle through on the normal path (FR9/10)", async () => {
		(resolveProjectContributorIds as any).mockResolvedValue(["u1"]);
		const out = await resolveTopicContributors({
			tenant,
			topics: [{ ...base, angle: "Exec summary" }],
		});
		expect(out.topics[0].angle).toBe("Exec summary");
	});

	it("carries angle through on the degrade path (FR9/10)", async () => {
		(resolveProjectContributorIds as any).mockRejectedValue(
			new Error("db down"),
		);
		const out = await resolveTopicContributors({
			tenant,
			topics: [{ ...base, angle: "Exec summary" }],
		});
		expect(out.topics[0].angle).toBe("Exec summary");
		expect(out.topics[0].contributorUserIds).toEqual([]);
	});
});
