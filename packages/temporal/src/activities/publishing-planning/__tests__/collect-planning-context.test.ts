import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Planning & Analysis context collection (Fizzy #1851, Phase 2A-2).
 *
 * The security-relevant half of this slice. DV17 says the page must not show a
 * viewer source context they cannot access, and the guarantee this module makes
 * is narrow and testable: it reads ONLY the rows the topic's own `provenance`
 * names, all of them project-scoped, all of them already visible to anyone who
 * can see the topic.
 */

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findMany: vi.fn() },
		projectDocument: { findMany: vi.fn() },
		projectMeetingTranscript: { findMany: vi.fn() },
	},
	getProjectReposForCodeSearch: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../daily-brief/resolve-repo-auth", () => ({
	resolveRepoAuth: vi.fn(),
}));

import { db, getProjectReposForCodeSearch } from "@repo/database";
import { resolveRepoAuth } from "../../daily-brief/resolve-repo-auth";
import {
	collectPlanningContext,
	SOURCE_ID_CAP,
} from "../collect-planning-context";

const storyFindMany = vi.mocked(db.userStory.findMany);
const docFindMany = vi.mocked(db.projectDocument.findMany);
const transcriptFindMany = vi.mocked(db.projectMeetingTranscript.findMany);
const reposMock = vi.mocked(getProjectReposForCodeSearch);
const authMock = vi.mocked(resolveRepoAuth);

/**
 * The `where` a mocked `findMany` was called with, as the loose shape these
 * assertions need. Prisma's generated filter types model `id` as
 * `string | StringFilter`, so reading `.in` off it does not typecheck — and the
 * point of every assertion below is precisely that the query was bounded by an
 * `in` list.
 */
const whereOf = (mock: { mock: { calls: unknown[][] } }) =>
	(
		mock.mock.calls[0]?.[0] as {
			where: { id?: { in?: string[] }; projectId?: string };
		}
	).where;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const PROVENANCE = {
	storyIds: ["story-1"],
	docIds: ["doc-1"],
	transcriptIds: ["tr-1"],
	repoPrs: [{ repoFullName: "example-org/example-repo", prNumber: 12 }],
};

const okPr = (body: string) => ({
	ok: true,
	status: 200,
	json: async () => ({ number: 12, title: "Bound the retry window", body }),
});

beforeEach(() => {
	vi.clearAllMocks();
	storyFindMany.mockResolvedValue([
		{ id: "story-1", identifier: "F-100", title: "Bound retries" },
	] as never);
	docFindMany.mockResolvedValue([
		{ id: "doc-1", title: "Retry design note", content: "why we bounded" },
	] as never);
	transcriptFindMany.mockResolvedValue([
		{ id: "tr-1", summary: "Agreed to bound retries" },
	] as never);
	reposMock.mockResolvedValue([
		{ repositoryUrl: "https://github.com/example-org/example-repo" },
	] as never);
	authMock.mockResolvedValue({ kind: "github", token: "t" } as never);
	fetchMock.mockResolvedValue(okPr("The retry budget is now per execution."));
});

const collect = (overrides: Record<string, unknown> = {}) =>
	collectPlanningContext({
		projectId: "proj-1",
		organizationId: "org-1",
		userId: "user-1",
		topicId: "topic-1",
		provenance: PROVENANCE,
		...overrides,
	});

describe("collectPlanningContext — what it reads", () => {
	it("resolves exactly the rows provenance names", async () => {
		const { context } = await collect();

		expect(context.stories.map((s) => s.id)).toEqual(["story-1"]);
		expect(context.documents.map((d) => d.id)).toEqual(["doc-1"]);
		expect(context.transcripts.map((t) => t.id)).toEqual(["tr-1"]);
	});

	it("never widens beyond the named ids — the DV17 guarantee", async () => {
		// NEGATIVE CONTROL. Asserting only that the named rows are present would
		// pass against an implementation that sends the whole project; what has to
		// be true is that the QUERY was bounded by the ids, so a sibling story in
		// the same project can never be reached.
		await collect();

		const where = whereOf(storyFindMany);
		expect(where.id).toEqual({ in: ["story-1"] });
		expect(where.projectId).toBe("proj-1");
	});

	it("scopes every read by projectId as well as by id", async () => {
		// A provenance id is server-written, but it is still an id: re-scoping by
		// project is what makes a corrupted or hand-edited provenance blob unable
		// to reach another tenant's rows.
		await collect();

		for (const call of [
			storyFindMany.mock.calls[0],
			docFindMany.mock.calls[0],
			transcriptFindMany.mock.calls[0],
		]) {
			expect(call?.[0]?.where?.projectId).toBe("proj-1");
		}
	});

	it("reads nothing at all for a manual topic", async () => {
		// provenance is null for an origin: MANUAL topic. A thin analysis is the
		// correct output — the prompt says to mark weak evidence as weak — but it
		// must not be an error, and it must not fall back to a project-wide read.
		const { context, sourceRefs } = await collect({ provenance: null });

		expect(storyFindMany).not.toHaveBeenCalled();
		expect(context.stories).toEqual([]);
		expect(sourceRefs.stories).toEqual([]);
	});

	it("tolerates a malformed provenance blob", async () => {
		// `provenance` is a Json column. Nothing at the type level stops it holding
		// a string, a number, or arrays of the wrong shape, and a throw here would
		// fail a run over a field the user never touched.
		const { context } = await collect({
			provenance: { storyIds: "not-an-array", repoPrs: [null, 7] },
		});

		expect(context.stories).toEqual([]);
		expect(context.repoPrs).toEqual([]);
	});
});

describe("collectPlanningContext — bounds", () => {
	it("caps how many ids of one kind it will read", async () => {
		// `provenance` is written from the 1A model's output, and the schema that
		// validates it bounds neither the array length nor the strings inside it.
		// Every item the prompt renders is truncated, but the COUNT was not, so a
		// model that emitted three hundred story ids would assemble a prompt large
		// enough to overflow the context window and fail the run.
		const ids = Array.from({ length: 60 }, (_, i) => `story-${i}`);

		const { sourceRefs } = await collect({ provenance: { storyIds: ids } });

		const where = whereOf(storyFindMany);
		expect(where.id?.in).toHaveLength(SOURCE_ID_CAP);
		// And the cap is VISIBLE. A silently shortened read is the shape of every
		// collector bug in this repo worth remembering: the output is thin, the
		// run is green, and nothing says why.
		expect(sourceRefs.failures.stories).toMatch(/60/);
	});

	it("records no cap when the ids fit", async () => {
		const { sourceRefs } = await collect();
		expect(sourceRefs.failures.stories).toBeUndefined();
	});
});

describe("collectPlanningContext — pull requests", () => {
	it("fetches the body of each PR provenance names", async () => {
		const { context } = await collect();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/repos/example-org/example-repo/pulls/12",
		);
		expect(context.repoPrs[0]?.body).toContain("per execution");
	});

	it("keeps the coordinate when the body cannot be fetched", async () => {
		// Degrade, never fail. The whole objection to putting GitHub on a button
		// press is that a rate limit or an expired credential would fail the run;
		// the coordinate is still a citable reference without its body.
		fetchMock.mockResolvedValue({ ok: false, status: 403 });

		const { context, sourceRefs } = await collect();

		expect(context.repoPrs).toHaveLength(1);
		expect(context.repoPrs[0]?.body).toBeNull();
		expect(sourceRefs.failures.pullRequests).toBeDefined();
	});

	it("survives a thrown fetch", async () => {
		fetchMock.mockRejectedValue(new Error("socket hang up"));

		const { context, sourceRefs } = await collect();

		expect(context.repoPrs).toHaveLength(1);
		expect(sourceRefs.failures.pullRequests).toMatch(/socket hang up/);
	});

	it("distinguishes 'no repositories' from 'repositories unavailable'", async () => {
		// getProjectReposForCodeSearch returns [] when a project's credentials have
		// EXPIRED, which reads identically to "this project has no repositories".
		// Collectors have already gone silently blind on exactly this, so the two
		// are recorded apart: a thin analysis can then be explained rather than
		// guessed at.
		reposMock.mockResolvedValue([] as never);

		const { sourceRefs } = await collect();

		expect(sourceRefs.activeRepoCount).toBe(0);
		expect(sourceRefs.failures.pullRequests).toMatch(/no active repo/i);
	});

	it("caps how many PR bodies it will fetch", async () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			repoFullName: "example-org/example-repo",
			prNumber: i + 1,
		}));

		const { context } = await collect({
			provenance: { repoPrs: many },
		});

		// Every coordinate is still passed to the model as a reference; only the
		// number of BODIES fetched is bounded.
		expect(context.repoPrs).toHaveLength(40);
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
	});

	it("does not call GitHub at all when provenance names no PRs", async () => {
		await collect({ provenance: { storyIds: ["story-1"] } });

		expect(reposMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("collectPlanningContext — sourceRefs", () => {
	it("records what resolved, so a thin analysis can be explained", async () => {
		const { sourceRefs } = await collect();

		expect(sourceRefs.stories).toEqual(["story-1"]);
		expect(sourceRefs.documents).toEqual(["doc-1"]);
		expect(sourceRefs.transcripts).toEqual(["tr-1"]);
		expect(sourceRefs.prBodiesFetched).toBe(1);
	});

	it("records a provenance id that resolved to nothing", async () => {
		// A story deleted after the topic was suggested. The analysis is thinner
		// than its provenance implies, and that difference is exactly what a
		// reader would otherwise have no way to see.
		storyFindMany.mockResolvedValue([] as never);

		const { sourceRefs } = await collect();

		expect(sourceRefs.stories).toEqual([]);
		expect(sourceRefs.unresolved.storyIds).toEqual(["story-1"]);
	});

	it("carries no failures on a clean run", async () => {
		const { sourceRefs } = await collect();
		expect(sourceRefs.failures).toEqual({});
	});
});
