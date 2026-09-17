/**
 * findSimilarTrajectory — the lookup must be tenant-scoped.
 *
 * `saveTrajectory` writes `organizationId` on every AgentTask row, but the
 * lookup keyed on `userId` alone, so a trajectory recorded inside one
 * organization (step inputs, tool arguments, outputs) could be replayed in
 * another organization or in the user's personal context whenever the task
 * text hashed the same.
 *
 * Run with: pnpm --filter @repo/temporal test -- find-similar-trajectory
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	findMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { agentTask: { findMany: dbMocks.findMany } },
}));

import { findSimilarTrajectory } from "../find-similar-trajectory";

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.findMany.mockResolvedValue([]);
});

describe("findSimilarTrajectory", () => {
	it("scopes the lookup to the organization when one is given", async () => {
		await findSimilarTrajectory({
			taskDescription: "Summarise open PRs",
			userId: "user-1",
			organizationId: "org-a",
		});

		expect(dbMocks.findMany).toHaveBeenCalledTimes(1);
		const { where } = dbMocks.findMany.mock.calls[0][0];
		expect(where).toEqual({
			userId: "user-1",
			organizationId: "org-a",
			agentId: "orchestrator",
			stage: "trajectory",
			status: "completed",
		});
	});

	it("requires organizationId to be null in personal context", async () => {
		await findSimilarTrajectory({
			taskDescription: "Summarise open PRs",
			userId: "user-1",
		});

		const { where } = dbMocks.findMany.mock.calls[0][0];
		expect(where.organizationId).toBeNull();
		expect(where.userId).toBe("user-1");
		// `organizationId: undefined` would make Prisma drop the condition and
		// span every tenant — assert the key is present with an explicit null.
		expect(Object.keys(where)).toContain("organizationId");
	});

	it("still returns the matching trajectory from the scoped rows", async () => {
		// sha256("summarise open prs") first 16 hex chars — computed the same
		// way the activity does, so the test does not depend on a literal.
		const { createHash } = await import("node:crypto");
		const taskHash = createHash("sha256")
			.update("summarise open prs")
			.digest("hex")
			.substring(0, 16);
		dbMocks.findMany.mockResolvedValue([
			{ result: { id: "traj-other", taskHash: "0000000000000000" } },
			{ result: { id: "traj-match", taskHash } },
		]);

		const trajectory = await findSimilarTrajectory({
			taskDescription: "  Summarise Open PRs ",
			userId: "user-1",
			organizationId: "org-a",
		});

		expect(trajectory?.id).toBe("traj-match");
	});
});
