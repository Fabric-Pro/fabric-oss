/**
 * Audit and masking for search-provider credential writes (Fizzy #3074).
 *
 * Saving a third-party provider key records who did it without recording the
 * key, its ciphertext, its mask or the raw endpoint, and the update response
 * masks the plaintext key exactly as the get procedures do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertUser = vi.fn();
const upsertOrg = vi.fn();
const getOrganizationById = vi.fn();
const verifyMembership = vi.fn();
const recordAudit = vi.fn();
const decryptApiKey = vi.fn();

vi.mock("@repo/database", () => ({
	upsertUserSearchProvider: (...a: unknown[]) => upsertUser(...a),
	upsertOrganizationSearchProvider: (...a: unknown[]) => upsertOrg(...a),
	getOrganizationById: (...a: unknown[]) => getOrganizationById(...a),
	getOrganizationSearchProvider: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (key: string) => `encrypted:${key}`,
	decryptApiKey: (value: string) => decryptApiKey(value),
	isValidApiKeyFormat: (key: string) => key.length >= 8,
	maskApiKey: (key: string) => `${key.slice(0, 2)}***`,
}));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...a: unknown[]) => verifyMembership(...a),
}));
vi.mock("../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => recordAudit(...a),
}));
vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		protectedProcedure: builder,
		requirePermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{ provider: { maskedApiKey: string | null } }>;

const handlerOf = (procedure: unknown) =>
	(procedure as { handler: Handler }).handler;

const KEY = "sk-secretvalue-123456";
const context = { user: { id: "u1" } };
const PATH_SECRET_ENDPOINT =
	"https://search.example.com/api/pathsecret-abc123/search";

function row(encryptedApiKey: string | null, endpoint: string | null = null) {
	return {
		id: "row-1",
		providerName: "tavily",
		encryptedApiKey,
		endpoint,
		isDefault: false,
		priority: 0,
		enabled: true,
	};
}

async function updateOrg(input: Record<string, unknown>) {
	const { updateOrganizationProvider } = await import(
		"../procedures/update-organization-provider"
	);
	return handlerOf(updateOrganizationProvider)({
		input: { organizationId: "org-1", providerName: "tavily", ...input },
		context,
	});
}

async function updateUser(input: Record<string, unknown>) {
	const { updateUserProvider } = await import(
		"../procedures/update-user-provider"
	);
	return handlerOf(updateUserProvider)({
		input: { providerName: "tavily", ...input },
		context,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// Internal endpoints are only refused outside development and test.
	vi.stubEnv("NODE_ENV", "production");
	getOrganizationById.mockResolvedValue({ id: "org-1" });
	verifyMembership.mockResolvedValue({ role: "admin" });
	decryptApiKey.mockImplementation((v: string) =>
		v.replace("encrypted:", ""),
	);
	upsertOrg.mockResolvedValue(row(`encrypted:${KEY}`));
	upsertUser.mockResolvedValue(row(`encrypted:${KEY}`));
});

describe("organization search-provider update audit", () => {
	it("records org.integration.config_updated with keyChanged true", async () => {
		await updateOrg({ apiKey: KEY });
		expect(recordAudit).toHaveBeenCalledTimes(1);
		const [ctx, event] = recordAudit.mock.calls[0];
		expect(ctx).toBe(context);
		expect(event).toMatchObject({
			action: "org.integration.config_updated",
			category: "org",
			organizationId: "org-1",
			resource: { type: "integration", id: "tavily", name: "tavily" },
			metadata: { providerName: "tavily", keyChanged: true },
		});
	});

	it("records keyChanged false when no key is supplied", async () => {
		await updateOrg({ enabled: false });
		expect(recordAudit.mock.calls[0][1].metadata.keyChanged).toBe(false);
	});

	it("never records the key, its ciphertext or its mask", async () => {
		await updateOrg({ apiKey: KEY });
		const serialized = JSON.stringify(recordAudit.mock.calls[0]);
		for (const secret of [
			KEY,
			"secretvalue",
			`encrypted:${KEY}`,
			"sk***",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("records no endpoint text when the request supplies a path-secret endpoint", async () => {
		upsertOrg.mockResolvedValue(
			row(`encrypted:${KEY}`, PATH_SECRET_ENDPOINT),
		);
		await updateOrg({ apiKey: KEY, endpoint: PATH_SECRET_ENDPOINT });
		const serialized = JSON.stringify(recordAudit.mock.calls[0]);
		expect(serialized).not.toContain("pathsecret");
		expect(serialized).not.toContain("search.example.com");
		expect(recordAudit.mock.calls[0][1].metadata).toMatchObject({
			endpointSupplied: true,
			endpointConfigured: true,
		});
	});

	it("records no endpoint text when the update omits it but the stored row holds one", async () => {
		upsertOrg.mockResolvedValue(
			row(`encrypted:${KEY}`, PATH_SECRET_ENDPOINT),
		);
		await updateOrg({ enabled: true });
		const serialized = JSON.stringify(recordAudit.mock.calls[0]);
		expect(serialized).not.toContain("pathsecret");
		expect(serialized).not.toContain("search.example.com");
		expect(recordAudit.mock.calls[0][1].metadata).toMatchObject({
			endpointSupplied: false,
			endpointConfigured: true,
		});
	});

	it("records nothing when the upsert rejects, and only after it resolves", async () => {
		upsertOrg.mockRejectedValue(new Error("db down"));
		await expect(updateOrg({ apiKey: KEY })).rejects.toThrow("db down");
		expect(recordAudit).not.toHaveBeenCalled();

		let release: (v: unknown) => void = () => {};
		upsertOrg.mockReturnValue(
			new Promise((r) => {
				release = r;
			}),
		);
		const pending = updateOrg({ apiKey: KEY });
		await new Promise((r) => setTimeout(r, 10));
		expect(upsertOrg).toHaveBeenCalledTimes(2);
		expect(recordAudit).not.toHaveBeenCalled();
		release(row(`encrypted:${KEY}`));
		await pending;
		expect(recordAudit).toHaveBeenCalledTimes(1);
	});

	it("records nothing when validation rejects the request", async () => {
		await expect(
			updateOrg({ providerName: "nope", apiKey: KEY }),
		).rejects.toThrow(/Invalid provider name/);
		await expect(updateOrg({ apiKey: "short" })).rejects.toThrow(
			/Invalid API key format/,
		);
		await expect(
			updateOrg({ apiKey: KEY, endpoint: "http://127.0.0.1/" }),
		).rejects.toThrow(/endpoint rejected/);
		expect(upsertOrg).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
	});

	it("masks the plaintext key in the response, not the ciphertext", async () => {
		const result = await updateOrg({ apiKey: KEY });
		expect(result.provider.maskedApiKey).toBe("sk***");
	});

	it("masks the decrypted stored key when none was supplied", async () => {
		const result = await updateOrg({ enabled: true });
		expect(decryptApiKey).toHaveBeenCalledWith(`encrypted:${KEY}`);
		expect(result.provider.maskedApiKey).toBe("sk***");
	});

	it("falls back to *** when the stored key cannot be decrypted, null when none", async () => {
		decryptApiKey.mockImplementation(() => {
			throw new Error("bad ciphertext");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await updateOrg({ enabled: true })).provider.maskedApiKey).toBe(
			"***",
		);
		upsertOrg.mockResolvedValue(row(null));
		expect((await updateOrg({ enabled: true })).provider.maskedApiKey).toBe(
			null,
		);
	});
});

describe("user search-provider update audit", () => {
	it("records account.integration.config_updated in the personal scope", async () => {
		await updateUser({ apiKey: KEY });
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit.mock.calls[0][1]).toMatchObject({
			action: "account.integration.config_updated",
			category: "account",
			organizationId: null,
			resource: { type: "integration", id: "tavily", name: "tavily" },
			metadata: { providerName: "tavily", keyChanged: true },
		});
	});

	it("never records the key or its ciphertext", async () => {
		await updateUser({ apiKey: KEY });
		const serialized = JSON.stringify(recordAudit.mock.calls[0]);
		for (const secret of [
			KEY,
			"secretvalue",
			`encrypted:${KEY}`,
			"sk***",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("records nothing when validation rejects the request", async () => {
		await expect(updateUser({ providerName: "nope" })).rejects.toThrow(
			/Invalid provider name/,
		);
		await expect(updateUser({ apiKey: "short" })).rejects.toThrow(
			/Invalid API key format/,
		);
		expect(upsertUser).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
	});

	it("records no endpoint text, supplied or stored", async () => {
		upsertUser.mockResolvedValue(
			row(`encrypted:${KEY}`, PATH_SECRET_ENDPOINT),
		);
		await updateUser({ apiKey: KEY, endpoint: PATH_SECRET_ENDPOINT });
		await updateUser({ enabled: true });
		for (const call of recordAudit.mock.calls) {
			const serialized = JSON.stringify(call);
			expect(serialized).not.toContain("pathsecret");
			expect(serialized).not.toContain("search.example.com");
		}
		expect(recordAudit.mock.calls[0][1].metadata).toMatchObject({
			endpointSupplied: true,
			endpointConfigured: true,
		});
		expect(recordAudit.mock.calls[1][1].metadata).toMatchObject({
			endpointSupplied: false,
			endpointConfigured: true,
		});
	});

	it("records nothing when the upsert rejects, and only after it resolves", async () => {
		upsertUser.mockRejectedValue(new Error("db down"));
		await expect(updateUser({ apiKey: KEY })).rejects.toThrow("db down");
		expect(recordAudit).not.toHaveBeenCalled();

		let release: (v: unknown) => void = () => {};
		upsertUser.mockReturnValue(
			new Promise((r) => {
				release = r;
			}),
		);
		const pending = updateUser({ apiKey: KEY });
		await new Promise((r) => setTimeout(r, 10));
		expect(upsertUser).toHaveBeenCalledTimes(2);
		expect(recordAudit).not.toHaveBeenCalled();
		release(row(`encrypted:${KEY}`));
		await pending;
		expect(recordAudit).toHaveBeenCalledTimes(1);
	});

	it("masks the plaintext key in the response, not the ciphertext", async () => {
		expect((await updateUser({ apiKey: KEY })).provider.maskedApiKey).toBe(
			"sk***",
		);
		expect(
			(await updateUser({ enabled: true })).provider.maskedApiKey,
		).toBe("sk***");
	});
});
