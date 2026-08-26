import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils/feature-flag", () => ({ isFunctionTagsEnabled: vi.fn() }));
vi.mock("@repo/database", async (orig) => {
	const actual = await orig<any>();
	return {
		...actual,
		hasProjectAccess: vi.fn(),
		getProjectMemberFunctionTags: vi.fn(),
	};
});

import { getProjectMemberFunctionTags, hasProjectAccess } from "@repo/database";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import {
	computeFunctionTagContext,
	getProjectFunctionTagClause,
} from "../function-tag-context";

const flag = vi.mocked(isFunctionTagsEnabled);
const access = vi.mocked(hasProjectAccess);
const roster = vi.mocked(getProjectMemberFunctionTags);

describe("computeFunctionTagContext", () => {
	it("returns null when no member is tagged", () => {
		expect(
			computeFunctionTagContext([{ userId: "a", tags: [] }]),
		).toBeNull();
	});
	it("counts per tag over tagged members, ordered, with requester lens", () => {
		const ctx = computeFunctionTagContext(
			[
				{ userId: "a", tags: ["DEVELOPER"] },
				{ userId: "b", tags: ["DEVELOPER", "ARCHITECT"] },
			],
			"b",
		);
		expect(ctx?.composition).toEqual([
			{ label: "Developer", count: 2 },
			{ label: "Architect", count: 1 },
		]);
		expect(ctx?.requesterLabels).toEqual(["Developer", "Architect"]);
	});
	it("merges tags across duplicate rows for the same userId (counts the user once)", () => {
		const ctx = computeFunctionTagContext(
			[
				{ userId: "a", tags: ["DEVELOPER"] },
				{ userId: "a", tags: ["ARCHITECT"] }, // duplicate userId — tags must merge, not drop
			],
			"a",
		);
		// The second row's ARCHITECT is merged into user "a" (not dropped), and
		// "a" is counted once per tag despite appearing in two rows.
		expect(ctx?.composition).toEqual([
			{ label: "Developer", count: 1 },
			{ label: "Architect", count: 1 },
		]);
		expect(ctx?.requesterLabels).toEqual(["Developer", "Architect"]);
	});
});

describe("getProjectFunctionTagClause", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns '' and reads no tags when the flag is OFF", async () => {
		flag.mockReturnValue(false);
		const out = await getProjectFunctionTagClause({
			projectId: "p",
			requesterUserId: "u",
			surface: "test",
		});
		expect(out).toBe("");
		expect(roster).not.toHaveBeenCalled();
	});

	it("returns '' when the requester lacks project access (no tag read)", async () => {
		flag.mockReturnValue(true);
		access.mockResolvedValue(false);
		const out = await getProjectFunctionTagClause({
			projectId: "p",
			requesterUserId: "u",
			surface: "test",
		});
		expect(out).toBe("");
		expect(roster).not.toHaveBeenCalled();
	});

	it("returns '' when no member is tagged", async () => {
		flag.mockReturnValue(true);
		access.mockResolvedValue(true);
		roster.mockResolvedValue([{ userId: "u", tags: [] }]);
		expect(
			await getProjectFunctionTagClause({
				projectId: "p",
				requesterUserId: "u",
				surface: "t",
			}),
		).toBe("");
	});

	it("fails open ('') when the resolver throws", async () => {
		flag.mockReturnValue(true);
		access.mockResolvedValue(true);
		roster.mockRejectedValue(new Error("db down"));
		expect(
			await getProjectFunctionTagClause({
				projectId: "p",
				requesterUserId: "u",
				surface: "t",
			}),
		).toBe("");
	});

	it("returns the clause on the happy path", async () => {
		flag.mockReturnValue(true);
		access.mockResolvedValue(true);
		roster.mockResolvedValue([{ userId: "u", tags: ["DEVELOPER"] }]);
		const out = await getProjectFunctionTagClause({
			projectId: "p",
			requesterUserId: "u",
			surface: "t",
		});
		expect(out).toContain("PROJECT CONTRIBUTOR ROLES");
		expect(out).toContain("1 × Developer");
	});
});
