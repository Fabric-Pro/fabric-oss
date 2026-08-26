import { describe, expect, it, vi } from "vitest";
import { FunctionTagSchema } from "../../../zod";
import {
	applyGlobalDefaultFunctionTags,
	joinRosterFunctionTags,
	sameTagSet,
	tagRowUpdate,
} from "../function-tags";

describe("FunctionTagSchema", () => {
	it("accepts every predefined value", () => {
		for (const v of [
			"PRODUCT_OWNER",
			"PRODUCT_CONTRIBUTOR",
			"DEVELOPER",
			"ARCHITECT",
			"SDET_QA",
			"SME",
			"STAKEHOLDER",
		]) {
			expect(FunctionTagSchema.parse(v)).toBe(v);
		}
	});
	it("rejects free-text / unknown values", () => {
		expect(() => FunctionTagSchema.parse("MANAGER")).toThrow();
		expect(() => FunctionTagSchema.parse("developer")).toThrow();
	});
});

function makeTx(opts: {
	project: { organizationId: string | null; userId: string } | null;
	userDefault: string[];
	existingRow: { id: string } | null;
}) {
	return {
		project: { findUnique: vi.fn().mockResolvedValue(opts.project) },
		user: {
			findUnique: vi
				.fn()
				.mockResolvedValue({ defaultFunctionTags: opts.userDefault }),
		},
		projectUserFunctionTag: {
			findUnique: vi.fn().mockResolvedValue(opts.existingRow),
			upsert: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
		},
	} as any;
}

describe("applyGlobalDefaultFunctionTags", () => {
	const project = { organizationId: "org1", userId: "owner1" };

	it("no-ops when the global default is empty and no row exists", async () => {
		const tx = makeTx({ project, userDefault: [], existingRow: null });
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "u1",
		});
		expect(tx.projectUserFunctionTag.upsert).not.toHaveBeenCalled();
		expect(tx.projectUserFunctionTag.update).not.toHaveBeenCalled();
	});

	it("upserts the default tags when non-empty, org derived from project", async () => {
		const tx = makeTx({
			project,
			userDefault: ["DEVELOPER"],
			existingRow: null,
		});
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "u1",
		});
		expect(tx.projectUserFunctionTag.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId_userId: { projectId: "p1", userId: "u1" } },
				create: expect.objectContaining({
					organizationId: "org1",
					tags: ["DEVELOPER"],
				}),
				update: expect.objectContaining({
					organizationId: "org1",
					tags: ["DEVELOPER"],
				}),
			}),
		);
		// `expect.objectContaining` is satisfied by an ADDED key, so the
		// assertion above cannot see a `confirmedAt` appearing on the create.
		// A joining member's first row must be born unconfirmed at version 0:
		// copying an account default is not the member agreeing to it, and the
		// trigger is BEFORE UPDATE, so nothing downstream would correct it.
		const call = tx.projectUserFunctionTag.upsert.mock.calls[0][0];
		expect(call.create).not.toHaveProperty("confirmedAt");
		expect(call.create).not.toHaveProperty("confirmationVersion");
	});

	it("clears an existing row's tags when the current default is empty", async () => {
		const tx = makeTx({
			project,
			userDefault: [],
			existingRow: { id: "row1" },
		});
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "u1",
		});
		expect(tx.projectUserFunctionTag.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					tags: [],
					confirmedAt: null,
					confirmationVersion: { increment: 1 },
				}),
			}),
		);
		expect(tx.projectUserFunctionTag.upsert).not.toHaveBeenCalled();
	});

	it("skips the project creator (deferred owner scope)", async () => {
		const tx = makeTx({
			project,
			userDefault: ["DEVELOPER"],
			existingRow: null,
		});
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "owner1",
		});
		expect(tx.projectUserFunctionTag.upsert).not.toHaveBeenCalled();
		expect(tx.projectUserFunctionTag.update).not.toHaveBeenCalled();
	});
});

describe("joinRosterFunctionTags", () => {
	it("excludes a removed member's stale tag row (roster is authoritative)", () => {
		const out = joinRosterFunctionTags(
			[{ userId: "owner" }, { userId: "alice" }],
			[
				{ userId: "alice", tags: ["DEVELOPER"] },
				{ userId: "ghost", tags: ["ARCHITECT"] }, // removed member, stale row
			],
		);
		expect(out.find((r) => r.userId === "ghost")).toBeUndefined();
		expect(out.find((r) => r.userId === "alice")?.tags).toEqual([
			"DEVELOPER",
		]);
	});

	it("returns one row per userId when the owner is double-listed (owner + self-invite)", () => {
		const out = joinRosterFunctionTags(
			[{ userId: "owner" }, { userId: "owner" }], // synthesized owner + accepted self-invite
			[{ userId: "owner", tags: ["PRODUCT_OWNER"] }],
		);
		expect(out.filter((r) => r.userId === "owner")).toHaveLength(1);
	});

	it("gives an untagged roster member an empty tag list", () => {
		const out = joinRosterFunctionTags([{ userId: "bob" }], []);
		expect(out).toEqual([{ userId: "bob", tags: [] }]);
	});
});

describe("sameTagSet", () => {
	it("ignores order and duplicates", () => {
		expect(sameTagSet(["DEVELOPER", "SME"], ["SME", "DEVELOPER"])).toBe(
			true,
		);
		expect(
			sameTagSet(["DEVELOPER", "SME"], ["SME", "DEVELOPER", "DEVELOPER"]),
		).toBe(true);
	});
	it("distinguishes different sets", () => {
		expect(sameTagSet(["DEVELOPER"], ["ARCHITECT"])).toBe(false);
		expect(sameTagSet(["DEVELOPER"], [])).toBe(false);
		expect(sameTagSet([], ["DEVELOPER"])).toBe(false);
	});
	it("treats two empty sets as the same", () => {
		// An admin re-saving an already-empty assignment is a no-op, not a
		// clear — it must not re-prompt a member who has nothing to confirm.
		expect(sameTagSet([], [])).toBe(true);
	});
});

describe("tagRowUpdate choke point", () => {
	it("adds the increment to every update payload", () => {
		expect(tagRowUpdate({ tags: ["SME"] })).toEqual({
			tags: ["SME"],
			confirmationVersion: { increment: 1 },
		});
	});
	it("keeps an explicit null confirmedAt (clearing is a value, not an omission)", () => {
		expect(tagRowUpdate({ confirmedAt: null })).toEqual({
			confirmedAt: null,
			confirmationVersion: { increment: 1 },
		});
	});
	it("omits keys the caller omitted, so Prisma leaves those columns alone", () => {
		expect(Object.keys(tagRowUpdate({ tags: [] }))).toEqual([
			"tags",
			"confirmationVersion",
		]);
	});
});

describe("applyGlobalDefaultFunctionTags clears confirmation on BOTH branches", () => {
	it("has-defaults branch: upsert update carries confirmedAt null + the increment", async () => {
		const tx = makeTx({
			project: { organizationId: "org1", userId: "owner" },
			userDefault: ["DEVELOPER"],
			existingRow: { id: "row1" },
		});
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "u1",
		});
		const call = tx.projectUserFunctionTag.upsert.mock.calls[0][0];
		expect(call.update).toMatchObject({
			tags: ["DEVELOPER"],
			confirmedAt: null,
			confirmationVersion: { increment: 1 },
		});
	});

	it("EMPTY-defaults branch: the clear carries confirmedAt null + the increment", async () => {
		// This is the branch a "there is one upsert" reading misses. Skipping
		// it leaves a re-joining member with zero tags and a surviving
		// confirmedAt — permanently "confirmed" for a role they no longer
		// hold, and never re-prompted.
		const tx = makeTx({
			project: { organizationId: "org1", userId: "owner" },
			userDefault: [],
			existingRow: { id: "row1" },
		});
		await applyGlobalDefaultFunctionTags(tx, {
			projectId: "p1",
			userId: "u1",
		});
		const call = tx.projectUserFunctionTag.update.mock.calls[0][0];
		expect(call.data).toMatchObject({
			tags: [],
			confirmedAt: null,
			confirmationVersion: { increment: 1 },
		});
	});
});
