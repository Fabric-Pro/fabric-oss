import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils/feature-flag", () => ({
	isFunctionTagsEnabled: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getProjectMemberFunctionTags: vi.fn(),
	membersHoldingTags: (
		roster: { userId: string; tags: string[] }[],
		tags: string[],
	) =>
		roster
			.filter((m) => m.tags.some((t) => tags.includes(t)))
			.map((m) => m.userId),
	db: {
		project: { findUnique: vi.fn() },
		projectMember: { findMany: vi.fn() },
	},
}));

import { db, getProjectMemberFunctionTags } from "@repo/database";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import {
	expandGroupMentionsByTag,
	narrowToCurrentProjectRoster,
} from "../group-mention";

const flag = vi.mocked(isFunctionTagsEnabled);
const roster = vi.mocked(getProjectMemberFunctionTags);

describe("expandGroupMentionsByTag", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns an empty map and reads no roster when the flag is OFF", async () => {
		flag.mockReturnValue(false);
		const out = await expandGroupMentionsByTag({
			projectId: "p",
			groupTags: ["DEVELOPER"],
		});
		expect(out.size).toBe(0);
		expect(roster).not.toHaveBeenCalled();
	});

	it("returns an empty map and reads no roster for no tags", async () => {
		flag.mockReturnValue(true);
		const out = await expandGroupMentionsByTag({
			projectId: "p",
			groupTags: [],
		});
		expect(out.size).toBe(0);
		expect(roster).not.toHaveBeenCalled();
	});

	it("maps each requested tag to its current holders, reading the roster ONCE", async () => {
		flag.mockReturnValue(true);
		roster.mockResolvedValue([
			{ userId: "a", tags: ["DEVELOPER"] },
			{ userId: "b", tags: ["SME"] },
			{ userId: "c", tags: ["DEVELOPER", "SME"] },
		]);
		const out = await expandGroupMentionsByTag({
			projectId: "p",
			groupTags: ["DEVELOPER", "SME"],
		});
		expect(out.get("DEVELOPER")).toEqual(["a", "c"]);
		expect(out.get("SME")).toEqual(["b", "c"]);
		// The whole point of the batch helper: one roster read for N tags.
		expect(roster).toHaveBeenCalledTimes(1);
	});

	it("fails open (empty map) when the roster read throws", async () => {
		flag.mockReturnValue(true);
		roster.mockRejectedValue(new Error("db down"));
		const out = await expandGroupMentionsByTag({
			projectId: "p",
			groupTags: ["DEVELOPER"],
		});
		expect(out.size).toBe(0);
	});
});

describe("narrowToCurrentProjectRoster", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps the owner and accepted, unexpired members; drops the rest", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			userId: "owner",
		} as never);
		vi.mocked(db.projectMember.findMany).mockResolvedValue([
			{ userId: "member" },
		] as never);
		const out = await narrowToCurrentProjectRoster(
			["owner", "member", "removed"],
			"p",
		);
		expect(out).toEqual(["owner", "member"]);
		// Guard the roster filter itself: only accepted, unexpired members of
		// THIS project may be reached (a regression dropping either clause is a
		// tenant-scoping leak, not a cosmetic change).
		const where = vi.mocked(db.projectMember.findMany).mock.calls[0][0]
			.where;
		expect(where.projectId).toBe("p");
		expect(where.userId).toEqual({ in: ["owner", "member", "removed"] });
		expect(where.acceptedAt).toEqual({ not: null });
		expect(where.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);
	});

	it("returns [] for empty input without querying", async () => {
		expect(await narrowToCurrentProjectRoster([], "p")).toEqual([]);
		expect(db.projectMember.findMany).not.toHaveBeenCalled();
	});
});
