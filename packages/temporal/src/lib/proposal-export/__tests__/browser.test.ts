/**
 * The Proposal export's Chromium (Fizzy #2946): launched with a minimal
 * environment so no worker secret reaches it, every page in its own fresh
 * context with JavaScript off, offline and every request aborted, and the
 * browser closed whether the work succeeds, fails or outlives its deadline.
 *
 * `playwright` is mocked: no Chromium runs. The fake browser records the
 * launch options, every context it creates and every close.
 */

import { tmpdir } from "node:os";
import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch } }));

import {
	EXPORT_CONTEXT_OPTIONS,
	type ExportBrowser,
	type ExportPageOptions,
	exportBrowserEnv,
	exportLaunchOptions,
	withExportBrowser,
} from "../browser";

interface FakeRoute {
	abort: ReturnType<typeof vi.fn>;
}

interface FakeContext {
	options: Record<string, unknown>;
	route: ReturnType<typeof vi.fn>;
	newPage: ReturnType<typeof vi.fn>;
	pages: { setDefaultTimeout: ReturnType<typeof vi.fn> }[];
}

interface FakeChromium {
	contexts: FakeContext[];
	close: ReturnType<typeof vi.fn>;
	newContext: ReturnType<typeof vi.fn>;
	/** Runs once on every `close()`, before it resolves. */
	onClose: (listener: () => void) => void;
}

let chromium: FakeChromium;

function fakeChromium(): FakeChromium {
	const contexts: FakeContext[] = [];
	const listeners: (() => void)[] = [];
	const close = vi.fn(async () => {
		for (const listener of listeners.splice(0)) {
			listener();
		}
	});
	const newContext = vi.fn(async (options: Record<string, unknown>) => {
		const context: FakeContext = {
			options,
			route: vi.fn(async () => undefined),
			pages: [],
			newPage: vi.fn(async () => {
				const page = { setDefaultTimeout: vi.fn() };
				context.pages.push(page);
				return page;
			}),
		};
		contexts.push(context);
		return context;
	});
	return {
		contexts,
		close,
		newContext,
		onClose: (listener) => listeners.push(listener),
	};
}

/** The rejection of `promise`, which must reject. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function expectTimedOut(error: unknown): void {
	expect(error).toBeInstanceOf(ApplicationFailure);
	expect(error).toMatchObject({
		type: "EXPORT_TIMED_OUT",
		nonRetryable: true,
	});
}

/** Far enough out that no test reaches it by accident. */
function farDeadline(): number {
	return Date.now() + 60_000;
}

beforeEach(() => {
	launch.mockReset();
	chromium = fakeChromium();
	launch.mockImplementation(async () => ({
		newContext: chromium.newContext,
		close: chromium.close,
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the export browser's launch", () => {
	const SECRET_KEYS = [
		"DATABASE_URL",
		"S3_SECRET_ACCESS_KEY",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
	] as const;
	const saved: Partial<Record<(typeof SECRET_KEYS)[number], string>> = {};

	beforeEach(() => {
		for (const key of SECRET_KEYS) {
			saved[key] = process.env[key];
			process.env[key] = `example-${key.toLowerCase()}-not-a-real-value`;
		}
	});

	afterEach(() => {
		for (const key of SECRET_KEYS) {
			const value = saved[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("passes Chromium only PATH and HOME, never the worker's secrets", async () => {
		await withExportBrowser(farDeadline(), async () => "done");

		expect(launch).toHaveBeenCalledTimes(1);
		const options = launch.mock.calls[0]?.[0] as {
			env: Record<string, string>;
		};
		expect(Object.keys(options.env).sort()).toEqual(["HOME", "PATH"]);
		expect(options.env.HOME).toBe(tmpdir());
		expect(options.env.PATH).toBe(process.env.PATH);
		const values = Object.values(options.env).join("\n");
		for (const key of SECRET_KEYS) {
			expect(values).not.toContain(process.env[key]);
		}
		expect(exportBrowserEnv()).toEqual(options.env);
	});

	it("launches headless with --no-sandbox", async () => {
		await withExportBrowser(farDeadline(), async () => "done");

		const options = launch.mock.calls[0]?.[0] as {
			headless: boolean;
			args: string[];
			timeout: number;
		};
		expect(options.headless).toBe(true);
		expect(options.args).toContain("--no-sandbox");
		expect(options.timeout).toBeGreaterThan(0);
		expect(options.timeout).toBeLessThanOrEqual(30_000);
	});

	it("bounds the launch timeout by the time left, and by 30 seconds", () => {
		expect(exportLaunchOptions(5_000).timeout).toBe(5_000);
		expect(exportLaunchOptions(600_000).timeout).toBe(30_000);
		expect(exportLaunchOptions(0).timeout).toBe(1);
		expect(exportLaunchOptions(-10).timeout).toBe(1);
	});
});

describe("an export page", () => {
	it("opens in a context with JavaScript off, offline and service workers blocked", async () => {
		await withExportBrowser(farDeadline(), async (browser) => {
			await browser.newPage();
		});

		expect(chromium.contexts).toHaveLength(1);
		const options = chromium.contexts[0]?.options;
		expect(options).toMatchObject({
			javaScriptEnabled: false,
			offline: true,
			serviceWorkers: "block",
			acceptDownloads: false,
		});
		expect(options).toEqual(EXPORT_CONTEXT_OPTIONS);
	});

	it("routes every request to an abort and counts it", async () => {
		let session: ExportBrowser | undefined;
		await withExportBrowser(farDeadline(), async (browser) => {
			session = browser;
			await browser.newPage();

			const context = chromium.contexts[0];
			expect(context?.route).toHaveBeenCalledTimes(1);
			expect(context?.route.mock.calls[0]?.[0]).toBe("**/*");
			const handler = context?.route.mock.calls[0]?.[1] as (
				route: FakeRoute,
			) => unknown;

			expect(browser.blockedRequests).toBe(0);
			const first: FakeRoute = { abort: vi.fn(async () => undefined) };
			const second: FakeRoute = { abort: vi.fn(async () => undefined) };
			await handler(first);
			await handler(second);
			expect(first.abort).toHaveBeenCalledWith("blockedbyclient");
			expect(second.abort).toHaveBeenCalledWith("blockedbyclient");
			expect(browser.blockedRequests).toBe(2);
		});
		expect(session?.blockedRequests).toBe(2);
	});

	it("passes a device scale factor and a viewport through", async () => {
		await withExportBrowser(farDeadline(), async (browser) => {
			await browser.newPage({
				deviceScaleFactor: 2,
				viewport: { width: 800, height: 600 },
			});
		});

		expect(chromium.contexts[0]?.options).toEqual({
			...EXPORT_CONTEXT_OPTIONS,
			deviceScaleFactor: 2,
			viewport: { width: 800, height: 600 },
		});
	});

	it("cannot be loosened by page options: JavaScript stays off and the page offline", async () => {
		const loosening = {
			deviceScaleFactor: 2,
			javaScriptEnabled: true,
			offline: false,
			serviceWorkers: "allow",
			acceptDownloads: true,
		} as unknown as ExportPageOptions;

		await withExportBrowser(farDeadline(), async (browser) => {
			await browser.newPage(loosening);
		});

		expect(chromium.contexts[0]?.options).toMatchObject({
			javaScriptEnabled: false,
			offline: true,
			serviceWorkers: "block",
			acceptDownloads: false,
			deviceScaleFactor: 2,
		});
	});

	it("gives every page its own context", async () => {
		await withExportBrowser(farDeadline(), async (browser) => {
			const first = await browser.newPage();
			const second = await browser.newPage();
			expect(first).not.toBe(second);
		});

		expect(chromium.newContext).toHaveBeenCalledTimes(2);
		expect(chromium.contexts).toHaveLength(2);
		expect(chromium.contexts[0]).not.toBe(chromium.contexts[1]);
		for (const context of chromium.contexts) {
			expect(context.newPage).toHaveBeenCalledTimes(1);
			expect(context.route).toHaveBeenCalledTimes(1);
		}
	});

	it("sets the page's default timeout to the time left in the budget", async () => {
		const deadline = Date.now() + 45_000;
		await withExportBrowser(deadline, async (browser) => {
			await browser.newPage();
		});

		const timeout = chromium.contexts[0]?.pages[0]?.setDefaultTimeout.mock
			.calls[0]?.[0] as number;
		expect(timeout).toBeGreaterThan(0);
		expect(timeout).toBeLessThanOrEqual(45_000);
	});

	it("refuses a new page once the deadline has passed", async () => {
		const deadline = farDeadline();
		const error = await rejection(
			withExportBrowser(deadline, async (browser) => {
				vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
				await browser.newPage();
			}),
		);

		expectTimedOut(error);
		expect(chromium.newContext).not.toHaveBeenCalled();
		expect(chromium.close).toHaveBeenCalled();
	});
});

describe("the export browser's lifetime", () => {
	it("returns the work's result and closes the browser", async () => {
		const result = await withExportBrowser(farDeadline(), async () => ({
			pdf: "example",
		}));

		expect(result).toEqual({ pdf: "example" });
		expect(chromium.close).toHaveBeenCalledTimes(1);
	});

	it("closes the browser when the work rejects, and rethrows its error", async () => {
		const failure = new Error("Example render failure");
		const error = await rejection(
			withExportBrowser(farDeadline(), async () => {
				throw failure;
			}),
		);

		expect(error).toBe(failure);
		expect(chromium.close).toHaveBeenCalledTimes(1);
	});

	it("does not launch at all when the deadline has already passed", async () => {
		const error = await rejection(
			withExportBrowser(Date.now() - 1, async () => "never"),
		);

		expectTimedOut(error);
		expect(launch).not.toHaveBeenCalled();
	});

	it("closes the browser at the deadline and fails with EXPORT_TIMED_OUT", async () => {
		const work = vi.fn(
			() =>
				new Promise<string>((_resolve, reject) => {
					// Settles only because the deadline closed the browser.
					chromium.onClose(() =>
						reject(
							new Error(
								"Target page, context or browser has been closed",
							),
						),
					);
				}),
		);

		const error = await rejection(withExportBrowser(Date.now() + 30, work));

		expectTimedOut(error);
		expect(work).toHaveBeenCalledTimes(1);
		expect(chromium.close).toHaveBeenCalled();
	});

	it("fails with EXPORT_TIMED_OUT even when the work resolves after the deadline", async () => {
		const work = () =>
			new Promise<string>((resolve) => {
				chromium.onClose(() => resolve("too late"));
			});

		const error = await rejection(withExportBrowser(Date.now() + 30, work));

		expectTimedOut(error);
		expect(chromium.close).toHaveBeenCalled();
	});
});
