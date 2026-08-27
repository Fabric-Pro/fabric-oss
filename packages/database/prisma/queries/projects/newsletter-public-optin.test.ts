import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const updateMany = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("../../client", () => ({
	db: {
		newsletterSubscriber: {
			create: (...a: unknown[]) => create(...a),
			updateMany: (...a: unknown[]) => updateMany(...a),
			findFirst: (...a: unknown[]) => findFirst(...a),
			findMany: (...a: unknown[]) => findMany(...a),
			deleteMany: (...a: unknown[]) => deleteMany(...a),
		},
	},
}));

import {
	confirmPublicSubscriber,
	createPendingPublicSubscriber,
	listActiveNewsletterSubscribers,
	listNewsletterSubscribers,
} from "./newsletter";

// @prisma/client does not resolve in this repo (custom generator output); the
// helper only duck-types `.code`, so a plain tagged error suffices.
const P2002 = Object.assign(new Error("unique"), { code: "P2002" });

describe("createPendingPublicSubscriber", () => {
	beforeEach(() => {
		create.mockReset();
		deleteMany.mockReset().mockResolvedValue({ count: 0 });
	});

	it("purges stale PENDING rows then creates a PENDING_CONFIRMATION row with tenant XOR + token", async () => {
		create.mockResolvedValue({ id: "s1" });
		const before = Date.now();
		const res = await createPendingPublicSubscriber({
			projectId: "p1",
			email: "new@example.com",
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
		});
		expect(res.created).toBe(true);
		expect(res.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);

		// Opportunistic stale-PENDING purge: project-scoped, PENDING-only, age-gated (~7d).
		const purge = deleteMany.mock.calls[0][0] as {
			where: {
				projectId: string;
				status: string;
				createdAt: { lt: Date };
			};
		};
		expect(purge.where).toMatchObject({
			projectId: "p1",
			status: "PENDING_CONFIRMATION",
		});
		const ageMs = before - purge.where.createdAt.lt.getTime();
		expect(ageMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
		expect(ageMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);

		const arg = create.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			projectId: "p1",
			email: "new@example.com",
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
			status: "PENDING_CONFIRMATION",
		});
		expect(arg.data.unsubscribeToken).toBe(res.token);
	});

	it("returns created:false WITHOUT reactivating when the row already exists (P2002)", async () => {
		create.mockRejectedValue(P2002);
		const res = await createPendingPublicSubscriber({
			projectId: "p1",
			email: "existing@example.com",
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
		});
		expect(res).toEqual({ created: false, token: null });
	});

	it("re-throws non-unique errors", async () => {
		create.mockRejectedValue(new Error("db down"));
		await expect(
			createPendingPublicSubscriber({
				projectId: "p1",
				email: "x@example.com",
				userId: "u1",
				organizationId: null,
				createdByUserId: "u1",
			}),
		).rejects.toThrow("db down");
	});
});

describe("confirmPublicSubscriber", () => {
	beforeEach(() => {
		updateMany.mockReset();
		findFirst.mockReset();
	});

	it("flips exactly one PENDING row to ACTIVE and returns its email", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		findFirst.mockResolvedValue({ email: "new@example.com" });
		const res = await confirmPublicSubscriber("p1", "tok-1234567890");
		expect(res).toEqual({ confirmed: true, email: "new@example.com" });
		const arg = updateMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(arg.where).toEqual({
			unsubscribeToken: "tok-1234567890",
			projectId: "p1",
			status: "PENDING_CONFIRMATION",
		});
		expect(arg.data).toEqual({ status: "ACTIVE" });
	});

	it("is a no-op for an unknown/used/unsubscribed token (count 0)", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		const res = await confirmPublicSubscriber("p1", "bad-token-xyz");
		expect(res).toEqual({ confirmed: false, email: null });
		expect(findFirst).not.toHaveBeenCalled();
	});
});

describe("subscriber list filters (PENDING never sent, never shown to admins)", () => {
	beforeEach(() => findMany.mockReset().mockResolvedValue([]));

	it("send path: listActiveNewsletterSubscribers filters status === ACTIVE exactly", async () => {
		await listActiveNewsletterSubscribers("p1");
		const arg = findMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(arg.where).toEqual({ projectId: "p1", status: "ACTIVE" });
	});

	it("admin list: listNewsletterSubscribers excludes PENDING_CONFIRMATION", async () => {
		await listNewsletterSubscribers("p1");
		const arg = findMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
		};
		expect(arg.where).toEqual({
			projectId: "p1",
			status: { not: "PENDING_CONFIRMATION" },
		});
	});
});
