import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findUnique: vi.fn(),
	createNotification: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	// Spread the real barrel and override only `db`. Replacing the module
	// wholesale drops the enums and transitive exports the rest of the API
	// module graph imports — in a shared worker that starves unrelated suites
	// until they time out, which is exactly what it did on first submission.
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		db: {
			projectMember: { findFirst: mocks.findFirst },
			organization: { findUnique: mocks.findUnique },
		},
	};
});
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../../../../lib/notification-service", () => ({
	createNotification: mocks.createNotification,
}));

const { isActiveProjectMember, notifyDecisionOwner } = await import(
	"../decision-owner"
);

const decision = {
	id: "d-1",
	projectId: "p-1",
	identifier: "ADR-001",
	title: "Adopt X",
	ownerUserId: "u-owner",
	currentVersion: 3,
};

beforeEach(() => {
	mocks.findFirst.mockReset();
	mocks.findUnique.mockReset();
	mocks.createNotification.mockReset();
	mocks.findUnique.mockResolvedValue(null);
});

describe("isActiveProjectMember", () => {
	it("requires an accepted, unexpired membership row", async () => {
		mocks.findFirst.mockResolvedValue({ id: "pm-1" });
		await expect(isActiveProjectMember("p-1", "u-1")).resolves.toBe(true);
		const where = mocks.findFirst.mock.calls[0][0].where;
		expect(where.acceptedAt).toEqual({ not: null });
		expect(where.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);
	});

	it("treats a pending invitation or expired guest as a non-member", async () => {
		mocks.findFirst.mockResolvedValue(null);
		await expect(isActiveProjectMember("p-1", "u-1")).resolves.toBe(false);
	});
});

describe("notifyDecisionOwner", () => {
	it("dedupes per (decision, owner) so repeated saves do not re-notify", async () => {
		await notifyDecisionOwner(
			decision,
			{ id: "u-actor", name: "Actor" },
			undefined,
			true,
		);
		const args = mocks.createNotification.mock.calls[0][0];
		expect(args.dedupeKey).toBe("decision-owner:d-1:u-owner");
		expect(args.dedupeKey).not.toContain("3");
	});

	it("never notifies the actor about their own edit", async () => {
		await notifyDecisionOwner(
			{ ...decision, ownerUserId: "u-actor" },
			{ id: "u-actor" },
			undefined,
			true,
		);
		expect(mocks.createNotification).not.toHaveBeenCalled();
	});
});
