/**
 * Unit tests for the `notification-preferences` queries module.
 *
 * Mocks at the Prisma client boundary; exercises default-on semantics,
 * org-id normalization, the category→toggle mapping, and the batched
 * recipient filter without touching a live database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, upsert, findMany } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	// Re-export the real NotificationCategory enum shape used by the module.
	NotificationCategory: {
		MENTION: "MENTION",
		REPLY: "REPLY",
		ASSIGNMENT: "ASSIGNMENT",
		STATUS: "STATUS",
		AGENT: "AGENT",
		PROJECT: "PROJECT",
		SYSTEM: "SYSTEM",
		BILLING: "BILLING",
		CONTEXT_INDEXING_STARTED: "CONTEXT_INDEXING_STARTED",
		CONTEXT_INDEXING_COMPLETED: "CONTEXT_INDEXING_COMPLETED",
	},
	db: {
		notificationPreference: {
			findUnique,
			upsert,
			findMany,
		},
	},
}));

import type { NotificationPreferenceFlags } from "../prisma/queries/notification-preferences";
import {
	CATEGORY_TO_TOGGLE,
	DEFAULT_NOTIFICATION_DISPLAY,
	DEFAULT_NOTIFICATION_PREFERENCES,
	EMAIL_FLAGS,
	getEnabledRecipientsForCategory,
	getNotificationDisplayPreference,
	getNotificationPreferences,
	isCategoryEnabled,
	upsertNotificationDisplayPreference,
	upsertNotificationPreferences,
} from "../prisma/queries/notification-preferences";

describe("notification-preferences queries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findUnique.mockResolvedValue(null);
		upsert.mockResolvedValue({});
		findMany.mockResolvedValue([]);
	});

	describe("isCategoryEnabled", () => {
		it("returns the mapped flag for curated categories", () => {
			const flags = {
				...DEFAULT_NOTIFICATION_PREFERENCES,
				mentions: false,
			};
			expect(isCategoryEnabled(flags, "MENTION")).toBe(false);
			expect(isCategoryEnabled(flags, "REPLY")).toBe(true);
			expect(isCategoryEnabled(flags, "PROJECT")).toBe(true);
		});

		it("treats unmapped categories as always-on regardless of flags", () => {
			// Derived rather than listed: the claim under test is that these
			// categories ignore EVERY flag, so a hand-written literal quietly
			// narrows the assertion each time a flag is added.
			const allOff = Object.fromEntries(
				Object.keys(DEFAULT_NOTIFICATION_PREFERENCES).map((key) => [
					key,
					false,
				]),
			) as NotificationPreferenceFlags;
			expect(isCategoryEnabled(allOff, "SYSTEM")).toBe(true);
			expect(isCategoryEnabled(allOff, "BILLING")).toBe(true);
			expect(isCategoryEnabled(allOff, "CONTEXT_INDEXING_STARTED")).toBe(
				true,
			);
		});

		it("does not map SYSTEM/BILLING/CONTEXT_INDEXING_* to a toggle", () => {
			expect(CATEGORY_TO_TOGGLE.SYSTEM).toBeUndefined();
			expect(CATEGORY_TO_TOGGLE.BILLING).toBeUndefined();
			expect(CATEGORY_TO_TOGGLE.CONTEXT_INDEXING_STARTED).toBeUndefined();
		});
	});

	describe("getNotificationPreferences", () => {
		it("returns all-enabled defaults when no row exists", async () => {
			const result = await getNotificationPreferences("user_a");
			expect(result).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
		});

		it("normalizes a missing organizationId to the empty-string sentinel", async () => {
			await getNotificationPreferences("user_a");
			expect(findUnique).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "",
						},
					},
				}),
			);
		});

		it("returns stored flag values when a row exists", async () => {
			findUnique.mockResolvedValue({
				mentions: false,
				replies: true,
				assignments: false,
				status: true,
				syncProject: false,
				aiAgent: true,
			});
			const result = await getNotificationPreferences("user_a");
			expect(result).toEqual({
				mentions: false,
				replies: true,
				assignments: false,
				status: true,
				syncProject: false,
				aiAgent: true,
			});
		});
	});

	describe("upsertNotificationPreferences", () => {
		it("only updates the provided flags (partial update)", async () => {
			upsert.mockResolvedValue({
				mentions: false,
				replies: true,
				assignments: true,
				status: true,
				syncProject: true,
				aiAgent: true,
			});
			await upsertNotificationPreferences("user_a", { mentions: false });
			expect(upsert).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "",
						},
					},
					update: { mentions: false },
				}),
			);
		});

		it("creates with defaults-on for omitted flags", async () => {
			upsert.mockResolvedValue({
				...DEFAULT_NOTIFICATION_PREFERENCES,
				syncProject: false,
			});
			await upsertNotificationPreferences("user_a", {
				syncProject: false,
			});
			expect(upsert).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					create: expect.objectContaining({
						userId: "user_a",
						organizationId: "",
						mentions: true,
						syncProject: false,
					}),
				}),
			);
		});
	});

	describe("getEnabledRecipientsForCategory", () => {
		it("returns all recipients for an always-on category without querying", async () => {
			const result = await getEnabledRecipientsForCategory(
				["a", "b", "c"],
				"SYSTEM",
			);
			expect(result).toEqual(new Set(["a", "b", "c"]));
			expect(findMany).not.toHaveBeenCalled();
		});

		it("returns an empty set for an empty recipient list", async () => {
			const result = await getEnabledRecipientsForCategory([], "MENTION");
			expect(result).toEqual(new Set());
			expect(findMany).not.toHaveBeenCalled();
		});

		it("includes recipients with no row (default-on) and drops explicit false", async () => {
			// b explicitly disabled mentions; a has it on; c has no row.
			findMany.mockResolvedValue([
				{ userId: "a", mentions: true },
				{ userId: "b", mentions: false },
			]);
			const result = await getEnabledRecipientsForCategory(
				["a", "b", "c"],
				"MENTION",
			);
			expect(result).toEqual(new Set(["a", "c"]));
			expect(findMany).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId: { in: ["a", "b", "c"] },
						organizationId: "",
					},
				}),
			);
		});
	});

	describe("reportEmails flag", () => {
		it("defaults reportEmails to true when no row exists", async () => {
			findUnique.mockResolvedValue(null);
			const flags = await getNotificationPreferences("u1");
			expect(flags.reportEmails).toBe(true);
			expect(DEFAULT_NOTIFICATION_PREFERENCES.reportEmails).toBe(true);
		});

		it("returns the stored reportEmails value", async () => {
			findUnique.mockResolvedValue({
				mentions: true,
				replies: true,
				assignments: true,
				status: true,
				syncProject: true,
				aiAgent: true,
				reportEmails: false,
			});
			const flags = await getNotificationPreferences("u1");
			expect(flags.reportEmails).toBe(false);
		});

		it("upserts reportEmails without clobbering other flags", async () => {
			upsert.mockResolvedValue({
				mentions: true,
				replies: true,
				assignments: true,
				status: true,
				syncProject: true,
				aiAgent: true,
				reportEmails: false,
			});
			const flags = await upsertNotificationPreferences("u1", {
				reportEmails: false,
			});
			expect(flags.reportEmails).toBe(false);
			const call = upsert.mock.calls[0][0];
			expect(call.update).toMatchObject({ reportEmails: false });
			expect(call.update).not.toHaveProperty("mentions");
		});
	});

	describe("reviewEmails flag", () => {
		it("defaults reviewEmails to true when no row exists", async () => {
			findUnique.mockResolvedValue(null);
			const flags = await getNotificationPreferences("u1");
			expect(flags.reviewEmails).toBe(true);
			expect(DEFAULT_NOTIFICATION_PREFERENCES.reviewEmails).toBe(true);
		});

		it("returns the stored reviewEmails value", async () => {
			findUnique.mockResolvedValue({
				mentions: true,
				replies: true,
				assignments: true,
				status: true,
				syncProject: true,
				aiAgent: true,
				reportEmails: true,
				reviewEmails: false,
			});
			const flags = await getNotificationPreferences("u1");
			expect(flags.reviewEmails).toBe(false);
		});

		it("upserts reviewEmails without clobbering other flags", async () => {
			upsert.mockResolvedValue({
				mentions: true,
				replies: true,
				assignments: true,
				status: true,
				syncProject: true,
				aiAgent: true,
				reportEmails: true,
				reviewEmails: false,
			});
			const flags = await upsertNotificationPreferences("u1", {
				reviewEmails: false,
			});
			expect(flags.reviewEmails).toBe(false);
			const call = upsert.mock.calls[0][0];
			expect(call.update).toMatchObject({ reviewEmails: false });
			expect(call.update).not.toHaveProperty("reportEmails");
		});

		it("classifies reviewEmails as a channel gate, not a category toggle", () => {
			// It gates the EMAIL channel only. The in-app bell for a pending
			// review must stay unconditional, which is what keeps it out of
			// CATEGORY_TO_TOGGLE — same shape as reportEmails.
			expect(DEFAULT_NOTIFICATION_PREFERENCES).toHaveProperty(
				"reviewEmails",
			);
			expect(Object.values(CATEGORY_TO_TOGGLE)).not.toContain(
				"reviewEmails",
			);
		});
	});
});

describe("display preference (stackedCardStyle)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findUnique.mockResolvedValue(null);
		upsert.mockResolvedValue({});
	});

	it("defaults to false when no row exists — opt-in, unlike the delivery flags", async () => {
		findUnique.mockResolvedValue(null);
		const display = await getNotificationDisplayPreference("u1");
		expect(display.stackedCardStyle).toBe(false);
		expect(DEFAULT_NOTIFICATION_DISPLAY.stackedCardStyle).toBe(false);
	});

	it("returns the stored value when a row exists", async () => {
		findUnique.mockResolvedValue({ stackedCardStyle: true });
		const display = await getNotificationDisplayPreference("u1");
		expect(display.stackedCardStyle).toBe(true);
	});

	it("selects only the display column, never the delivery flags", async () => {
		findUnique.mockResolvedValue({ stackedCardStyle: false });
		await getNotificationDisplayPreference("u1");
		expect(findUnique).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ select: { stackedCardStyle: true } }),
		);
	});

	it("upserts against the account-global '' row", async () => {
		upsert.mockResolvedValue({ stackedCardStyle: true });
		const result = await upsertNotificationDisplayPreference("u1", {
			stackedCardStyle: true,
		});
		expect(result).toEqual({ stackedCardStyle: true });
		expect(upsert).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				where: {
					userId_organizationId: { userId: "u1", organizationId: "" },
				},
			}),
		);
	});

	it("leaves the delivery flags untouched when creating a row for a display-only change", async () => {
		upsert.mockResolvedValue({ stackedCardStyle: true });
		await upsertNotificationDisplayPreference("u1", {
			stackedCardStyle: true,
		});
		const call = upsert.mock.calls[0]?.[0] as {
			create: Record<string, unknown>;
			update: Record<string, unknown>;
		};
		// Delivery flags are absent from both branches — the column defaults in
		// the schema keep a newly created row all-enabled.
		for (const flag of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
			expect(call.create).not.toHaveProperty(flag);
			expect(call.update).not.toHaveProperty(flag);
		}
	});
});

describe("delivery-domain guard", () => {
	it("every NotificationPreferenceFlags member gates delivery on some channel", () => {
		// The type is consumed by the write-time delivery filter. A member that
		// gates no delivery (e.g. a display-style flag) must never be added —
		// CATEGORY_TO_TOGGLE's value type would accept it and a mapping typo
		// would then compile clean. Display preferences live in
		// NotificationDisplayPreference instead.
		const categoryGates = new Set<string>(
			Object.values(CATEGORY_TO_TOGGLE),
		);
		// Built from the production flag list, not a literal copied here — a key added to
		// EMAIL_FLAGS without also gating a channel would otherwise satisfy this test by editing
		// the test, which is exactly the gap this guard exists to close.
		const channelGates = new Set<string>(EMAIL_FLAGS);
		for (const key of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
			expect(categoryGates.has(key) || channelGates.has(key)).toBe(true);
		}
	});

	it("every delivery flag defaults to true, and the display flag does not", () => {
		for (const value of Object.values(DEFAULT_NOTIFICATION_PREFERENCES)) {
			expect(value).toBe(true);
		}
		expect(DEFAULT_NOTIFICATION_DISPLAY.stackedCardStyle).toBe(false);
	});

	it("stackedCardStyle is not a member of the delivery flags", () => {
		expect(DEFAULT_NOTIFICATION_PREFERENCES).not.toHaveProperty(
			"stackedCardStyle",
		);
	});
});
