import { describe, expect, it, vi } from "vitest";
import { MAX_PAGES, paginateRuns } from "../paginate";

/** Newest-first pages of `perPage`, ids counting down from `newest`. */
const pager = (newest: number, perPage: number) => (page: number) => {
	const start = newest - (page - 1) * perPage;
	const items = [];
	for (let i = 0; i < perPage && start - i > 0; i++) {
		items.push({ id: start - i });
	}
	return Promise.resolve(items);
};

const idOf = (r: { id: number }) => r.id;

describe("paginateRuns", () => {
	it("stops on the first page when it already reaches the cursor", async () => {
		const fetchPage = vi.fn(pager(105, 20));
		const out = await paginateRuns({
			since: 100,
			perPage: 20,
			idOf,
			fetchPage,
		});
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(out.truncated).toBe(false);
		expect(out.items.map(idOf)).toContain(100);
	});

	it("keeps paging until it reaches the cursor", async () => {
		// Regression: a 70-run backlog behind a 20-run page used to return only
		// the newest 20, and advancing the cursor past them stranded the other 50.
		const fetchPage = vi.fn(pager(170, 20));
		const out = await paginateRuns({
			since: 100,
			perPage: 20,
			idOf,
			fetchPage,
		});
		expect(fetchPage).toHaveBeenCalledTimes(4);
		expect(out.truncated).toBe(false);
		// Everything from the cursor up to the newest run is in hand — no gap.
		const ids = out.items.map(idOf);
		for (let id = 101; id <= 170; id++) {
			expect(ids).toContain(id);
		}
	});

	it("stops early on a short page (end of history)", async () => {
		const fetchPage = vi.fn(pager(15, 20));
		const out = await paginateRuns({
			since: 0,
			perPage: 20,
			idOf,
			fetchPage,
		});
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(out.truncated).toBe(false);
	});

	it("stops on an empty page", async () => {
		const fetchPage = vi.fn(async () => []);
		const out = await paginateRuns({
			since: 0,
			perPage: 20,
			idOf,
			fetchPage,
		});
		expect(out.items).toEqual([]);
		expect(out.truncated).toBe(false);
	});

	it("reports truncation when the page cap trips before the cursor", async () => {
		// A first-ever sync against years of history: the cap protects the
		// activity, and the flag stops the caller reporting a clean drain.
		const fetchPage = vi.fn(pager(100_000, 20));
		const out = await paginateRuns({
			since: 1,
			perPage: 20,
			idOf,
			fetchPage,
		});
		expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
		expect(out.truncated).toBe(true);
	});

	it("checks in before every page", async () => {
		const onPage = vi.fn();
		await paginateRuns({
			since: 100,
			perPage: 20,
			idOf,
			fetchPage: pager(170, 20),
			onPage,
		});
		expect(onPage).toHaveBeenCalledTimes(4);
	});
});
