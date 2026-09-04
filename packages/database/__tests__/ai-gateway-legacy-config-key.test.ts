/**
 * The legacy credential location: a key still stored in `config.apiKey` rather
 * than the `encrypted_api_key` column.
 *
 * `readProviderRowCredentials` coalesces the two, preferring the column and
 * falling back to the JSON blob, so rows written before the column existed keep
 * resolving. That fallback had no test: the service-principal half of the rule
 * is pinned by `ai-gateway-service-principal.test.ts`, but nothing exercised
 * this half, and the only fixture shaped like it in the repo lived inside a
 * mock that restates the rule rather than calling it
 * (`packages/api/.../get-status-resolvability.test.ts`).
 *
 * That mattered more than an ordinary coverage gap, because that mock's comment
 * claimed this branch was pinned here. A change to the real coalescing would
 * have left both suites green while the status endpoint and the resolver
 * quietly disagreed about whether a legacy tenant is configured — which is the
 * one thing `canResolveProvider` exists to prevent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { orgFindFirst, userFindFirst } = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		cloudProviderConfig: { findFirst: orgFindFirst },
		userCloudProviderConfig: { findFirst: userFindFirst },
	},
}));

vi.mock("@repo/config", () => ({
	// Platform gateway off, so an unresolved tenant lands on the empty config
	// instead of the deployment key and cannot mask a failure here.
	config: {
		ai: { enableGateway: false, gatewayApiKey: null, enabledProviders: [] },
	},
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

import {
	getAiProviderApiKey,
	readProviderRowCredentials,
} from "../prisma/queries/ai-gateway";

/** A row from before `encrypted_api_key` existed: the key is in the blob. */
const legacyRow = {
	id: "cpc_legacy",
	provider: "OPENAI",
	encryptedApiKey: null,
	clientId: null,
	encryptedClientSecret: null,
	config: { apiKey: "encrypted:sk-legacy" },
};

beforeEach(() => {
	vi.clearAllMocks();
	orgFindFirst.mockResolvedValue(null);
	userFindFirst.mockResolvedValue(null);
});

describe("readProviderRowCredentials — the legacy config.apiKey fallback", () => {
	it("reads a key that only exists in config.apiKey", () => {
		const result = readProviderRowCredentials(legacyRow);

		expect(result.hasCredentials).toBe(true);
		expect(result.apiKey).toBe("encrypted:sk-legacy");
	});

	it("prefers the column when a row carries both", () => {
		// Migration writes the column and leaves the blob in place, so a row can
		// hold two values. The column is the current one.
		const result = readProviderRowCredentials({
			...legacyRow,
			encryptedApiKey: "encrypted:sk-column",
		});

		expect(result.apiKey).toBe("encrypted:sk-column");
	});

	it("reports no credentials when neither location holds one", () => {
		const result = readProviderRowCredentials({
			...legacyRow,
			config: {},
		});

		expect(result.hasCredentials).toBe(false);
		expect(result.apiKey).toBeNull();
	});

	it("survives a null config rather than throwing", () => {
		// `config` is nullable in the schema; a row saved without one must read
		// as unconfigured, not crash the resolver for the whole tenant.
		const result = readProviderRowCredentials({
			...legacyRow,
			config: null,
		});

		expect(result.hasCredentials).toBe(false);
	});
});

describe("the resolver honours the legacy location end to end", () => {
	it("resolves an organization whose key is still in config.apiKey", async () => {
		orgFindFirst.mockResolvedValue(legacyRow);

		const resolved = await getAiProviderApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(resolved.apiKey).toBe("encrypted:sk-legacy");
		expect(resolved.source).toBe("organization");
	});

	it("refuses when the blob holds no key either", async () => {
		orgFindFirst.mockResolvedValue({ ...legacyRow, config: {} });

		const resolved = await getAiProviderApiKey({
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(resolved.apiKey).toBeNull();
		expect(resolved.source).toBeNull();
	});
});
