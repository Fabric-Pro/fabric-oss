/**
 * Unit tests for the `hasAnyPersonalProject` existence check.
 *
 * The helper backs the `/app` guest landing redirect: a zero-org user is
 * only redirected to their invited org project when they ALSO have no
 * personal-context project to land on. The where clause uses the
 * `listProjects` personal-context access filter — explicit
 * `organizationId: null` (multi-tenant XOR), non-deleted (`deletedAt: null`,
 * so a soft-deleted-only user is still redirected), owner OR accepted,
 * unexpired member.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/has-any-personal-project.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasAnyPersonalProject } from "../prisma/queries/projects/has-any-personal-project";

const { findFirstMock } = vi.hoisted(() => ({
	findFirstMock: vi.fn(),
}));

// The helper resolves its `db` import to `../../client` from its position
// at `prisma/queries/projects/`. From this test's location at
// `__tests__/`, that same module is reachable at `../prisma/client`.
// `vi.mock` is hoisted above the static import, so the helper sees the
// mocked client.
vi.mock("../prisma/client", () => ({
	db: {
		project: { findFirst: findFirstMock },
	},
}));

beforeEach(() => {
	findFirstMock.mockReset();
});

describe("hasAnyPersonalProject", () => {
	it("issues one existence-check `findFirst` mirroring the listProjects personal-context access filter", async () => {
		findFirstMock.mockResolvedValue(null);

		await hasAnyPersonalProject("user-1");

		expect(findFirstMock).toHaveBeenCalledTimes(1);
		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				organizationId: null,
				deletedAt: null,
				OR: [
					{ userId: "user-1" }, // User is owner
					{
						members: {
							some: {
								userId: "user-1",
								acceptedAt: { not: null },
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: expect.any(Date) } },
								],
							},
						},
					},
				],
			},
			select: { id: true },
		});
	});

	it("filters on an EXPLICIT `organizationId: null` (multi-tenant XOR — never undefined/absent)", async () => {
		findFirstMock.mockResolvedValue(null);

		await hasAnyPersonalProject("user-1");

		const { where } = findFirstMock.mock.calls[0][0];
		expect(Object.hasOwn(where, "organizationId")).toBe(true);
		expect(where.organizationId).toBeNull();
	});

	it("returns true when a matching personal project exists", async () => {
		findFirstMock.mockResolvedValue({ id: "proj-1" });

		await expect(hasAnyPersonalProject("user-1")).resolves.toBe(true);
	});

	it("returns false when the user owns no personal project and holds no accepted membership", async () => {
		findFirstMock.mockResolvedValue(null);

		await expect(hasAnyPersonalProject("user-1")).resolves.toBe(false);
	});
});
