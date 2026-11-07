import {
	DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS,
	DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES,
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
} from "@repo/temporal/delivery-source-capture-contracts";
import { decryptApiKey, encryptApiKey, isEncryptedApiKey } from "@repo/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	owned: vi.fn(),
	context: vi.fn(),
	qualify: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getOwnedDeliverySlackIntegration: m.owned,
	loadDeliverySourceCaptureContext: m.context,
}));
vi.mock("@repo/connectors", async (original) => ({
	...(await original<typeof import("@repo/connectors")>()),
	qualifySlackDeliverySource: m.qualify,
}));

import {
	DELIVERY_SOURCE_ADAPTER_VERSION,
	DeliverySourceAccessError,
	encodeDeliverySourceSnapshot,
	inspectOwnedSlackDeliveryIntegration,
	loadPinnedSlackDeliveryCredentials,
	savedSlackDeliveryCredentialPairAvailable,
} from "../delivery-source-access";

const scope = {
	organizationId: "example-org",
	userId: "example-user",
	projectId: "example-project",
};
const credentials = {
	access_token: "xoxb-example-secret",
	user_access_token: "xoxp-example-secret",
	team_id: "TEXAMPLE",
};
const proof = {
	teamId: "TEXAMPLE",
	channelId: "CEXAMPLE",
	humanUserId: "UEXAMPLE",
	botId: "BEXAMPLE",
	botUserId: "UBOT",
};
function context() {
	return {
		watch: {
			id: "example-watch",
			integrationId: "example-integration",
			installationId: "TEXAMPLE",
			containerId: "CEXAMPLE",
			grantRevision: 1,
		},
		grant: {
			id: "example-grant",
			revision: 1,
			revokedAt: null,
			adapterVersion: DELIVERY_SOURCE_ADAPTER_VERSION,
			humanUserId: "UEXAMPLE",
			botId: "BEXAMPLE",
			botUserId: "UBOT",
		},
		integration: {
			id: "example-integration",
			...scope,
			isActive: true,
			provider: "SLACK",
			credentials: encryptApiKey(JSON.stringify(credentials)),
		},
	};
}
beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", "example-test-encryption-secret");
	vi.stubEnv("ENCRYPTION_ACTIVE_KEY_VERSION", "");
	vi.stubEnv("ENCRYPTION_KEYS", "");
	m.owned.mockReset();
	m.context.mockReset();
	m.qualify.mockReset().mockResolvedValue(proof);
});
afterEach(() => vi.unstubAllEnvs());
describe("strict server-only paired Slack credential access", () => {
	it("checks saved shape without network I/O or exposing token contents", () => {
		expect(
			savedSlackDeliveryCredentialPairAvailable(
				encryptApiKey(JSON.stringify(credentials)),
			),
		).toBe(true);
		expect(m.qualify).not.toHaveBeenCalled();
	});
	it.each([
		JSON.stringify(credentials),
		"not-ciphertext",
		null,
		"",
		undefined,
	])("refuses plaintext/malformed saved credentials %#", (value) => {
		expect(savedSlackDeliveryCredentialPairAvailable(value)).toBe(false);
	});
	it.each([
		{
			access_token: credentials.access_token,
			team_id: credentials.team_id,
		},
		{ ...credentials, user_access_token: "" },
		{ ...credentials, team_id: "TEXAMPLE\n" },
		{ ...credentials, team_id: "example-invalid-team" },
		{ ...credentials, user_access_token: credentials.access_token },
	])("never falls back to a bot or unknown team %#", (value) => {
		expect(
			savedSlackDeliveryCredentialPairAvailable(
				encryptApiKey(JSON.stringify(value)),
			),
		).toBe(false);
	});
	it("derives proof and a unique authorized label from exact owned integration", async () => {
		m.owned.mockResolvedValue(context().integration);
		m.qualify.mockResolvedValue({
			...proof,
			channelName: "example-channel",
		});
		const result = await inspectOwnedSlackDeliveryIntegration(
			scope,
			"example-integration",
			"CEXAMPLE",
		);
		expect(m.owned).toHaveBeenCalledExactlyOnceWith(
			scope,
			"example-integration",
		);
		expect(m.qualify).toHaveBeenCalledExactlyOnceWith({
			botToken: credentials.access_token,
			userToken: credentials.user_access_token,
			expectedTeamId: "TEXAMPLE",
			channelId: "CEXAMPLE",
		});
		expect(result.label).toBe("#example-channel");
		expect(result.checkedAt).toBeInstanceOf(Date);
		expect(JSON.stringify(result)).not.toMatch(/xox[bp]-/);
	});
	it("uses the exact channel identity as fallback when its display name is unavailable", async () => {
		m.owned.mockResolvedValue(context().integration);
		expect(
			(
				await inspectOwnedSlackDeliveryIntegration(
					scope,
					"example-integration",
					"CEXAMPLE",
				)
			).label,
		).toBe("Slack channel CEXAMPLE");
	});
	it("refuses a missing owned integration before provider reads", async () => {
		m.owned.mockResolvedValue(null);
		await expect(
			inspectOwnedSlackDeliveryIntegration(
				scope,
				"example-integration",
				"CEXAMPLE",
			),
		).rejects.toBeInstanceOf(DeliverySourceAccessError);
		expect(m.qualify).not.toHaveBeenCalled();
	});
	it("returns only exact pinned adapter selectors to server callers", async () => {
		m.context.mockResolvedValue(context());
		const loaded = await loadPinnedSlackDeliveryCredentials(
			scope,
			"example-watch",
			true,
		);
		expect(m.context).toHaveBeenCalledExactlyOnceWith(
			scope,
			"example-watch",
			true,
		);
		expect(loaded.adapterInput).toEqual({
			botToken: credentials.access_token,
			userToken: credentials.user_access_token,
			expectedTeamId: "TEXAMPLE",
			channelId: "CEXAMPLE",
			expectedHumanUserId: "UEXAMPLE",
			expectedBotId: "BEXAMPLE",
		});
	});
	it.each([
		"wrong-team",
		"revoked",
		"revision",
		"adapter",
		"owner",
		"org",
		"integration",
		"disabled",
		"provider",
	])("refuses changed saved credential/grant binding: %s", async (kind) => {
		const value = context();
		if (kind === "wrong-team") {
			value.watch.installationId = "TOTHER";
		}
		if (kind === "revoked") {
			Object.assign(value.grant, { revokedAt: new Date() });
		}
		if (kind === "revision") {
			value.grant.revision = 2;
		}
		if (kind === "adapter") {
			value.grant.adapterVersion = "example-unknown-adapter";
		}
		if (kind === "owner") {
			value.integration.userId = "example-other-user";
		}
		if (kind === "org") {
			value.integration.organizationId = "example-other-org";
		}
		if (kind === "integration") {
			value.integration.id = "example-other-integration";
		}
		if (kind === "disabled") {
			value.integration.isActive = false;
		}
		if (kind === "provider") {
			value.integration.provider = "TEAMS";
		}
		m.context.mockResolvedValue(value);
		await expect(
			loadPinnedSlackDeliveryCredentials(scope, "example-watch"),
		).rejects.toBeInstanceOf(DeliverySourceAccessError);
		expect(m.qualify).not.toHaveBeenCalled();
	});
	it("hashes deterministic selected snapshot bytes independently of unrelated provider fields", () => {
		const message = {
			externalItemId: "1730000000.000001",
			revision: { kind: "DECIMAL" as const, value: "1730000000.000002" },
			text: "Example private source text",
			occurredAt: "2024-10-27T03:33:20.000Z",
			hasReplies: false,
		};
		const first = encodeDeliverySourceSnapshot(message);
		const second = encodeDeliverySourceSnapshot({ ...message });
		expect(first).toEqual(second);
		expect(JSON.parse(first.payload)).toEqual({
			version: 1,
			provider: "SLACK",
			externalItemId: message.externalItemId,
			revision: message.revision,
			text: message.text,
			hasReplies: false,
		});
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(
			encodeDeliverySourceSnapshot({
				...message,
				text: "Example changed text",
			}).digest,
		).not.toBe(first.digest);
	});
	it("canonicalizes equivalent decimal revisions before evidence identity hashing", () => {
		const message = {
			externalItemId: "1730000000.000001",
			revision: { kind: "DECIMAL" as const, value: "1730000000.100000" },
			text: "Example private text",
			occurredAt: "2024-10-27T03:33:20.000Z",
			hasReplies: false,
		};
		expect(encodeDeliverySourceSnapshot(message)).toEqual(
			encodeDeliverySourceSnapshot({
				...message,
				revision: { kind: "DECIMAL", value: "1730000000.1" },
			}),
		);
	});
	it.each([false, true])(
		"fits worst legal escaped text in the actual cipher storage ceiling (rotation=%s)",
		(rotation) => {
			if (rotation) {
				vi.stubEnv(
					"ENCRYPTION_ACTIVE_KEY_VERSION",
					"example_rotation_v1",
				);
				vi.stubEnv(
					"ENCRYPTION_KEYS",
					JSON.stringify({
						example_rotation_v1:
							"example-rotation-encryption-secret",
					}),
				);
			}
			const text = `${"\u0000".repeat(DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES - 1)}x`;
			const message = {
				externalItemId: "253402300798.999999999",
				revision: {
					kind: "DECIMAL" as const,
					value: "253402300798.999999999",
				},
				text,
				occurredAt: "9999-12-31T23:59:58.999Z",
				hasReplies: true,
			};
			const snapshot = encodeDeliverySourceSnapshot(message);
			expect(
				Buffer.byteLength(snapshot.payload, "utf8"),
			).toBeLessThanOrEqual(DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES);
			const ciphertext = encryptApiKey(snapshot.payload);
			expect(isEncryptedApiKey(ciphertext)).toBe(true);
			expect(ciphertext.length).toBeLessThanOrEqual(
				DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS,
			);
			expect(decryptApiKey(ciphertext)).toBe(snapshot.payload);
		},
	);
	it("rejects arbitrary oversized encoder inputs unreachable through the bounded adapter", () => {
		const message = {
			externalItemId: "1730000000.000001",
			revision: { kind: "DECIMAL" as const, value: "1730000000.000002" },
			text: "Example source text",
			occurredAt: "2024-10-27T03:33:20.000Z",
			hasReplies: false,
		};
		for (const invalid of [
			{
				...message,
				text: "x".repeat(DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES + 1),
			},
			{
				...message,
				text: "😀".repeat(
					DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES / 4 + 1,
				),
			},
			{ ...message, externalItemId: "1".repeat(1024) },
			{
				...message,
				revision: { kind: "OPAQUE" as const, value: "x".repeat(512) },
			},
		]) {
			expect(() => encodeDeliverySourceSnapshot(invalid)).toThrow(
				DeliverySourceAccessError,
			);
		}
	});
});
