/**
 * Upstash cache of the Proposal Inbox items' detection vectors: keys scoped
 * to the organization, the project and the embedding model, hits read back
 * and malformed entries treated as misses, writes with a TTL, and failure
 * reported instead of thrown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getRedisClient: vi.fn(),
	mget: vi.fn(),
	set: vi.fn(),
	exec: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-detection",
	)),
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/queries/projects/duplicate-focus",
	)),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../lib/redis-client", () => ({
	getRedisClient: mocks.getRedisClient,
}));

import {
	itemVectorHash,
	itemVectorKey,
	readCachedItemVectors,
	writeCachedItemVectors,
} from "../proposal-item-vector-cache";

const SCOPE = {
	organizationId: "org-1",
	projectId: "project-1",
	model: "example-embedding-model",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getRedisClient.mockReturnValue({
		mget: mocks.mget,
		pipeline: () => ({ set: mocks.set, exec: mocks.exec }),
	});
	mocks.exec.mockResolvedValue([]);
});

describe("itemVectorKey", () => {
	it("keeps one tenant's vectors apart from another's for the same text", () => {
		const hash = itemVectorHash({
			text: "Queue exports",
			focusTexts: null,
		});

		const keys = new Set([
			itemVectorKey(SCOPE, hash),
			itemVectorKey({ ...SCOPE, organizationId: "org-2" }, hash),
			itemVectorKey({ ...SCOPE, projectId: "project-2" }, hash),
			itemVectorKey({ ...SCOPE, organizationId: null }, hash),
			itemVectorKey({ ...SCOPE, model: "example-other-model" }, hash),
		]);

		expect(keys.size).toBe(5);
		expect(itemVectorKey(SCOPE, hash)).toBe(
			`proposal-dup:vec:org-1:project-1:example-embedding-model:${hash}`,
		);
	});
});

describe("itemVectorHash", () => {
	it("changes when the text or a section changes", () => {
		const base = itemVectorHash({
			text: "Queue exports",
			focusTexts: null,
		});

		expect(
			itemVectorHash({ text: "Queue exports", focusTexts: null }),
		).toBe(base);
		expect(
			itemVectorHash({ text: "Queue exports!", focusTexts: null }),
		).not.toBe(base);
		expect(
			itemVectorHash({
				text: "Queue exports",
				focusTexts: { scope: "In scope: queue" },
			}),
		).not.toBe(base);
	});
});

describe("readCachedItemVectors", () => {
	it("returns the hits by hash and treats a malformed entry as a miss", async () => {
		mocks.mget.mockResolvedValue([
			{ embedding: [1, 0], focusVectors: { scope: [0, 1] } },
			null,
			{ embedding: "not a vector" },
		]);

		const found = await readCachedItemVectors(SCOPE, ["a", "b", "c"]);

		expect(mocks.mget).toHaveBeenCalledWith([
			itemVectorKey(SCOPE, "a"),
			itemVectorKey(SCOPE, "b"),
			itemVectorKey(SCOPE, "c"),
		]);
		expect(found).toEqual(
			new Map([
				["a", { embedding: [1, 0], focusVectors: { scope: [0, 1] } }],
			]),
		);
	});

	it("reads in batches and asks once per hash", async () => {
		const hashes = Array.from({ length: 120 }, (_, index) => `h-${index}`);
		mocks.mget.mockImplementation(async (keys: string[]) =>
			keys.map(() => null),
		);

		await readCachedItemVectors(SCOPE, [...hashes, "h-0"]);

		expect(mocks.mget).toHaveBeenCalledTimes(3);
		expect(
			mocks.mget.mock.calls.flatMap(([keys]) => keys as string[]),
		).toHaveLength(120);
	});

	it("returns null when the cache is not configured", async () => {
		mocks.getRedisClient.mockReturnValue(null);

		await expect(readCachedItemVectors(SCOPE, ["a"])).resolves.toBeNull();
	});

	it("returns null when the read fails", async () => {
		mocks.mget.mockRejectedValue(new Error("connection reset"));

		await expect(readCachedItemVectors(SCOPE, ["a"])).resolves.toBeNull();
	});
});

describe("writeCachedItemVectors", () => {
	it("stores each item's vectors under its key with a TTL", async () => {
		const stored = await writeCachedItemVectors(
			SCOPE,
			new Map([["a", { embedding: [1, 0] }]]),
		);

		expect(stored).toBe(true);
		expect(mocks.set).toHaveBeenCalledWith(
			itemVectorKey(SCOPE, "a"),
			{ embedding: [1, 0] },
			{ ex: expect.any(Number) },
		);
		expect(mocks.exec).toHaveBeenCalledTimes(1);
	});

	it("reports false when the cache is not configured or the write fails", async () => {
		const vectors = new Map([["a", { embedding: [1, 0] }]]);
		mocks.exec.mockRejectedValue(new Error("connection reset"));

		await expect(writeCachedItemVectors(SCOPE, vectors)).resolves.toBe(
			false,
		);

		mocks.getRedisClient.mockReturnValue(null);
		await expect(writeCachedItemVectors(SCOPE, vectors)).resolves.toBe(
			false,
		);
	});
});
