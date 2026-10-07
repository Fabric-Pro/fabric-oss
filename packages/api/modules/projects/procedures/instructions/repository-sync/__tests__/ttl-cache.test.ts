import { describe, expect, it } from "vitest";
import { TtlCache } from "../ttl-cache";

describe("TtlCache", () => {
	it("expires an entry after its time to live", () => {
		let now = 0;
		const cache = new TtlCache<string>({
			ttlMs: 100,
			maxEntries: 10,
			now: () => now,
		});
		cache.set("a", "one");
		now = 99;
		expect(cache.get("a")).toBe("one");
		now = 100;
		expect(cache.get("a")).toBeUndefined();
	});

	it("drops the oldest entry past the entry bound", () => {
		const cache = new TtlCache<number>({ ttlMs: 1_000, maxEntries: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([
			undefined,
			2,
			3,
		]);
	});

	it("keeps the total weight under its bound, oldest first", () => {
		const cache = new TtlCache<number[]>({
			ttlMs: 1_000,
			maxEntries: 100,
			weigh: (value) => value.length,
			maxWeight: 10,
		});
		cache.set("a", new Array(6).fill(0));
		cache.set("b", new Array(6).fill(0));
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toHaveLength(6);
	});

	it("does not keep one value heavier than the whole bound, nor lose what it replaces", () => {
		const cache = new TtlCache<number[]>({
			ttlMs: 1_000,
			maxEntries: 100,
			weigh: (value) => value.length,
			maxWeight: 10,
		});
		cache.set("a", new Array(4).fill(0));
		cache.set("a", new Array(11).fill(0));
		expect(cache.get("a")).toBeUndefined();
		cache.set("b", new Array(10).fill(0));
		cache.set("c", new Array(1).fill(0));
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toHaveLength(1);
	});
});
