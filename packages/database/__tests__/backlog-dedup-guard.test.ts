/**
 * Unit tests for the title-collision dedup guard.
 *
 * The helper lives in `@repo/database` so the AI Update sidebar
 * (`applyBacklogChanges`), the Teams + Slack channel-monitor approve
 * procedures, and the `fabric_create_story` agent tool can all share it.
 * These tests pin its observable behaviour — the same 11 cases ran in PR
 * #1232 against an api-package version of the same helper before it moved
 * into `@repo/database`.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/backlog-dedup-guard.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_DRAFTING_STAGES } from "../utils";

const { findManyMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
}));

// The helper resolves its `db` import to `../../client` from its position
// at `prisma/queries/projects/`. From this test's location at
// `__tests__/`, that same module is reachable at `../prisma/client`.
vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findMany: findManyMock },
	},
}));

// `normalizeBacklogTitle` is a pure helper at `packages/database/utils.ts`.
// Importing the real one keeps these tests exercising the canonical
// normalization rules — no parallel implementation to drift.

const { buildBacklogDedupGuard, inferDedupFamily } = await import(
	"../prisma/queries/projects/backlog-dedup-guard"
);

beforeEach(() => {
	findManyMock.mockReset();
});

// ---------------------------------------------------------------------------
// inferDedupFamily — pure logic, no DB
// ---------------------------------------------------------------------------

describe("inferDedupFamily", () => {
	it("returns BUG when the caller-supplied kindOverride is BUG", () => {
		expect(inferDedupFamily({ kindOverride: "BUG", type: "feature" })).toBe(
			"BUG",
		);
	});

	it("returns BUG when the analyzer-supplied type is 'bug' and no override", () => {
		expect(inferDedupFamily({ type: "bug" })).toBe("BUG");
	});

	it("returns FEATURE when kindOverride is FEATURE, regardless of type", () => {
		expect(inferDedupFamily({ kindOverride: "FEATURE", type: "bug" })).toBe(
			"FEATURE",
		);
	});

	it("returns FEATURE for the default feature/story case", () => {
		expect(inferDedupFamily({ type: "feature" })).toBe("FEATURE");
		expect(inferDedupFamily({ type: "story" })).toBe("FEATURE");
		expect(inferDedupFamily({ type: "epic" })).toBe("FEATURE");
	});
});

// ---------------------------------------------------------------------------
// buildBacklogDedupGuard — index construction + lookup behavior
// ---------------------------------------------------------------------------

describe("buildBacklogDedupGuard", () => {
	it("issues one indexed `findMany` per build, excludes terminal rows, and selects only the dedup-relevant columns", async () => {
		findManyMock.mockResolvedValue([]);
		await buildBacklogDedupGuard("proj-1");
		expect(findManyMock).toHaveBeenCalledTimes(1);
		// Terminal (closed / declined / auto-hidden) rows are excluded from the
		// dedup index: a resolved, immutable record must not block a fresh create
		// that shares its title.
		expect(findManyMock).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
			},
			select: {
				id: true,
				identifier: true,
				title: true,
				kind: true,
			},
		});
	});

	it("returns no collision on an empty project", async () => {
		findManyMock.mockResolvedValue([]);
		const guard = await buildBacklogDedupGuard("proj-1");
		expect(guard.findCollision("FEATURE", "Anything")).toBeNull();
		expect(guard.findCollision("BUG", "Anything")).toBeNull();
	});

	it("finds an existing FEATURE on a case-insensitive normalized-title match", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "story-1",
				identifier: "12",
				title: "Add Login Button",
				kind: "FEATURE",
			},
		]);
		const guard = await buildBacklogDedupGuard("proj-1");
		const hit = guard.findCollision("FEATURE", "  add LOGIN button  ");
		expect(hit).toEqual({
			existingIdentifier: "12",
			existingId: "story-1",
		});
	});

	it("normalizes a legacy '[BUG] ' prefix so prefixed + unprefixed bug titles collide", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "bug-1",
				identifier: "B-007",
				title: "[BUG] Login crashes",
				kind: "BUG",
			},
		]);
		const guard = await buildBacklogDedupGuard("proj-1");
		expect(guard.findCollision("BUG", "Login crashes")).toEqual({
			existingIdentifier: "B-007",
			existingId: "bug-1",
		});
	});

	it("a FEATURE row stays in the FEATURE family (cross-kind: bug != feature)", async () => {
		// (User Story was retired; legacy USER_STORY rows were migrated to
		// FEATURE, so the guard only ever sees FEATURE or BUG kinds now.)
		findManyMock.mockResolvedValue([
			{
				id: "us-1",
				identifier: "13",
				title: "Refactor checkout",
				kind: "FEATURE",
			},
		]);
		const guard = await buildBacklogDedupGuard("proj-1");
		expect(guard.findCollision("FEATURE", "Refactor checkout")).toEqual({
			existingIdentifier: "13",
			existingId: "us-1",
		});
		expect(guard.findCollision("BUG", "Refactor checkout")).toBeNull();
	});

	it("does NOT cross BUG ↔ FEATURE: same title in opposite kind is not a collision", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "story-1",
				identifier: "12",
				title: "Mobile menu broken",
				kind: "FEATURE",
			},
		]);
		const guard = await buildBacklogDedupGuard("proj-1");
		expect(guard.findCollision("BUG", "Mobile menu broken")).toBeNull();
		expect(
			guard.findCollision("FEATURE", "Mobile menu broken"),
		).not.toBeNull();
	});

	it("recordCreated catches same-batch duplicates on a subsequent findCollision", async () => {
		findManyMock.mockResolvedValue([]);
		const guard = await buildBacklogDedupGuard("proj-1");
		expect(guard.findCollision("FEATURE", "Fresh idea")).toBeNull();
		guard.recordCreated("FEATURE", "Fresh idea", {
			id: "story-1",
			identifier: "14",
		});
		expect(guard.findCollision("FEATURE", "Fresh idea")).toEqual({
			existingIdentifier: "14",
			existingId: "story-1",
		});
		expect(guard.findCollision("BUG", "Fresh idea")).toBeNull();
	});
});
