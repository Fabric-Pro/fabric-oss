/**
 * Every account belongs to an organization (Fizzy #1875, FR1a).
 *
 * The subtle half is who must NOT get one. An invited user already belongs
 * somewhere, and handing them a second empty organization is the failure the
 * requirement names explicitly — so the function asks whether they belong
 * anywhere, not whether they were just created. That is also what lets it run
 * on every sign-in as the backfill for accounts that predate it.
 */

import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const organizationFindFirst = vi.fn();
const organizationCreate = vi.fn();
const memberCreate = vi.fn();
const recordAudit = vi.fn();

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: {
		user: {
			findUnique: (...args: unknown[]) => userFindUnique(...args),
			update: (...args: unknown[]) => userUpdate(...args),
		},
		organization: {
			findFirst: (...args: unknown[]) => organizationFindFirst(...args),
		},
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({
				organization: {
					create: (...args: unknown[]) => organizationCreate(...args),
				},
				member: {
					create: (...args: unknown[]) => memberCreate(...args),
				},
			}),
	},
	recordAudit: (...args: unknown[]) => recordAudit(...args),
}));

import { ensureUserHasOrganization } from "../ensure-user-organization";

const provision = vi.fn(async () => undefined);

/** A user row as the helper selects it. */
function userRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "user-1",
		name: "Ada Example",
		email: "dev@example.com",
		members: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	organizationFindFirst.mockResolvedValue(null);
	organizationCreate.mockImplementation(async ({ data }: any) => ({
		id: "org-new",
		name: data.name,
		slug: data.slug,
	}));
	memberCreate.mockResolvedValue({ id: "member-1" });
	userUpdate.mockResolvedValue({});
});

describe("ensureUserHasOrganization", () => {
	it("gives an organization to a user who belongs nowhere", async () => {
		userFindUnique.mockResolvedValue(userRow());

		const created = await ensureUserHasOrganization("user-1", provision);

		expect(created).toEqual({
			outcome: "created",
			organizationId: "org-new",
		});
		expect(organizationCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					name: "Ada Example's workspace",
				}),
			}),
		);
		expect(memberCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					organizationId: "org-new",
					userId: "user-1",
					role: "owner",
				}),
			}),
		);
	});

	it("leaves a user who already belongs somewhere alone", async () => {
		// The invited-user case, and the reason the check is "do they belong
		// anywhere" rather than "were they just created": running again on
		// sign-in must not hand them a second, empty organization.
		userFindUnique.mockResolvedValue(
			userRow({ members: [{ id: "member-existing" }] }),
		);

		const created = await ensureUserHasOrganization("user-1", provision);

		expect(created).toEqual({ outcome: "already-had-one" });
		expect(organizationCreate).not.toHaveBeenCalled();
		expect(memberCreate).not.toHaveBeenCalled();
		expect(userUpdate).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
	});

	it("names the organization after the email when there is no name", async () => {
		userFindUnique.mockResolvedValue(
			userRow({ name: null, email: "someone@example.com" }),
		);

		await ensureUserHasOrganization("user-1", provision);

		expect(organizationCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					name: "someone's workspace",
				}),
			}),
		);
	});

	it("points the user's last-active organization at the new one", async () => {
		// Where the post-login redirect lands them, and what a key-authenticated
		// protocol caller now resolves to.
		userFindUnique.mockResolvedValue(userRow());

		await ensureUserHasOrganization("user-1", provision);

		expect(userUpdate).toHaveBeenCalledWith({
			where: { id: "user-1" },
			data: { lastActiveOrganizationId: "org-new" },
		});
	});

	it("provisions the new organization through the caller's own seeder", async () => {
		// Passed in rather than imported, so the auto-created path and the
		// plugin's own hook cannot drift into seeding different things.
		userFindUnique.mockResolvedValue(userRow());

		await ensureUserHasOrganization("user-1", provision);

		expect(provision).toHaveBeenCalledWith({
			organizationId: "org-new",
			userId: "user-1",
		});
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "org.created",
				organizationId: "org-new",
				metadata: expect.objectContaining({ autoCreated: true }),
			}),
		);
	});

	it("suffixes the slug rather than colliding", async () => {
		userFindUnique.mockResolvedValue(userRow());
		organizationFindFirst
			.mockResolvedValueOnce({ id: "taken" })
			.mockResolvedValue(null);

		await ensureUserHasOrganization("user-1", provision);

		const slug = organizationCreate.mock.calls[0][0].data.slug as string;
		expect(slug).toMatch(/^ada-examples-workspace-.+/);
	});

	it("reports failure instead of throwing when the write fails", async () => {
		// A signup or a sign-in must not fail because an organization could not
		// be created. The next session tries again.
		userFindUnique.mockResolvedValue(userRow());
		organizationCreate.mockRejectedValue(new Error("write failed"));

		await expect(
			ensureUserHasOrganization("user-1", provision),
		).resolves.toEqual({ outcome: "failed", reason: "write failed" });
	});

	it("tells the operator when it could not create one", async () => {
		// Silent to the caller, never to the operator. Every account that lands
		// here is in the fail-closed nowhere state, and a slug race that starts
		// happening to every signup must not be visible only to the users.
		userFindUnique.mockResolvedValue(userRow());
		organizationCreate.mockRejectedValue(new Error("write failed"));

		await ensureUserHasOrganization("user-1", provision);

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("Could not create an organization"),
			expect.objectContaining({ userId: "user-1" }),
		);
	});

	it("separates a user who already belongs from one it could not create for", async () => {
		// The distinction the return type exists for. Collapsing both to null
		// made the signup hook warn on every invited signup, with a message
		// that was false in both halves.
		userFindUnique.mockResolvedValue(
			userRow({ members: [{ id: "member-existing" }] }),
		);
		const existing = await ensureUserHasOrganization("user-1", provision);

		userFindUnique.mockResolvedValue(userRow());
		organizationCreate.mockRejectedValue(new Error("write failed"));
		const failed = await ensureUserHasOrganization("user-1", provision);

		expect(existing.outcome).toBe("already-had-one");
		expect(failed.outcome).toBe("failed");
	});

	it("reports a missing user as already-had-one rather than a failure", async () => {
		// Nothing went wrong; there is simply nobody to give one to. Reporting
		// it as a failure would page someone for a deleted account.
		userFindUnique.mockResolvedValue(null);

		await expect(
			ensureUserHasOrganization("ghost", provision),
		).resolves.toEqual({ outcome: "already-had-one" });
		expect(organizationCreate).not.toHaveBeenCalled();
	});
});
