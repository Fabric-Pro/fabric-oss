/**
 * get / update / rotate delivery-preferences procedures.
 *
 * The handlers must:
 *  - return decrypted webhook URL + `hasWebhookSecret`, but NEVER the secret
 *    itself (get);
 *  - mint a signing secret exactly once — the first time webhook is enabled
 *    without one — and return it as `generatedWebhookSecret` (update);
 *  - block enabling webhook with no endpoint (update) and rotating with no
 *    endpoint (rotate);
 *  - encrypt URL + secret before persisting.
 *
 * Mocks the query layer + encryption at the package boundary, and the oRPC
 * procedure chain so the handler is callable as a plain function.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDeliveryPrefs, upsertDeliveryPrefs } = vi.hoisted(() => ({
	getDeliveryPrefs: vi.fn(),
	upsertDeliveryPrefs: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getDeliveryPreferences: getDeliveryPrefs,
	upsertDeliveryPreferences: upsertDeliveryPrefs,
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc:${value}`,
	decryptApiKey: (value: string) =>
		value.startsWith("enc:") ? value.slice(4) : value,
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { getDeliveryPreferencesProcedure } from "../../procedures/get-delivery-preferences";
import { rotateWebhookSecretProcedure } from "../../procedures/rotate-webhook-secret";
import { updateDeliveryPreferencesProcedure } from "../../procedures/update-delivery-preferences";

const OFF = {
	emailEnabled: false,
	webhookEnabled: false,
	encryptedWebhookUrl: null,
	encryptedWebhookSecret: null,
};

const ctx = { context: { user: { id: "u1" }, session: {} } } as const;

beforeEach(() => {
	vi.clearAllMocks();
	getDeliveryPrefs.mockResolvedValue({ ...OFF });
	upsertDeliveryPrefs.mockImplementation(async (_id, input) => ({
		...OFF,
		...input,
	}));
});

describe("getDeliveryPreferencesProcedure", () => {
	it("decrypts the webhook URL and never returns the secret (AC-9)", async () => {
		getDeliveryPrefs.mockResolvedValue({
			emailEnabled: true,
			webhookEnabled: true,
			encryptedWebhookUrl: "enc:https://example.com/hook",
			encryptedWebhookSecret: "enc:whsec_abc",
		});
		const result = await (getDeliveryPreferencesProcedure as any)(ctx);
		expect(result).toEqual({
			emailEnabled: true,
			webhookEnabled: true,
			webhookUrl: "https://example.com/hook",
			hasWebhookSecret: true,
		});
		expect(result).not.toHaveProperty("webhookSecret");
		expect(result).not.toHaveProperty("encryptedWebhookSecret");
	});

	it("returns webhookUrl null + hasWebhookSecret false when unset (AC-1)", async () => {
		const result = await (getDeliveryPreferencesProcedure as any)(ctx);
		expect(result).toEqual({
			emailEnabled: false,
			webhookEnabled: false,
			webhookUrl: null,
			hasWebhookSecret: false,
		});
	});
});

describe("updateDeliveryPreferencesProcedure", () => {
	it("mints + returns a signing secret once when webhook is first enabled (AC-3)", async () => {
		const result = await (updateDeliveryPreferencesProcedure as any)({
			...ctx,
			input: {
				webhookEnabled: true,
				webhookUrl: "https://example.com/hook",
			},
		});
		// secret generated, returned once, and persisted encrypted
		expect(result.generatedWebhookSecret).toMatch(/^whsec_/);
		const upsertArg = upsertDeliveryPrefs.mock.calls[0][1];
		expect(upsertArg.encryptedWebhookUrl).toBe(
			"enc:https://example.com/hook",
		);
		expect(upsertArg.encryptedWebhookSecret).toMatch(/^enc:whsec_/);
	});

	it("does NOT regenerate a secret when one already exists", async () => {
		getDeliveryPrefs.mockResolvedValue({
			...OFF,
			encryptedWebhookUrl: "enc:https://example.com/hook",
			encryptedWebhookSecret: "enc:whsec_existing",
		});
		const result = await (updateDeliveryPreferencesProcedure as any)({
			...ctx,
			input: { webhookEnabled: true },
		});
		expect(result.generatedWebhookSecret).toBeUndefined();
		expect(
			upsertDeliveryPrefs.mock.calls[0][1].encryptedWebhookSecret,
		).toBeUndefined();
	});

	it("blocks enabling webhook with no endpoint configured", async () => {
		await expect(
			(updateDeliveryPreferencesProcedure as any)({
				...ctx,
				input: { webhookEnabled: true },
			}),
		).rejects.toThrow(/webhook URL is required/i);
		expect(upsertDeliveryPrefs).not.toHaveBeenCalled();
	});

	it("toggling email never touches webhook config (AC-7)", async () => {
		await (updateDeliveryPreferencesProcedure as any)({
			...ctx,
			input: { emailEnabled: true },
		});
		expect(upsertDeliveryPrefs.mock.calls[0][1]).toEqual({
			emailEnabled: true,
		});
	});
});

describe("rotateWebhookSecretProcedure", () => {
	it("returns a fresh secret and persists it encrypted", async () => {
		getDeliveryPrefs.mockResolvedValue({
			...OFF,
			encryptedWebhookUrl: "enc:https://example.com/hook",
			encryptedWebhookSecret: "enc:whsec_old",
		});
		const result = await (rotateWebhookSecretProcedure as any)(ctx);
		expect(result.webhookSecret).toMatch(/^whsec_/);
		expect(
			upsertDeliveryPrefs.mock.calls[0][1].encryptedWebhookSecret,
		).toMatch(/^enc:whsec_/);
	});

	it("refuses to rotate when no webhook URL is configured", async () => {
		await expect(
			(rotateWebhookSecretProcedure as any)(ctx),
		).rejects.toThrow(/configure a webhook URL/i);
		expect(upsertDeliveryPrefs).not.toHaveBeenCalled();
	});
});
