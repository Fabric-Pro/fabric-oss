/**
 * Unit tests for the `notification-delivery-preferences` queries module.
 *
 * Mocks at the Prisma client boundary. Exercises the opt-IN default (a missing
 * row means in-app only — every external channel off, AC-1), org-id
 * normalization, and the partial-update contract of the upsert.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, upsert } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		notificationDeliveryPreference: { findUnique, upsert },
	},
}));

import {
	DEFAULT_NOTIFICATION_DELIVERY_PREFERENCES,
	getDeliveryPreferences,
	upsertDeliveryPreferences,
} from "../prisma/queries/notification-delivery-preferences";

describe("notification-delivery-preferences queries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findUnique.mockResolvedValue(null);
		upsert.mockResolvedValue({});
	});

	describe("getDeliveryPreferences", () => {
		it("returns the in-app-only default when no row exists (AC-1)", async () => {
			const result = await getDeliveryPreferences("u1");
			expect(result).toEqual(DEFAULT_NOTIFICATION_DELIVERY_PREFERENCES);
			expect(result.emailEnabled).toBe(false);
			expect(result.webhookEnabled).toBe(false);
			expect(result.encryptedWebhookUrl).toBeNull();
			expect(result.encryptedWebhookSecret).toBeNull();
		});

		it("targets the account-global '' row keyed on the user id", async () => {
			await getDeliveryPreferences("u1");
			expect(findUnique.mock.calls[0][0].where).toEqual({
				userId_organizationId: { userId: "u1", organizationId: "" },
			});
		});

		it("returns persisted channel flags + encrypted config when a row exists", async () => {
			findUnique.mockResolvedValue({
				emailEnabled: true,
				webhookEnabled: true,
				encryptedWebhookUrl: "enc-url",
				encryptedWebhookSecret: "enc-secret",
			});
			const result = await getDeliveryPreferences("u1");
			expect(result).toEqual({
				emailEnabled: true,
				webhookEnabled: true,
				encryptedWebhookUrl: "enc-url",
				encryptedWebhookSecret: "enc-secret",
			});
		});
	});

	describe("upsertDeliveryPreferences", () => {
		it("only writes the provided fields (partial-update contract)", async () => {
			upsert.mockResolvedValue({
				emailEnabled: true,
				webhookEnabled: false,
				encryptedWebhookUrl: null,
				encryptedWebhookSecret: null,
			});
			await upsertDeliveryPreferences("u1", { emailEnabled: true });
			const call = upsert.mock.calls[0][0];
			expect(call.where).toEqual({
				userId_organizationId: { userId: "u1", organizationId: "" },
			});
			// update only carries emailEnabled — webhook fields untouched (AC-7).
			expect(call.update).toEqual({ emailEnabled: true });
			expect(call.create.emailEnabled).toBe(true);
			expect(call.create.webhookEnabled).toBe(false);
		});

		it("persists encrypted webhook url + secret when provided", async () => {
			upsert.mockResolvedValue({
				emailEnabled: false,
				webhookEnabled: true,
				encryptedWebhookUrl: "enc-url",
				encryptedWebhookSecret: "enc-secret",
			});
			await upsertDeliveryPreferences("u1", {
				webhookEnabled: true,
				encryptedWebhookUrl: "enc-url",
				encryptedWebhookSecret: "enc-secret",
			});
			expect(upsert.mock.calls[0][0].update).toEqual({
				webhookEnabled: true,
				encryptedWebhookUrl: "enc-url",
				encryptedWebhookSecret: "enc-secret",
			});
		});

		it("clears a stored value when passed null explicitly", async () => {
			upsert.mockResolvedValue({
				emailEnabled: false,
				webhookEnabled: false,
				encryptedWebhookUrl: null,
				encryptedWebhookSecret: null,
			});
			await upsertDeliveryPreferences("u1", {
				encryptedWebhookUrl: null,
			});
			expect(upsert.mock.calls[0][0].update).toEqual({
				encryptedWebhookUrl: null,
			});
		});
	});
});
