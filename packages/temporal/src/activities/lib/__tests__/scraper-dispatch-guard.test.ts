/**
 * Scraper adapters and the dispatch guard.
 *
 * `fabric_scrape_url` runs inside an Advisor chat turn, under a dispatch
 * guard. A user's Stop must leave the scraper as an error, never as a
 * `{ success: false }` result the tool would hand to the model. Every
 * adapter checks the guard before its request, sends with the guard's abort
 * signal, and rethrows a stop from the request and from the body read.
 * Outside a guard (URL context-source workflows) an abort still maps to
 * TIMEOUT.
 */
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareScraper } from "../scrapers/cloudflare-scraper";
import { createExaScraper } from "../scrapers/exa-scraper";
import { createFirecrawlScraper } from "../scrapers/firecrawl-scraper";
import { createJinaScraper } from "../scrapers/jina-scraper";
import { createTavilyScraper } from "../scrapers/tavily-scraper";
import type { WebScraper } from "../web-scraper";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const URL_TO_SCRAPE = "https://example.com/page";

class StopError extends Error {
	constructor() {
		super("turn stopped");
		this.name = "StopError";
	}
}

function makeGuard(options: { refuse?: boolean } = {}) {
	const abort = new AbortController();
	const assertDispatchable = vi.fn(async () => {
		if (options.refuse) {
			throw new StopError();
		}
	});
	const guard: DispatchGuard = {
		key: "scraper-test-guard",
		assertDispatchable,
		abortSignal: () => abort.signal,
		rethrowIfStopped(error) {
			if (error instanceof StopError) {
				throw error;
			}
		},
	};
	return { guard, abort, assertDispatchable };
}

/** A fetch that never answers and rejects with the signal's reason on abort. */
function hangingFetch() {
	return vi.fn(
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	);
}

const ADAPTERS: Array<{ name: string; make: () => WebScraper }> = [
	{ name: "jina", make: () => createJinaScraper("k") },
	{ name: "tavily", make: () => createTavilyScraper("k") },
	{ name: "exa", make: () => createExaScraper("k") },
	{
		name: "cloudflare",
		make: () => {
			const built = createCloudflareScraper(
				"k",
				`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`,
			);
			if (!built) {
				throw new Error("expected a cloudflare adapter");
			}
			return built;
		},
	},
	{ name: "firecrawl", make: () => createFirecrawlScraper("k") },
];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(ADAPTERS)("$name adapter under a dispatch guard", ({ make }) => {
	it("refuses before sending when the guard has already stopped", async () => {
		const fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard } = makeGuard({ refuse: true });

		await expect(
			runWithDispatchGuard(guard, () => make().scrapeUrl(URL_TO_SCRAPE)),
		).rejects.toBeInstanceOf(StopError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rethrows a stop that aborts the request in flight", async () => {
		const fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);
		const { guard, abort, assertDispatchable } = makeGuard();

		const running = runWithDispatchGuard(guard, () =>
			make().scrapeUrl(URL_TO_SCRAPE),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		abort.abort(new StopError());

		expect(await running).toBeInstanceOf(StopError);
		expect(assertDispatchable).toHaveBeenCalledTimes(1);
	});

	it("rethrows a stop that aborts the body read", async () => {
		const bodyStop = new Response("{}", { status: 200 });
		vi.spyOn(bodyStop, "text").mockRejectedValue(new StopError());
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bodyStop));
		const { guard } = makeGuard();

		await expect(
			runWithDispatchGuard(guard, () => make().scrapeUrl(URL_TO_SCRAPE)),
		).rejects.toBeInstanceOf(StopError);
	});

	it("still maps the adapter's own timeout to TIMEOUT", async () => {
		vi.stubGlobal("fetch", hangingFetch());
		const { guard } = makeGuard();

		const result = await runWithDispatchGuard(guard, () =>
			make().scrapeUrl(URL_TO_SCRAPE, { timeoutMs: 20 }),
		);

		expect(result).toMatchObject({
			success: false,
			error: { code: "TIMEOUT" },
		});
	});
});

describe("firecrawl crawl under a dispatch guard", () => {
	it("rethrows a stop that aborts a page scrape after the map", async () => {
		const mapResponse = () =>
			new Response(
				JSON.stringify({
					success: true,
					links: [
						"https://example.com/page/a",
						"https://example.com/page/b",
					],
				}),
				{ status: 200 },
			);
		const pageFetch = hangingFetch();
		const fetchMock = vi.fn((url: unknown, init?: RequestInit) =>
			String(url).includes("/map")
				? Promise.resolve(mapResponse())
				: pageFetch(url, init),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { guard, abort } = makeGuard();
		const scraper = createFirecrawlScraper("k");
		if (!scraper.crawlSite) {
			throw new Error("expected firecrawl to crawl");
		}
		const crawlSite = scraper.crawlSite.bind(scraper);

		const running = runWithDispatchGuard(guard, () =>
			crawlSite(URL_TO_SCRAPE, { limit: 2 }),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(pageFetch).toHaveBeenCalledTimes(1));
		abort.abort(new StopError());

		expect(await running).toBeInstanceOf(StopError);
	});
});

describe.each(ADAPTERS)("$name adapter outside a guard", ({ make }) => {
	it("maps an abort to TIMEOUT", async () => {
		const fetchMock = hangingFetch();
		vi.stubGlobal("fetch", fetchMock);

		const result = await make().scrapeUrl(URL_TO_SCRAPE, { timeoutMs: 20 });

		expect(result).toMatchObject({
			success: false,
			error: { code: "TIMEOUT" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
