import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sync: vi.fn(),
	providers: [{ key: "a" }],
	logError: vi.fn(),
	waitUntil: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	syncIntegrationProviderRegistry: mocks.sync,
}));
vi.mock("@repo/logs", () => ({ logger: { error: mocks.logError } }));
vi.mock("@repo/observability", () => ({
	getRegisteredProviders: () => mocks.providers,
}));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

async function freshSync() {
	vi.resetModules();
	return (await import("../provider-registry-sync")).syncProviderRegistryOnce;
}

beforeEach(() => {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("SKIP_PROVIDER_REGISTRY_SYNC", "");
	mocks.sync.mockReset().mockResolvedValue(undefined);
	mocks.logError.mockReset();
	mocks.waitUntil.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("syncProviderRegistryOnce", () => {
	it("syncs the registered providers once per process", async () => {
		// Arrange
		const syncOnce = await freshSync();

		// Act
		syncOnce();
		syncOnce();
		syncOnce();

		// Assert
		expect(mocks.sync).toHaveBeenCalledOnce();
		expect(mocks.sync).toHaveBeenCalledWith(mocks.providers);
	});

	it("keeps the platform alive until the sync finishes", async () => {
		// Arrange
		const syncOnce = await freshSync();

		// Act
		syncOnce();

		// Assert
		expect(mocks.waitUntil).toHaveBeenCalledOnce();
		expect(mocks.waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
	});

	it("logs a failed sync instead of throwing", async () => {
		// Arrange
		mocks.sync.mockRejectedValue(new Error("db down"));
		const syncOnce = await freshSync();

		// Act
		syncOnce();
		await mocks.waitUntil.mock.calls[0]?.[0];

		// Assert
		expect(mocks.logError).toHaveBeenCalledOnce();
	});

	it("does nothing under test or with the opt-out set", async () => {
		// Arrange
		vi.stubEnv("SKIP_PROVIDER_REGISTRY_SYNC", "1");
		const syncOnce = await freshSync();

		// Act
		syncOnce();

		// Assert
		expect(mocks.sync).not.toHaveBeenCalled();
	});
});
