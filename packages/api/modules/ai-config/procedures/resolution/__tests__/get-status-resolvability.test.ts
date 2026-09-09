/**
 * Tests for the two CALLER-scoped fields on the AI config status procedure:
 * `canResolveProvider` and `resolvedEmbeddingProvider`.
 *
 * The notice this field feeds and the refusal a user actually gets have to
 * agree on what "configured" means, and `isConfigured` does not: it counts the
 * organization's enabled rows and nothing else. That diverges from the resolver
 * in BOTH directions (Fizzy #1875, R11):
 *
 * - An enabled row saved without a credential is counted as configured, while
 *   the resolver returns nothing for it — so an organization could be refused
 *   AI with no notice explaining why.
 * - A member's own personal key resolves inside an organization that has none,
 *   while `isConfigured` never looks at it — so someone whose AI works was
 *   told it could not run.
 *
 * `isConfigured` keeps its meaning (it describes the TENANT, and the settings
 * form reads it as such). `canResolveProvider` describes the CALLER.
 *
 * `resolvedEmbeddingProvider` is the same correction applied to a second
 * question — "which provider will embedding actually use?" — which a UI notice
 * had been INFERRING from the tenant-scoped fields. Its own block at the bottom
 * of this file covers the three states that inference gets wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockGetModelForTask,
	mockResolveOrganizationId,
	mockGetEmbeddingProviderConfig,
	mockGetAiProviderApiKey,
} = vi.hoisted(() => ({
	mockDb: {
		cloudProviderConfig: { findMany: vi.fn() },
		userCloudProviderConfig: { findMany: vi.fn() },
	},
	mockGetModelForTask: vi.fn(),
	mockResolveOrganizationId: vi.fn(
		(organizationId: string | null | undefined) => organizationId ?? null,
	),
	// The two rungs the procedure follows. Mocked at the boundary it calls, so
	// these tests pin the ORDER it calls them in and what it does with each
	// answer — the real behaviour of each rung is pinned where it lives, in
	// `packages/database`.
	//
	// Note the second is the TENANT entry point, not the SYSTEM one the runtime
	// uses. The procedure stops one rung short on purpose; `get-status.ts`
	// carries the reasoning under "ONE RUNG SHORT".
	mockGetEmbeddingProviderConfig: vi.fn(),
	mockGetAiProviderApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: mockDb,
	getModelForTask: (...args: unknown[]) => mockGetModelForTask(...args),
	getProviderDisplayName: (provider: string) => provider,
	isGatewayProvider: () => false,
	getEmbeddingProviderConfig: (...args: unknown[]) =>
		mockGetEmbeddingProviderConfig(...args),
	getAiProviderApiKey: (...args: unknown[]) =>
		mockGetAiProviderApiKey(...args),
	// The real reader — it is half of what is under test here. Restated rather
	// than imported because the rest of this mock exists to keep Prisma out of
	// the test. Both halves of the rule it mirrors are pinned at the source, so
	// a drift here fails there: the legacy `config.apiKey` fallback in
	// `packages/database/__tests__/ai-gateway-legacy-config-key.test.ts`, and
	// the OAuth-only row that carries no key yet is configured in
	// `ai-gateway-service-principal.test.ts`.
	readProviderRowCredentials: (row: {
		encryptedApiKey: string | null;
		clientId: string | null;
		encryptedClientSecret: string | null;
		config: unknown;
	}) => {
		const configData = (row.config as Record<string, unknown>) || {};
		const apiKey =
			row.encryptedApiKey ||
			(configData?.apiKey as string | undefined) ||
			null;
		return {
			apiKey,
			hasCredentials: Boolean(
				apiKey || (row.clientId && row.encryptedClientSecret),
			),
		};
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			mockResolveOrganizationId(organizationId),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { getAiConfigStatusProcedure } from "../get-status";

type StatusResult = {
	isConfigured: boolean;
	canResolveProvider: boolean;
	resolvedEmbeddingProvider: string | null;
	defaultProvider: string | null;
	embeddingProvider: string | null;
	configuredProviders: { provider: string; isDefault: boolean }[];
};
const getStatus = getAiConfigStatusProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<StatusResult>;
};

const context = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};

/** A provider row as the procedure reads it. Credential fields default empty. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		provider: "OPENAI",
		displayName: null,
		isDefault: true,
		isEmbeddingProvider: false,
		encryptedApiKey: null,
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		...overrides,
	};
}

/**
 * What the gateway resolvers hand back. Deliberately carries DECRYPTED
 * credential material, because half of what these tests check is that none of
 * it reaches the response.
 */
function providerConfig(overrides: Record<string, unknown> = {}) {
	return {
		apiKey: null,
		configId: null,
		provider: null,
		baseUrl: null,
		enabledProviders: [],
		source: null,
		deploymentName: null,
		clientId: null,
		encryptedClientSecret: null,
		...overrides,
	};
}

/** A resolved config with real-looking credential material on it. */
function resolvedConfig(provider: string, source: "organization" | "user") {
	return providerConfig({
		provider,
		source,
		configId: "cfg-1",
		apiKey: "sk-decrypted-placeholder",
		baseUrl: "https://ai.example.com/v1",
		clientId: "client-abc",
		encryptedClientSecret: "encrypted:secret-xyz",
		enabledProviders: ["OPENAI"],
		config: { apiKey: "sk-decrypted-placeholder" },
	});
}

function callInOrg() {
	return getStatus._handler({
		input: { organizationId: "org-1" },
		context,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.cloudProviderConfig.findMany.mockResolvedValue([]);
	mockDb.userCloudProviderConfig.findMany.mockResolvedValue([]);
	mockGetModelForTask.mockResolvedValue(null);
	// Default: nothing resolves anywhere. Each test opts into a rung.
	mockGetEmbeddingProviderConfig.mockResolvedValue(providerConfig());
	mockGetAiProviderApiKey.mockResolvedValue(providerConfig());
});

describe("canResolveProvider — the credential gap", () => {
	it("an organization whose only enabled row carries no credential is configured but NOT resolvable", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([row()]);

		const result = await callInOrg();

		expect(result.isConfigured).toBe(true);
		expect(result.canResolveProvider).toBe(false);
	});

	it("a row with an encrypted key resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-test" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("a legacy row whose key still lives in `config.apiKey` resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ config: { apiKey: "encrypted:sk-legacy" } }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("an OAuth-only service-principal row resolves despite a null key", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({
				provider: "DATABRICKS",
				clientId: "client-abc",
				encryptedClientSecret: "encrypted:secret-xyz",
			}),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("a half-configured service principal does not resolve", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ provider: "DATABRICKS", clientId: "client-abc" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(false);
	});
});

describe("canResolveProvider — the personal-key gap", () => {
	it("a member's own key inside an organization with none makes AI resolvable", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);

		const result = await callInOrg();

		// The organization itself is still unconfigured — that field describes
		// the tenant and must not move.
		expect(result.isConfigured).toBe(false);
		expect(result.canResolveProvider).toBe(true);
	});

	it("reads only the CALLER's own rows, never another member's", async () => {
		await callInOrg();

		// `isDefault` joined this clause when the field was corrected to mirror
		// the resolver, which reads only the default row. The part that matters
		// here is unchanged: the query is scoped to this caller's `userId`, so
		// no other member's configuration is ever read.
		expect(mockDb.userCloudProviderConfig.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", isDefault: true, enabled: true },
			}),
		);
	});

	it("does not reach for personal rows when the organization already resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);

		await callInOrg();

		expect(mockDb.userCloudProviderConfig.findMany).not.toHaveBeenCalled();
	});

	it("a personal row with no credential does not rescue an organization with none", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([row()]);

		expect((await callInOrg()).canResolveProvider).toBe(false);
	});
});

describe("canResolveProvider — outside an organization", () => {
	it("answers from the caller's own rows and never reads an organization's", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);

		const result = await getStatus._handler({
			input: { organizationId: null },
			context: { user: { id: "user-1" }, session: { id: "s1" } },
		});

		expect(result.canResolveProvider).toBe(true);
		expect(mockDb.cloudProviderConfig.findMany).not.toHaveBeenCalled();
	});
});

describe("canResolveProvider — the row the resolver actually reads", () => {
	it("a credentialed NON-default row does not make an organization resolvable", async () => {
		// The resolver issues `findFirst({ isDefault: true, enabled: true })`,
		// so only the default row decides. An organization whose default was
		// saved without a credential is refused even when another enabled row
		// carries one — and reporting otherwise here would hide the notice
		// while every real call still fails, which is the divergence this
		// field exists to remove.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ isDefault: true, encryptedApiKey: null }),
			row({
				isDefault: false,
				provider: "ANTHROPIC",
				encryptedApiKey: "encrypted:sk-non-default",
			}),
		]);
		// No personal rows, so the last rung cannot rescue it either.
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([]);

		const result = await callInOrg();

		expect(result.canResolveProvider).toBe(false);
		// `isConfigured` still describes the TENANT and is unchanged: the
		// organization does have enabled providers. The two fields disagreeing
		// here is the point of having both.
		expect(result.isConfigured).toBe(true);
	});

	it("the default row's credential is what makes it resolvable", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ isDefault: true, encryptedApiKey: "encrypted:sk-default" }),
			row({ isDefault: false, provider: "ANTHROPIC" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});
});

/**
 * `resolvedEmbeddingProvider` — the second CALLER-scoped field.
 *
 * A UI notice used to infer "embedding will land on X" by combining the
 * TENANT-scoped fields (`defaultProvider`, `embeddingProvider`,
 * `configuredProviders`) with the CALLER-scoped `canResolveProvider`. Three
 * reachable states make that inference wrong, and each has a test below. The
 * field replaces the inference by calling the same two functions the runtime
 * calls, in the same order — so the tests here pin the ORDER and the handling,
 * not the rungs themselves, which are pinned in `packages/database`.
 */
describe("resolvedEmbeddingProvider — asked, never inferred", () => {
	it("reports the organization's assigned embedding provider", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({
				isEmbeddingProvider: true,
				encryptedApiKey: "encrypted:sk-org",
			}),
		]);
		mockGetEmbeddingProviderConfig.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBe("OPENAI");
		expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		// Rung 1 answered, so rung 2 is never reached — the same short-circuit
		// `resolveModelWithProvider` performs.
		expect(mockGetAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("with no embedding provider assigned, reports what the system resolver returns", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);

		const result = await callInOrg();

		// The tenant assigned no dedicated embedding row, so the tenant-scoped
		// field is null — and the resolved outcome is not.
		expect(result.embeddingProvider).toBeNull();
		expect(result.resolvedEmbeddingProvider).toBe("OPENAI");
		expect(mockGetAiProviderApiKey).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("STATE 2: an organization default with no usable credential reports the caller's PERSONAL provider", async () => {
		// The stored default says ANTHROPIC, but it was saved without a key, so
		// the real resolver rejects it and falls through to the caller's own
		// personal default. The old inference read `defaultProvider` and
		// announced ANTHROPIC; nothing will ever call it.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ provider: "ANTHROPIC", encryptedApiKey: null }),
		]);
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "user"),
		);

		const result = await callInOrg();

		// The tenant-scoped field still reports what is STORED, unchanged.
		expect(result.defaultProvider).toBe("ANTHROPIC");
		expect(result.resolvedEmbeddingProvider).toBe("OPENAI");
		expect(result.resolvedEmbeddingProvider).not.toBe("ANTHROPIC");
	});

	it("STATE 1: does not report the back-filled `configuredProviders[0]` when the resolver returns something else", async () => {
		// No row is marked `isDefault`, so the handler's own back-fill invents a
		// `defaultProvider` from the first configured row — a row the resolver's
		// `findFirst({ isDefault: true })` never sees. Meanwhile the caller
		// resolves on their personal default.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({
				provider: "ANTHROPIC",
				isDefault: false,
				encryptedApiKey: "encrypted:sk-org",
			}),
		]);
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "user"),
		);

		const result = await callInOrg();

		// The fabrication is still there — it is what the settings form reads —
		// and the resolved field is visibly independent of it.
		expect(result.defaultProvider).toBe("ANTHROPIC");
		expect(result.configuredProviders[0].isDefault).toBe(true);
		expect(result.resolvedEmbeddingProvider).toBe("OPENAI");
	});

	it("STATE 1, agreeing: reports the back-filled provider only because the resolver genuinely returned it", async () => {
		// Same fabricated default, but this time the resolver really does land
		// on ANTHROPIC. The field agrees with the back-fill here — by asking,
		// not by copying it. That distinction is the whole change.
		//
		// It lands there by the CALLER'S OWN default, and the mock says `user`
		// for that reason. An organization-sourced answer would be impossible
		// against this fixture: the resolver's organization arm reads only rows
		// marked default, and the one row here is not. A mock free to return
		// what the real function cannot is not a simpler test, it is a test
		// resting on a false premise — the same shape of mistake this field was
		// added to remove.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({
				provider: "ANTHROPIC",
				isDefault: false,
				encryptedApiKey: "encrypted:sk-org",
			}),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "user"),
		);

		expect((await callInOrg()).resolvedEmbeddingProvider).toBe("ANTHROPIC");
	});

	it("STATE 3: an organization with no rows and a personal Anthropic default reports ANTHROPIC", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([]);
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({
				provider: "ANTHROPIC",
				encryptedApiKey: "encrypted:sk-personal",
			}),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "user"),
		);

		const result = await callInOrg();

		// Every tenant-scoped field is null here, which is exactly why the old
		// inference missed this state — a real outcome with nothing to infer
		// from.
		expect(result.isConfigured).toBe(false);
		expect(result.defaultProvider).toBeNull();
		expect(result.embeddingProvider).toBeNull();
		expect(result.resolvedEmbeddingProvider).toBe("ANTHROPIC");
	});

	it("is null when nothing resolves on either rung", async () => {
		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBeNull();
		expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledTimes(1);
		expect(mockGetAiProviderApiKey).toHaveBeenCalledTimes(1);
	});
});

/**
 * Both rungs return DECRYPTED credential material. Only the provider
 * identifier may leave the procedure.
 *
 * These assertions run against the handler's own return value — the zod
 * `.output(...)` schema is not applied under this file's mock — which makes it
 * the stronger check of the two: the object never carries the material in the
 * first place, rather than relying on the schema to strip it on the way out.
 */
function expectNoCredentialMaterial(result: unknown) {
	const serialized = JSON.stringify(result);

	for (const secret of [
		"sk-decrypted-placeholder",
		"encrypted:secret-xyz",
		"client-abc",
		"ai.example.com",
	]) {
		expect(serialized).not.toContain(secret);
	}

	for (const key of [
		"apiKey",
		"encryptedApiKey",
		"clientId",
		"encryptedClientSecret",
		"baseUrl",
		"config",
		"configId",
		"enabledProviders",
		"deploymentName",
	]) {
		expect(serialized).not.toContain(`"${key}"`);
	}
}

describe("resolvedEmbeddingProvider — only the identifier travels", () => {
	it("carries no key, secret, base URL or config object from the embedding rung", async () => {
		mockGetEmbeddingProviderConfig.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "organization"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBe("ANTHROPIC");
		expectNoCredentialMaterial(result);
	});

	it("carries no key, secret, base URL or config object from the system rung", async () => {
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "user"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBe("ANTHROPIC");
		expectNoCredentialMaterial(result);
	});
});

/**
 * A rung that throws costs the ONE field it feeds, and nothing else.
 *
 * This endpoint is not only the two banners': the settings form and anything
 * else reading the status treat a failed call as "not configured". Letting two
 * newly added reads fail the whole payload would therefore take unrelated
 * surfaces down with them — and do it by turning a perfectly configured
 * tenant's status into an outage. The handler catches instead, leaving the
 * field null, which every reader already handles as "we do not know" and
 * nobody reads as Anthropic.
 */
describe("resolvedEmbeddingProvider — a failing rung does not fail the call", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// The handler logs what it swallows. Silenced so the suite's output
		// stays readable, and asserted below — a rejection that is neither
		// raised nor logged is invisible, which is a different bug from the one
		// being fixed here.
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	/**
	 * An organization whose default row carries a credential — a tenant for
	 * whom everything except the failing rung works. Both halves of each pair
	 * below run against it, so the rejection is the only difference between
	 * them.
	 */
	function seedResolvableOrganization() {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);
	}

	/** Everything in the payload the embedding rungs have no say in. */
	function fieldsTheRungsDoNotFeed(result: StatusResult) {
		return {
			isConfigured: result.isConfigured,
			canResolveProvider: result.canResolveProvider,
			configuredProviders: result.configuredProviders,
			defaultProvider: result.defaultProvider,
		};
	}

	it("a rejecting embedding rung leaves the field null and the rest of the payload untouched", async () => {
		seedResolvableOrganization();
		mockGetEmbeddingProviderConfig.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);
		const success = await callInOrg();

		mockGetEmbeddingProviderConfig.mockRejectedValue(
			new Error("embedding provider lookup failed"),
		);
		const failure = await callInOrg();

		expect(success.resolvedEmbeddingProvider).toBe("OPENAI");
		// Resolves rather than rejects, and says "I do not know" in the one
		// place that depends on the rung.
		expect(failure.resolvedEmbeddingProvider).toBeNull();
		expect(fieldsTheRungsDoNotFeed(failure)).toEqual(
			fieldsTheRungsDoNotFeed(success),
		);
		// Spelt out as well as compared: a regression that broke BOTH halves
		// identically would satisfy the comparison on its own.
		expect(failure.isConfigured).toBe(true);
		expect(failure.canResolveProvider).toBe(true);
		expect(failure.defaultProvider).toBe("OPENAI");
		expect(failure.configuredProviders).toEqual([
			{
				provider: "OPENAI",
				displayName: null,
				isDefault: true,
				isEmbeddingProvider: false,
				source: "org_config",
			},
		]);
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("a rejecting tenant rung leaves the field null and the rest of the payload untouched", async () => {
		// Rung 1 declines by default in this suite, so rung 2 is the one that
		// answers here — and the one that fails in the second half.
		seedResolvableOrganization();
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);
		const success = await callInOrg();

		mockGetAiProviderApiKey.mockRejectedValue(
			new Error("tenant provider lookup failed"),
		);
		const failure = await callInOrg();

		expect(success.resolvedEmbeddingProvider).toBe("OPENAI");
		expect(failure.resolvedEmbeddingProvider).toBeNull();
		expect(fieldsTheRungsDoNotFeed(failure)).toEqual(
			fieldsTheRungsDoNotFeed(success),
		);
		expect(failure.isConfigured).toBe(true);
		expect(failure.canResolveProvider).toBe(true);
		expect(failure.defaultProvider).toBe("OPENAI");
		expect(failure.configuredProviders).toEqual([
			{
				provider: "OPENAI",
				displayName: null,
				isDefault: true,
				isEmbeddingProvider: false,
				source: "org_config",
			},
		]);
		expect(consoleErrorSpy).toHaveBeenCalled();
	});
});

/**
 * ONE RUNG SHORT of the runtime, deliberately.
 *
 * `resolveModelWithProvider`'s embedding branch reaches the runtime's second
 * step through `getSystemAiProviderApiKey`, which carries a third rung this
 * procedure does not follow: the deployment's own platform gateway key. The
 * reasoning is in the "ONE RUNG SHORT" block in `get-status.ts` — that rung is
 * hardcoded to `VERCEL_GATEWAY` and so can never be the provider a caller needs
 * warning about; reaching it re-encrypts the platform key through a synchronous
 * scrypt, on an endpoint the app shell hits on every page load; and returning
 * its name would disclose to every tenant that the deployment holds a platform
 * key and which provider it points at.
 *
 * The `@repo/database` mock at the top of this file deliberately does not
 * expose `getSystemAiProviderApiKey` at all, so an edit that follows the extra
 * rung fails on the import rather than passing quietly. What is asserted here
 * is the positive half: the TENANT entry point is the one that gets called.
 */
describe("resolvedEmbeddingSource — whose configuration resolved", () => {
	// The banner branches its remedy on this: a member who administers nothing
	// can still own the row the resolver reached, and is then the only person
	// who can move it without changing the whole organization's setup.

	it("reports the organization when the organization's row resolved", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "organization"),
		);

		expect((await callInOrg()).resolvedEmbeddingSource).toBe(
			"organization",
		);
	});

	it("reports the caller when their own default resolved inside an organization", async () => {
		// The organization has a row but no usable credential, so the resolver
		// falls through to the caller's own default — the state where telling
		// the reader to find an admin would send them past their own fix.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([row()]);
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "user"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingSource).toBe("user");
		expect(result.resolvedEmbeddingProvider).toBe("ANTHROPIC");
	});

	it("carries the dedicated embedding row's own origin, not the fallback's", async () => {
		// Rung 1 answers, so rung 2 is never consulted and its origin must not
		// be the one reported.
		mockGetEmbeddingProviderConfig.mockResolvedValue(
			resolvedConfig("ANTHROPIC", "user"),
		);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingSource).toBe("user");
		expect(mockGetAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("reports null when the resolver names an origin this field does not model", async () => {
		// The platform branch stamps no source at all. Guessing one would put a
		// remedy in front of a reader naming an owner nobody verified.
		mockGetAiProviderApiKey.mockResolvedValue(
			providerConfig({ provider: "VERCEL_GATEWAY", source: null }),
		);

		expect((await callInOrg()).resolvedEmbeddingSource).toBeNull();
	});

	it("falls back to null alongside the provider when a rung rejects", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mockGetEmbeddingProviderConfig.mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBeNull();
		expect(result.resolvedEmbeddingSource).toBeNull();
		expect(result.isConfigured).toBe(false);
		errorSpy.mockRestore();
	});
});

describe("resolvedEmbeddingProvider — one rung short of the runtime", () => {
	it("asks the TENANT resolver for rung 2", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);
		mockGetAiProviderApiKey.mockResolvedValue(
			resolvedConfig("OPENAI", "organization"),
		);

		const result = await callInOrg();

		expect(mockGetAiProviderApiKey).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(result.resolvedEmbeddingProvider).toBe("OPENAI");
	});

	it("reports null rather than a platform gateway when the tenant resolver yields nothing", async () => {
		// Both rungs decline. At runtime the system resolver would carry on to
		// the deployment's platform key and answer with a gateway identifier;
		// this procedure stops here and says it does not know. A caller in this
		// state has no tenant provider at all, which `canResolveProvider`
		// already reports beside it.
		const result = await callInOrg();

		expect(result.resolvedEmbeddingProvider).toBeNull();
		expect(result.resolvedEmbeddingProvider).not.toBe("VERCEL_GATEWAY");
		expect(result.canResolveProvider).toBe(false);
		expect(mockGetAiProviderApiKey).toHaveBeenCalledTimes(1);
	});
});
