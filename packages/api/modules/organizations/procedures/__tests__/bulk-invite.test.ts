/**
 * Bulk organization invitations (Fizzy #1986, FR1-FR5). One bad address must
 * never cost the others, and nothing here may ever grant more than `member`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	schema: {
		current: null as null | {
			safeParse: (v: unknown) => { success: boolean };
		},
	},
	createInvitation: vi.fn(),
	memberFindMany: vi.fn(),
	invitationFindMany: vi.fn(),
	requireOrgMembership: vi.fn(),
	checkRateLimit: vi.fn(),
	recordAudit: vi.fn(),
	requireInputOrgPermission: vi.fn((..._args: unknown[]) => ({})),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { createInvitation: mocks.createInvitation } },
}));

vi.mock("@repo/database", () => ({
	db: {
		member: { findMany: mocks.memberFindMany },
		invitation: { findMany: mocks.invitationFindMany },
	},
}));

vi.mock("../../lib/membership", () => ({
	requireOrgMembership: mocks.requireOrgMembership,
}));

vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: never) => {
			mocks.schema.current = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handlers.bulkInvite = fn;
			return fn;
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		requireInputOrgPermission: mocks.requireInputOrgPermission,
		resolveOrganizationId: (id: string) => id,
		Permissions: { ORG_MEMBERS_INVITE: "org:members:invite" },
	};
});

import { bulkInviteOrgMembersProcedure } from "../invitations/bulk-invite";

const gateAtImport = mocks.requireInputOrgPermission.mock.calls[0];

const HEADERS = new Headers({ cookie: "session=example" });

function run(emails: string[]) {
	return mocks.handlers.bulkInvite?.({
		context: {
			user: { id: "user_admin" },
			session: {},
			headers: HEADERS,
		},
		input: { organizationId: "org_example", emails },
	}) as Promise<{ results: Array<{ email: string; status: string }> }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireOrgMembership.mockResolvedValue({ role: "admin" });
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		resetInSeconds: 0,
	});
	mocks.memberFindMany.mockResolvedValue([]);
	mocks.invitationFindMany.mockResolvedValue([]);
	mocks.createInvitation.mockResolvedValue({ id: "invitation_example" });
});

describe("bulkInviteOrgMembersProcedure", () => {
	it("is defined", () => {
		expect(bulkInviteOrgMembersProcedure).toBeDefined();
	});

	it("authorizes against the requested organization, which also refuses a deleted one", () => {
		expect(gateAtImport).toEqual([
			"org:members:invite",
			{ requireOrganization: true },
		]);
	});

	it("invites every new address as a member, with the caller's session", async () => {
		const { results } = await run(["a@example.com", "b@example.com"]);

		expect(results).toEqual([
			{ email: "a@example.com", status: "invited" },
			{ email: "b@example.com", status: "invited" },
		]);
		expect(mocks.createInvitation).toHaveBeenCalledTimes(2);
		expect(mocks.createInvitation).toHaveBeenCalledWith({
			body: {
				email: "a@example.com",
				role: "member",
				organizationId: "org_example",
			},
			headers: HEADERS,
		});
	});

	it("reports a repeat in the batch once the first has been taken, ignoring case", async () => {
		const { results } = await run(["a@example.com", "A@Example.com"]);

		expect(results.map((r) => r.status)).toEqual(["invited", "duplicate"]);
		expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed address and still invites the rest", async () => {
		const { results } = await run(["not-an-email", "b@example.com"]);

		expect(results).toEqual([
			{ email: "not-an-email", status: "invalid" },
			{ email: "b@example.com", status: "invited" },
		]);
	});

	it("skips existing members and live invitations", async () => {
		mocks.memberFindMany.mockResolvedValue([
			{ user: { email: "member@example.com" } },
		]);
		mocks.invitationFindMany.mockResolvedValue([
			{ email: "pending@example.com" },
		]);

		const { results } = await run([
			"member@example.com",
			"pending@example.com",
			"new@example.com",
		]);

		expect(results.map((r) => r.status)).toEqual([
			"already_member",
			"already_invited",
			"invited",
		]);
		expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
	});

	it("ignores expired invitations when looking for live ones", async () => {
		await run(["a@example.com"]);

		const where = mocks.invitationFindMany.mock.calls[0]?.[0]?.where;
		expect(where).toMatchObject({
			organizationId: "org_example",
			status: "pending",
		});
		expect(where.expiresAt.gt).toBeInstanceOf(Date);
	});

	it("keeps the successes when one invitation fails", async () => {
		mocks.createInvitation
			.mockRejectedValueOnce(new Error("mail provider down"))
			.mockResolvedValueOnce({ id: "invitation_example" });

		const { results } = await run(["a@example.com", "b@example.com"]);

		expect(results.map((r) => r.status).sort()).toEqual([
			"failed",
			"invited",
		]);
	});

	it("reports in the order the addresses were pasted", async () => {
		mocks.createInvitation.mockImplementation(
			async ({ body }: { body: { email: string } }) => {
				if (body.email.startsWith("a")) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				return { id: body.email };
			},
		);

		const { results } = await run(["a@example.com", "b@example.com"]);

		expect(results.map((r) => r.email)).toEqual([
			"a@example.com",
			"b@example.com",
		]);
	});

	it("never runs more than a handful of invitations at once", async () => {
		let running = 0;
		let peak = 0;
		mocks.createInvitation.mockImplementation(async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running--;
			return { id: "invitation_example" };
		});

		await run(Array.from({ length: 40 }, (_, i) => `user${i}@example.com`));

		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(8);
	});

	it("refuses anyone who is not an owner or admin, before touching anything", async () => {
		mocks.requireOrgMembership.mockResolvedValue(null);

		await expect(run(["a@example.com"])).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.requireOrgMembership).toHaveBeenCalledWith(
			"user_admin",
			"org_example",
			["owner", "admin"],
		);
		expect(mocks.createInvitation).not.toHaveBeenCalled();
	});

	it("stops when the organization has sent too many batches", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			resetInSeconds: 60,
		});

		await expect(run(["a@example.com"])).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
		expect(mocks.createInvitation).not.toHaveBeenCalled();
	});

	it("reports an oversized entry on its own and still invites the rest", async () => {
		const huge = `${"x".repeat(400)}@example.com`;

		const { results } = await run([huge, "b@example.com"]);

		expect(results[0]?.status).toBe("invalid");
		expect(results[0]?.email.length).toBeLessThanOrEqual(320);
		expect(results[1]).toEqual({
			email: "b@example.com",
			status: "invited",
		});
		expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
	});

	it("accepts an oversized entry in the input, so it can be reported", () => {
		expect(
			mocks.schema.current?.safeParse({
				organizationId: "org_example",
				emails: ["x".repeat(400), "b@example.com"],
			}).success,
		).toBe(true);
	});

	it("bounds the size of the whole request", () => {
		expect(
			mocks.schema.current?.safeParse({
				organizationId: "org_example",
				emails: Array.from({ length: 500 }, () => "x".repeat(1000)),
			}).success,
		).toBe(false);
	});

	it("refuses a batch over the limit", () => {
		const emails = Array.from(
			{ length: 501 },
			(_, i) => `user${i}@example.com`,
		);

		expect(
			mocks.schema.current?.safeParse({
				organizationId: "org_example",
				emails,
			}).success,
		).toBe(false);
	});

	it("audits the counts without writing the addresses", async () => {
		await run(["a@example.com", "not-an-email"]);

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const entry = mocks.recordAudit.mock.calls[0]?.[1];
		expect(entry).toMatchObject({
			action: "org.member.bulk_invited",
			category: "org",
			organizationId: "org_example",
		});
		expect(JSON.stringify(entry)).not.toContain("a@example.com");
	});
});
