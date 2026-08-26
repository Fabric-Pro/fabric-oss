import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prisma client so the query helpers can be unit-tested without a DB.
const upsert = vi.fn();
const memberFindUnique = vi.fn();
const sendDeleteMany = vi.fn();
const sendCreate = vi.fn();
const sendFindUnique = vi.fn();
const sendFindFirst = vi.fn();
const chatDeliveryCreate = vi.fn();
const chatDeliveryUpdateMany = vi.fn();
const chatDeliveryFindMany = vi.fn();
vi.mock("../../client", () => ({
	db: {
		newsletterSettings: { upsert: (...a: unknown[]) => upsert(...a) },
		member: { findUnique: (...a: unknown[]) => memberFindUnique(...a) },
		newsletterSend: {
			deleteMany: (...a: unknown[]) => sendDeleteMany(...a),
			create: (...a: unknown[]) => sendCreate(...a),
			findUnique: (...a: unknown[]) => sendFindUnique(...a),
			findFirst: (...a: unknown[]) => sendFindFirst(...a),
		},
		newsletterChatDelivery: {
			create: (...a: unknown[]) => chatDeliveryCreate(...a),
			updateMany: (...a: unknown[]) => chatDeliveryUpdateMany(...a),
			findMany: (...a: unknown[]) => chatDeliveryFindMany(...a),
		},
	},
}));

import {
	claimChatDelivery,
	createOrGetNewsletterSend,
	generateUnsubscribeToken,
	isScheduledNewsletterActorValid,
	listChatDeliveriesForSend,
	markChatDelivery,
	newsletterSettingsDefaults,
	upsertNewsletterSettings,
} from "./newsletter";

describe("newsletter query helpers", () => {
	it("default settings are disabled weekly Monday 09:00", () => {
		const d = newsletterSettingsDefaults("proj_1");
		expect(d).toMatchObject({
			projectId: "proj_1",
			enabled: false,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			id: null,
		});
	});

	it("unsubscribe tokens are long, URL-safe, and unique", () => {
		const a = generateUnsubscribeToken();
		const b = generateUnsubscribeToken();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
	});
});

describe("upsertNewsletterSettings — scheduled-send actor attribution", () => {
	beforeEach(() => {
		upsert.mockReset();
		upsert.mockResolvedValue({ id: "ns-1" });
	});

	it("writes createdByUserId in the CREATE branch (new row)", async () => {
		await upsertNewsletterSettings("proj-1", {
			enabled: true,
			userId: null, // org context: tenant userId is null by XOR
			organizationId: "org-9",
			createdByUserId: "admin-1",
		});
		const arg = upsert.mock.calls[0][0] as {
			create: { createdByUserId: string; userId: string | null };
		};
		expect(arg.create.createdByUserId).toBe("admin-1");
		// Tenant XOR preserved: createdByUserId is orthogonal to the userId column.
		expect(arg.create.userId).toBeNull();
	});

	it("re-homes createdByUserId in the UPDATE branch (Codex regression)", async () => {
		// A second, currently-valid admin re-saves an existing org settings row.
		// The scheduled-send actor MUST move to that admin so a row created by a
		// since-removed admin (or the legacy "system" sentinel) self-heals.
		await upsertNewsletterSettings("proj-1", {
			cadence: "MONTHLY",
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-2",
		});
		const arg = upsert.mock.calls[0][0] as {
			update: { createdByUserId: string };
		};
		expect(arg.update.createdByUserId).toBe("admin-2");
	});
});

describe("upsertNewsletterSettings — lookbackDays", () => {
	beforeEach(() => {
		upsert.mockReset();
		upsert.mockResolvedValue({ id: "ns-1" });
	});

	it("writes lookbackDays in the CREATE branch", async () => {
		await upsertNewsletterSettings("proj-1", {
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
			lookbackDays: 90,
		});
		const arg = upsert.mock.calls[0][0] as {
			create: { lookbackDays: number | null };
		};
		expect(arg.create.lookbackDays).toBe(90);
	});

	it("defaults lookbackDays to null on create when omitted", async () => {
		await upsertNewsletterSettings("proj-1", {
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
		});
		const arg = upsert.mock.calls[0][0] as {
			create: { lookbackDays: number | null };
		};
		expect(arg.create.lookbackDays).toBeNull();
	});

	it("writes lookbackDays in the UPDATE branch, including explicit null (clear)", async () => {
		await upsertNewsletterSettings("proj-1", {
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
			lookbackDays: null,
		});
		const arg = upsert.mock.calls[0][0] as {
			update: { lookbackDays: number | null };
		};
		expect(arg.update).toHaveProperty("lookbackDays", null);
	});

	it("omits lookbackDays from UPDATE when not provided", async () => {
		await upsertNewsletterSettings("proj-1", {
			userId: null,
			organizationId: "org-9",
			createdByUserId: "admin-1",
		});
		const arg = upsert.mock.calls[0][0] as {
			update: Record<string, unknown>;
		};
		expect(arg.update).not.toHaveProperty("lookbackDays");
	});
});

describe("isScheduledNewsletterActorValid", () => {
	beforeEach(() => memberFindUnique.mockReset());

	it("personal context: valid only when the actor IS the project owner", async () => {
		// createdByUserId === ownerUserId → valid, no membership query.
		expect(await isScheduledNewsletterActorValid("u1", null, "u1")).toBe(
			true,
		);
		// Codex round-2: a personal row whose createdByUserId drifted from the
		// owner (legacy sentinel, reassigned id) must NOT be blanket-approved.
		expect(
			await isScheduledNewsletterActorValid("system", null, "u1"),
		).toBe(false);
		expect(await isScheduledNewsletterActorValid("u1", null, null)).toBe(
			false,
		);
		expect(memberFindUnique).not.toHaveBeenCalled();
	});

	it("org context: valid only when a current member row exists", async () => {
		memberFindUnique.mockResolvedValueOnce({ id: "m1" });
		expect(await isScheduledNewsletterActorValid("u1", "o1", null)).toBe(
			true,
		);

		// Removed/deleted admin: member row is gone (FK cascade) => invalid.
		memberFindUnique.mockResolvedValueOnce(null);
		expect(await isScheduledNewsletterActorValid("ghost", "o1", null)).toBe(
			false,
		);
		expect(memberFindUnique).toHaveBeenLastCalledWith({
			where: {
				organizationId_userId: {
					organizationId: "o1",
					userId: "ghost",
				},
			},
			select: { id: true },
		});
	});
});

describe("createOrGetNewsletterSend — stale orphan reclaim", () => {
	const baseInput = {
		projectId: "p1",
		organizationId: "o1",
		userId: null,
		dedupeKey: "manual:p1:2026-06-13T10:21:00.000Z",
		trigger: "MANUAL" as const,
		timeWindowStart: new Date(0),
		timeWindowEnd: new Date(1),
		triggeredByUserId: "u1",
		detailLevel: "STANDARD" as const,
		deliveryDestination: "EMAIL" as const,
	};

	beforeEach(() => {
		sendDeleteMany.mockReset().mockResolvedValue({ count: 0 });
		sendCreate.mockReset().mockResolvedValue({
			id: "s1",
			status: "PENDING",
			temporalWorkflowId: null,
		});
		sendFindUnique.mockReset();
		sendFindFirst.mockReset();
	});

	it("reclaims stale orphans by age alone (30m), regardless of temporalWorkflowId", async () => {
		await createOrGetNewsletterSend(baseInput);
		const callObservedAt = Date.now();

		expect(sendDeleteMany).toHaveBeenCalledTimes(1);
		const where = (
			sendDeleteMany.mock.calls[0][0] as {
				where: { createdAt: { lt: Date } } & Record<string, unknown>;
			}
		).where;
		// Double-send / evidence-loss safe: project-scoped, PENDING, no delivery.
		expect(where).toMatchObject({
			projectId: "p1",
			status: "PENDING",
			deliveries: { none: {} },
		});
		// The fix: gate on age alone. A recorded workflow id no longer EXEMPTS a
		// stale orphan, AND a null id is NOT treated as "never started" (both start
		// paths swallow workflowId-persist failures, so null can mean "running, id
		// not persisted"). So there must be no temporalWorkflowId gate and no OR
		// split. (Adversarial-review: createdAt-vs-start gap + null-not-proof.)
		expect(where).not.toHaveProperty("temporalWorkflowId");
		expect(where).not.toHaveProperty("OR");

		// Threshold must be 30m (2× the 15m executionTimeout), not 15m: the timeout
		// runs from workflow START (~createdAt + delta), not createdAt, so the cutoff
		// needs a full timeout of buffer beyond it.
		const cutoffAgeMs = callObservedAt - where.createdAt.lt.getTime();
		expect(cutoffAgeMs).toBeGreaterThan(29 * 60 * 1000);
		expect(cutoffAgeMs).toBeLessThan(31 * 60 * 1000);
	});

	it("returns the newly created row with created=true", async () => {
		const r = await createOrGetNewsletterSend(baseInput);
		expect(r).toEqual({
			send: { id: "s1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
	});
});

describe("chat delivery ledger", () => {
	beforeEach(() => {
		chatDeliveryCreate.mockReset();
		chatDeliveryUpdateMany.mockReset();
		chatDeliveryFindMany.mockReset();
	});

	const baseClaimInput = {
		sendId: "s1",
		projectId: "p1",
		organizationId: null,
		userId: "u1",
		kind: "CONTENT" as const,
		platform: "SLACK" as const,
		externalTeamId: "T1",
		channelId: "C1",
	};

	it("claimChatDelivery returns claimed:true on first insert", async () => {
		chatDeliveryCreate.mockResolvedValueOnce({ id: "cd1" });
		const r = await claimChatDelivery(baseClaimInput);
		expect(r.claimed).toBe(true);
		expect(chatDeliveryCreate).toHaveBeenCalledWith({
			data: {
				sendId: "s1",
				projectId: "p1",
				organizationId: null,
				userId: "u1",
				kind: "CONTENT",
				platform: "SLACK",
				externalTeamId: "T1",
				channelId: "C1",
				status: "SENDING",
			},
		});
	});

	it("claimChatDelivery returns claimed:false on unique conflict (already handled)", async () => {
		chatDeliveryCreate.mockRejectedValueOnce(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		const r = await claimChatDelivery(baseClaimInput);
		expect(r.claimed).toBe(false);
	});

	it("claimChatDelivery rethrows a non-P2002 error (does not swallow real failures)", async () => {
		const boom = new Error("connection reset");
		chatDeliveryCreate.mockRejectedValueOnce(boom);
		await expect(claimChatDelivery(baseClaimInput)).rejects.toThrow(boom);
	});

	it("markChatDelivery(SENT) sets status + postedMessageId + deliveredAt", async () => {
		chatDeliveryUpdateMany.mockResolvedValueOnce({ count: 1 });
		await markChatDelivery({
			sendId: "s1",
			kind: "CONTENT",
			platform: "SLACK",
			externalTeamId: "T1",
			channelId: "C1",
			status: "SENT",
			postedMessageId: "1700000000.000100",
		});
		expect(chatDeliveryUpdateMany).toHaveBeenCalledTimes(1);
		const arg = chatDeliveryUpdateMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
			data: {
				status: string;
				postedMessageId: string | null;
				deliveredAt: Date | null;
				errorMessage: string | null;
			};
		};
		expect(arg.where).toEqual({
			sendId: "s1",
			kind: "CONTENT",
			platform: "SLACK",
			externalTeamId: "T1",
			channelId: "C1",
		});
		expect(arg.data.status).toBe("SENT");
		expect(arg.data.postedMessageId).toBe("1700000000.000100");
		expect(arg.data.errorMessage).toBeNull();
		expect(arg.data.deliveredAt).toBeInstanceOf(Date);
	});

	it("markChatDelivery(FAILED) records errorMessage and leaves deliveredAt null", async () => {
		chatDeliveryUpdateMany.mockResolvedValueOnce({ count: 1 });
		await markChatDelivery({
			sendId: "s1",
			kind: "CONTENT",
			platform: "TEAMS",
			externalTeamId: "T2",
			channelId: "C2",
			status: "FAILED",
			errorMessage: "rate limited",
		});
		const arg = chatDeliveryUpdateMany.mock.calls[0][0] as {
			data: {
				status: string;
				errorMessage: string | null;
				deliveredAt: Date | null;
			};
		};
		expect(arg.data.status).toBe("FAILED");
		expect(arg.data.errorMessage).toBe("rate limited");
		expect(arg.data.deliveredAt).toBeNull();
	});

	it("listChatDeliveriesForSend selects the ledger projection scoped by sendId", async () => {
		chatDeliveryFindMany.mockResolvedValueOnce([
			{
				platform: "SLACK",
				externalTeamId: "T1",
				channelId: "C1",
				status: "SENT",
				errorMessage: null,
				postedMessageId: "1700000000.000100",
				deliveredAt: new Date(0),
			},
		]);
		const rows = await listChatDeliveriesForSend("s1", "CONTENT");
		expect(chatDeliveryFindMany).toHaveBeenCalledWith({
			where: { sendId: "s1", kind: "CONTENT" },
			select: {
				platform: true,
				externalTeamId: true,
				channelId: true,
				status: true,
				errorMessage: true,
				postedMessageId: true,
				deliveredAt: true,
			},
		});
		expect(rows).toHaveLength(1);
	});
});
