import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
	},
}));

async function load() {
	const mod = await import("../effective-project-permissions");
	return mod.resolveEffectiveProjectPermissions;
}

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const OWNER_ID = "user-owner";
const USER_ID = "user-x";

beforeEach(() => {
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
});

describe("resolveEffectiveProjectPermissions", () => {
	it("returns null when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		const resolve = await load();
		expect(await resolve(PROJECT_ID, USER_ID)).toBeNull();
	});

	it("personal-project owner gets OWNER permissions (incl. STORY_DELETE)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});
		const resolve = await load();
		const access = await resolve(PROJECT_ID, OWNER_ID);
		expect(access?.source).toBe("owner");
		expect(access?.permissions).toContain(Permissions.STORY_DELETE);
	});

	it("active ProjectMember row is authoritative — org role is NOT consulted", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		const resolve = await load();
		const access = await resolve(PROJECT_ID, USER_ID);
		expect(access?.source).toBe("project-member");
		// EDITOR has STORY_UPDATE but NOT STORY_DELETE
		expect(access?.permissions).toContain(Permissions.STORY_UPDATE);
		expect(access?.permissions).not.toContain(Permissions.STORY_DELETE);
		// The load-bearing invariant: org role was never queried.
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("no active ProjectMember row → falls back to org role", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		const resolve = await load();
		const access = await resolve(PROJECT_ID, USER_ID);
		expect(access?.source).toBe("org");
		expect(access?.permissions).toContain(Permissions.STORY_DELETE);
	});

	/**
	 * Proves concurrency rather than asserting a timing, which would be flaky.
	 *
	 * The project lookup is held open until the ProjectMember lookup has been
	 * called. A sequential implementation cannot satisfy that — it would never
	 * issue the second query, and this test would time out instead of failing on
	 * an assertion. That is the intended signal: the two queries either overlap
	 * or the test does not finish.
	 */
	it("issues the project and ProjectMember lookups concurrently", async () => {
		let releaseProject: (value: unknown) => void = () => {};
		const memberCalled = new Promise<void>((resolveCalled) => {
			mocks.projectMemberFindUnique.mockImplementation(() => {
				resolveCalled();
				return Promise.resolve(null);
			});
		});
		mocks.projectFindUnique.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseProject = resolve;
				}),
		);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		const resolve = await load();
		const pending = resolve(PROJECT_ID, USER_ID);

		// Bounded so a regression fails in a fraction of a second with a legible
		// message, rather than burning the suite timeout on a hang.
		await Promise.race([
			memberCalled,
			new Promise((_ok, fail) =>
				setTimeout(
					() =>
						fail(
							new Error(
								"the ProjectMember lookup was not issued while the project lookup was still pending — the two queries are running sequentially again",
							),
						),
					500,
				),
			),
		]);
		releaseProject({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});

		expect((await pending)?.source).toBe("org");
	});

	/**
	 * The cost side of the trade above, asserted so it is a decision rather than
	 * a surprise: the personal-owner path returns without consulting the member
	 * row, but the query was already issued.
	 */
	it("still issues the ProjectMember lookup on the personal-owner path", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);

		const resolve = await load();
		expect((await resolve(PROJECT_ID, OWNER_ID))?.source).toBe("owner");
		expect(mocks.projectMemberFindUnique).toHaveBeenCalledTimes(1);
	});

	it("expired ProjectMember is treated as absent → org fallback", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: new Date(Date.now() - 1_000_000),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		const resolve = await load();
		const access = await resolve(PROJECT_ID, USER_ID);
		expect(access?.source).toBe("org");
		expect(access?.permissions).toContain(Permissions.STORY_DELETE);
	});
});
