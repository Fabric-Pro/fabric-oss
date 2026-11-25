import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	$transaction: vi.fn(),
	authoritySession: {
		updateMany: vi.fn(),
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		findUniqueOrThrow: vi.fn(),
	},
	authorityGrant: { update: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: mocks,
}));

import type { AuthorityGrant } from "../prisma/generated/client";
import {
	approveAuthoritySession,
	consumeRequestGrant,
	denyAuthoritySession,
} from "../prisma/queries/authority";

const now = new Date("2026-01-10T00:00:00Z");
const future = new Date("2026-01-10T01:00:00Z");
const sessionId = "example-session";
const userId = "example-user";
const organizationId = "example-org";
const grant: AuthorityGrant = {
	id: "example-grant",
	authoritySessionId: sessionId,
	kind: "REQUEST",
	providerType: "MCP",
	providerKey: "example-provider",
	providerRefId: null,
	providerDisplayName: null,
	accessLevel: "WRITE",
	toolScope: ["example-tool"],
	requestFingerprint: "example-fingerprint",
	status: "APPROVED",
	approvedBy: userId,
	approvedAt: now,
	expiresAt: future,
	consumedAt: null,
	deniedAt: null,
	denialReason: null,
	metadata: null,
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ now });
	mocks.$transaction.mockImplementation(async (callback) => callback(mocks));
});
afterEach(() => vi.useRealTimers());

describe.each([
	{ name: "approval", decide: approveAuthoritySession, status: "PENDING" },
	{
		name: "denial",
		decide: denyAuthoritySession,
		status: { in: ["PENDING", "ACTIVE"] },
	},
])("$name", ({ decide, status }) => {
	it.each([
		{
			label: "wrong organization",
			options: { organizationId: "other-org" },
			tenant: { organizationId: "other-org" },
		},
		{
			label: "explicit null",
			options: { organizationId: null },
			tenant: { organizationId: null },
		},
		{
			label: "trusted caller without a tenant option",
			options: undefined,
			tenant: {},
		},
	])(
		"uses the same owner and tenant for writes and conflict lookup ($label)",
		async ({ options, tenant }) => {
			mocks.authoritySession.updateMany.mockResolvedValue({ count: 0 });
			mocks.authoritySession.findFirst.mockResolvedValue(null);
			const identity = { id: sessionId, userId, ...tenant };
			await expect(
				decide(sessionId, userId, undefined, options),
			).rejects.toMatchObject({
				name: "AuthoritySessionConflictError",
				sessionId,
				currentStatus: null,
			});
			expect(mocks.authoritySession.updateMany).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					where: { ...identity, status, expiresAt: { gt: now } },
				}),
			);
			if (typeof status !== "string") {
				expect(
					mocks.authoritySession.updateMany,
				).toHaveBeenNthCalledWith(2, {
					where: { ...identity, status, expiresAt: { lte: now } },
					data: { status: "EXPIRED" },
				});
			}
			expect(
				mocks.authoritySession.findFirst,
			).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ where: identity }),
			);
			expect(mocks.authorityGrant.updateMany).not.toHaveBeenCalled();
		},
	);
});

it.each(["PENDING", "ACTIVE"] as const)(
	"refuses to approve an expired %s session",
	async (status) => {
		mocks.authoritySession.updateMany.mockResolvedValue({ count: 0 });
		mocks.authoritySession.findFirst.mockResolvedValue({
			status,
			expiresAt: now,
		});
		await expect(
			approveAuthoritySession(sessionId, userId, undefined, {
				organizationId,
			}),
		).rejects.toMatchObject({
			currentStatus: status,
			message: expect.stringContaining("expired"),
		});
		expect(mocks.authorityGrant.updateMany).not.toHaveBeenCalled();
	},
);

it("returns an unexpired active approval retry without rewriting grants", async () => {
	mocks.authoritySession.updateMany.mockResolvedValue({ count: 0 });
	mocks.authoritySession.findFirst.mockResolvedValue({
		status: "ACTIVE",
		expiresAt: future,
	});
	const session = {
		id: sessionId,
		status: "ACTIVE",
		expiresAt: future,
		userId,
		organizationId,
		grants: [grant],
	};
	mocks.authoritySession.findUnique.mockResolvedValue(session);
	await expect(
		approveAuthoritySession(sessionId, userId, undefined, {
			organizationId,
		}),
	).resolves.toEqual(session);
	expect(mocks.authorityGrant.updateMany).not.toHaveBeenCalled();
});

it("approves pending grants only after activating the session", async () => {
	mocks.authoritySession.updateMany.mockResolvedValue({ count: 1 });
	const session = {
		id: sessionId,
		status: "ACTIVE",
		expiresAt: future,
		userId,
		organizationId,
		grants: [grant],
	};
	mocks.authoritySession.findUnique.mockResolvedValue(session);
	await expect(
		approveAuthoritySession(sessionId, userId, "Example instructions", {
			organizationId,
		}),
	).resolves.toEqual(session);
	expect(mocks.authoritySession.updateMany).toHaveBeenCalledExactlyOnceWith({
		where: {
			id: sessionId,
			userId,
			organizationId,
			status: "PENDING",
			expiresAt: { gt: now },
		},
		data: {
			status: "ACTIVE",
			approvedAt: now,
			approvalInstructions: "Example instructions",
		},
	});
	expect(mocks.authorityGrant.updateMany).toHaveBeenCalledExactlyOnceWith({
		where: { authoritySessionId: sessionId, status: "PENDING" },
		data: { status: "APPROVED", approvedBy: userId, approvedAt: now },
	});
});

it("expires stale grants without recording a successful denial", async () => {
	mocks.authoritySession.updateMany
		.mockResolvedValueOnce({ count: 0 })
		.mockResolvedValueOnce({ count: 1 });
	mocks.authoritySession.findFirst.mockResolvedValue({
		status: "EXPIRED",
		approvedAt: null,
	});
	await expect(
		denyAuthoritySession(sessionId, userId, "Example reason", {
			organizationId,
		}),
	).resolves.toEqual({
		transitioned: false,
		previousStatus: "PENDING",
		outcome: "expired",
	});
	expect(mocks.authorityGrant.updateMany).toHaveBeenCalledExactlyOnceWith({
		where: {
			authoritySessionId: sessionId,
			status: { in: ["PENDING", "APPROVED"] },
		},
		data: { status: "EXPIRED" },
	});
});

it("denies pending grants and revokes approved grants after withdrawing an active session", async () => {
	mocks.authoritySession.updateMany.mockResolvedValue({ count: 1 });
	mocks.authoritySession.findUniqueOrThrow.mockResolvedValue({
		approvedAt: now,
	});
	await expect(
		denyAuthoritySession(sessionId, userId, "Example reason", {
			organizationId,
		}),
	).resolves.toEqual({
		transitioned: true,
		previousStatus: "ACTIVE",
		outcome: "withdrawn",
	});
	expect(mocks.authorityGrant.updateMany).toHaveBeenNthCalledWith(1, {
		where: { authoritySessionId: sessionId, status: "PENDING" },
		data: {
			status: "DENIED",
			approvedBy: userId,
			deniedAt: now,
			denialReason: "Example reason",
		},
	});
	expect(mocks.authorityGrant.updateMany).toHaveBeenNthCalledWith(2, {
		where: { authoritySessionId: sessionId, status: "APPROVED" },
		data: { status: "REVOKED" },
	});
});

function mockConditionalConsume(stored: AuthorityGrant) {
	mocks.authorityGrant.updateMany.mockImplementation(
		async ({ where, data }) => {
			if (
				(where.id !== undefined && stored.id !== where.id) ||
				(where.kind !== undefined && stored.kind !== where.kind) ||
				(where.status !== undefined &&
					stored.status !== where.status) ||
				(where.expiresAt !== undefined &&
					stored.expiresAt <= where.expiresAt.gt)
			) {
				return { count: 0 };
			}
			Object.assign(stored, data);
			return { count: 1 };
		},
	);
}

it.each([
	{ label: "another grant", row: { ...grant, id: "other-grant" } },
	{
		label: "already consumed",
		row: { ...grant, status: "CONSUMED", consumedAt: now },
	},
	{ label: "expired at the deadline", row: { ...grant, expiresAt: now } },
	{
		label: "broad approval",
		row: { ...grant, kind: "BROAD", requestFingerprint: null },
	},
] satisfies Array<{ label: string; row: AuthorityGrant }>)(
	"cannot consume $label",
	async ({ row }) => {
		mockConditionalConsume({ ...row });
		await expect(consumeRequestGrant(grant.id)).resolves.toEqual({
			consumed: false,
			count: 0,
		});
	},
);

it("consumes a live request grant only once across competing calls", async () => {
	mockConditionalConsume({ ...grant });
	await expect(
		Promise.all([
			consumeRequestGrant(grant.id),
			consumeRequestGrant(grant.id),
		]),
	).resolves.toEqual([
		{ consumed: true, count: 1 },
		{ consumed: false, count: 0 },
	]);
	expect(mocks.authorityGrant.updateMany).toHaveBeenNthCalledWith(1, {
		where: {
			id: grant.id,
			kind: "REQUEST",
			status: "APPROVED",
			expiresAt: { gt: now },
		},
		data: { status: "CONSUMED", consumedAt: now },
	});
});
