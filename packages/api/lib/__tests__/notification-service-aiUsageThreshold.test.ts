/**
 * Verifies fanOut.aiUsageThreshold:
 * - dedup key shape collapses repeats per (limit, window, threshold, recipient)
 * - 80% and 100% are independent thresholds for the same recipient + limit
 * - personal limit → recipient = [createdById]
 * - org limit → recipient = dedupe([createdById,...orgOwnersAndAdmins])
 * - email send failure does NOT abort the in-app notification
 * - log on entry; log on email failure; never throws to caller
 * Mocks `db.member.findMany`, `db.user.findUnique`,
 * `db.organization.findUnique`, `db.notification.create`, and `sendEmail`
 * at the boundary so the test exercises pure fanout logic.
 */

import { NotificationCategory, NotificationType } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		db: {
			notification: {
				findFirst: vi.fn(),
				create: vi.fn(),
				updateMany: vi.fn(),
			},
			member: {
				findMany: vi.fn(),
			},
			user: {
				findUnique: vi.fn(),
			},
			organization: {
				findUnique: vi.fn(),
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../notification-cache", () => ({
	invalidateUnreadCount: vi.fn().mockResolvedValue(undefined),
	getCachedUnreadCount: vi.fn().mockResolvedValue(null),
	setCachedUnreadCount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/mail", () => ({
	sendEmail: vi.fn().mockResolvedValue(true),
}));

async function loadModule() {
	return await import("../notification-service");
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		notification: {
			findFirst: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
		member: { findMany: ReturnType<typeof vi.fn> };
		user: { findUnique: ReturnType<typeof vi.fn> };
		organization: { findUnique: ReturnType<typeof vi.fn> };
	};
}

async function getMockSendEmail() {
	const mod = await import("@repo/mail");
	return mod.sendEmail as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(async () => {
	// The email link must be absolute, so it is built off getBaseUrl(). Pin the
	// host rather than letting the assertion ride on the localhost fallback.
	vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://fabric.pro");
	const db = await getMockDb();
	db.notification.findFirst.mockReset();
	db.notification.create.mockReset();
	db.notification.updateMany.mockReset();
	db.member.findMany.mockReset();
	db.user.findUnique.mockReset();
	db.organization.findUnique.mockReset();
	const sendEmail = await getMockSendEmail();
	sendEmail.mockReset();
	sendEmail.mockResolvedValue(true);
});

afterEach(() => {
	// This package has no `unstubEnvs` in its vitest config, so the stub above
	// would otherwise outlive the suite.
	vi.unstubAllEnvs();
});

const baseArgs = {
	limitId: "lim_1",
	organizationId: null as string | null,
	userId: "user-owner",
	createdById: "user-owner",
	windowStartIso: "2026-05-14T00:00:00.000Z",
	threshold: 80 as 80 | 100,
	dimension: "TOKENS" as const,
	window: "MONTHLY" as const,
	enforcement: "HARD" as const,
	used: BigInt(8000),
	max: BigInt(10000),
	limitName: "Monthly OpenAI tokens",
};

describe("fanOut.aiUsageThreshold — personal limit", () => {
	it("notifies the limit owner only (single recipient)", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: "en",
		});
		db.notification.create.mockResolvedValue({ id: "n1" });

		await fanOut.aiUsageThreshold({ ...baseArgs });

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.userId).toBe("user-owner");
		expect(data.organizationId).toBeNull();
		expect(data.type).toBe(NotificationType.AI_USAGE_LIMIT_WARNING);
		expect(data.category).toBe(NotificationCategory.BILLING);
		expect(data.dedupeKey).toBe(
			"aiUsageLimit:lim_1:2026-05-14T00:00:00.000Z:80",
		);
		// Personal limit must skip the org-member lookup entirely.
		expect(db.member.findMany).not.toHaveBeenCalled();
	});

	it("uses the personal-context URL when no org slug is available", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: null,
		});
		db.notification.create.mockResolvedValue({ id: "n1" });

		await fanOut.aiUsageThreshold({ ...baseArgs });

		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.link).toBe("/app/settings/usage?limitId=lim_1");
	});
});

describe("fanOut.aiUsageThreshold — org limit", () => {
	const orgArgs = {
		...baseArgs,
		organizationId: "org-1",
		userId: null,
		createdById: "user-creator",
	};

	it("notifies creator + every org owner/admin (deduplicated)", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.member.findMany.mockResolvedValue([
			{
				user: {
					id: "user-creator",
					email: "creator@example.com",
					locale: "en",
				},
			},
			{
				user: {
					id: "user-admin1",
					email: "admin1@example.com",
					locale: "en",
				},
			},
			{
				user: {
					id: "user-admin2",
					email: "admin2@example.com",
					locale: null,
				},
			},
		]);
		db.user.findUnique.mockResolvedValue({
			id: "user-creator",
			email: "creator@example.com",
			locale: "en",
		});
		db.organization.findUnique.mockResolvedValue({ slug: "acme" });
		db.notification.create.mockResolvedValue({ id: "n_org" });

		await fanOut.aiUsageThreshold({ ...orgArgs });

		// 3 unique recipients (creator is in the admin list, deduped).
		expect(db.notification.create).toHaveBeenCalledTimes(3);
		const recipientIds = db.notification.create.mock.calls
			.map((c) => c[0].data.userId)
			.sort();
		expect(recipientIds).toEqual([
			"user-admin1",
			"user-admin2",
			"user-creator",
		]);
		// Each row carries the org slug deep-link.
		const links = new Set(
			db.notification.create.mock.calls.map((c) => c[0].data.link),
		);
		expect(Array.from(links)).toEqual([
			"/app/acme/settings/usage?limitId=lim_1",
		]);
	});

	it("queries members with role: { in: ['owner', 'admin'] }", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.member.findMany.mockResolvedValue([]);
		db.user.findUnique.mockResolvedValue({
			id: "user-creator",
			email: "creator@example.com",
			locale: null,
		});
		db.organization.findUnique.mockResolvedValue({ slug: "acme" });
		db.notification.create.mockResolvedValue({ id: "n_org_solo" });

		await fanOut.aiUsageThreshold({ ...orgArgs });

		expect(db.member.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: "org-1",
					role: { in: ["owner", "admin"] },
				}),
			}),
		);
	});
});

describe("fanOut.aiUsageThreshold — dedup + 80/100 independence", () => {
	it("uses identical dedupeKey on repeat call (DB index then collapses)", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: "en",
		});
		db.notification.create.mockResolvedValue({ id: "n_dup" });

		await fanOut.aiUsageThreshold({ ...baseArgs });
		await fanOut.aiUsageThreshold({ ...baseArgs });

		expect(db.notification.create).toHaveBeenCalledTimes(2);
		const keys = db.notification.create.mock.calls.map(
			(c) => c[0].data.dedupeKey,
		);
		// Both calls produced the same dedupeKey — the DB partial unique
		// index then coalesces the second insert (validated separately by
		// the index test).
		expect(keys).toEqual([
			"aiUsageLimit:lim_1:2026-05-14T00:00:00.000Z:80",
			"aiUsageLimit:lim_1:2026-05-14T00:00:00.000Z:80",
		]);
	});

	it("80% and 100% for the same limit + recipient produce different dedupeKeys", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: null,
		});
		db.notification.create.mockResolvedValue({ id: "n_thresh" });

		await fanOut.aiUsageThreshold({ ...baseArgs, threshold: 80 });
		await fanOut.aiUsageThreshold({
			...baseArgs,
			threshold: 100,
			used: BigInt(10000),
		});

		expect(db.notification.create).toHaveBeenCalledTimes(2);
		const keys = db.notification.create.mock.calls.map(
			(c) => c[0].data.dedupeKey,
		);
		expect(keys).toEqual([
			"aiUsageLimit:lim_1:2026-05-14T00:00:00.000Z:80",
			"aiUsageLimit:lim_1:2026-05-14T00:00:00.000Z:100",
		]);
		// Type also differs: WARNING vs REACHED.
		const types = db.notification.create.mock.calls.map(
			(c) => c[0].data.type,
		);
		expect(types).toEqual([
			NotificationType.AI_USAGE_LIMIT_WARNING,
			NotificationType.AI_USAGE_LIMIT_REACHED,
		]);
	});
});

describe("fanOut.aiUsageThreshold — failure isolation", () => {
	it("email send failure does NOT abort the in-app notification creation", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: "en",
		});
		db.notification.create.mockResolvedValue({ id: "n_email_fail" });
		const sendEmail = await getMockSendEmail();
		sendEmail.mockRejectedValue(new Error("smtp down"));

		await expect(
			fanOut.aiUsageThreshold({ ...baseArgs }),
		).resolves.toBeUndefined();
		// Notification was still created even though email blew up.
		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("recipient-resolution DB failure is logged + swallowed", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockRejectedValue(new Error("db down"));

		await expect(
			fanOut.aiUsageThreshold({ ...baseArgs }),
		).resolves.toBeUndefined();
		// No notification rows attempted because we never resolved a recipient.
		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("zero recipients short-circuits without error", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue(null);

		await expect(
			fanOut.aiUsageThreshold({ ...baseArgs }),
		).resolves.toBeUndefined();
		expect(db.notification.create).not.toHaveBeenCalled();
	});
});

describe("fanOut.aiUsageThreshold — email payload", () => {
	it("dispatches the warning template at 80%", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: "en",
		});
		db.notification.create.mockResolvedValue({ id: "n_w" });
		const sendEmail = await getMockSendEmail();

		await fanOut.aiUsageThreshold({ ...baseArgs, threshold: 80 });

		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "owner@example.com",
				templateId: "aiUsageLimitWarning",
				locale: "en",
				context: expect.objectContaining({
					limitName: "Monthly OpenAI tokens",
					dimension: "TOKENS",
					window: "MONTHLY",
					enforcement: "HARD",
					// Absolute — an email client has no base to resolve a
					// relative path against. The in-app `link` stays relative;
					// see the assertions above.
					manageLimitsUrl:
						"https://fabric.pro/app/settings/usage?limitId=lim_1",
				}),
			}),
		);
	});

	it("dispatches the reached template at 100%", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: null,
		});
		db.notification.create.mockResolvedValue({ id: "n_r" });
		const sendEmail = await getMockSendEmail();

		await fanOut.aiUsageThreshold({
			...baseArgs,
			threshold: 100,
			used: BigInt(10000),
		});

		expect(sendEmail).toHaveBeenCalledTimes(1);
		const call = sendEmail.mock.calls[0][0];
		expect(call.templateId).toBe("aiUsageLimitReached");
		// No locale field when recipient.locale is null — sendEmail picks
		// the default at runtime.
		expect("locale" in call).toBe(false);
	});

	it("formats spend dimension as USD with cents in the snippet", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.user.findUnique.mockResolvedValue({
			id: "user-owner",
			email: "owner@example.com",
			locale: "en",
		});
		db.notification.create.mockResolvedValue({ id: "n_spend" });

		// 42_180_000 micro-USD = $42.18
		await fanOut.aiUsageThreshold({
			...baseArgs,
			dimension: "SPEND_USD",
			used: BigInt(42_180_000),
			max: BigInt(50_000_000),
		});

		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.snippet).toBe("$42.18 / $50.00 used");
	});
});
