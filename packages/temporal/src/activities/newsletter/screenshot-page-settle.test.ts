/**
 * When a capture reads a client-rendered page: after its own requests have
 * been quiet for a moment, never waiting on a stream or a long poll, and never
 * longer than the bound.
 */
import type { Request } from "playwright";
import { describe, expect, it } from "vitest";
import type {
	BrowserOperation,
	OperationOutcome,
} from "../qa-agentic-run/browser-driver";
import {
	performWithRecovery,
	type SettlePage,
	watchPageActivity,
} from "./screenshot-page-settle";

type Listener = (request: Request) => void;

interface Step {
	at: number;
	run: (page: FakePage) => void;
}

/** A page on a fake clock; `script` runs request events at given times. */
class FakePage {
	now = 0;
	loadedChecks = 0;
	private readonly listeners = new Map<string, Listener[]>();

	constructor(private readonly script: Step[]) {}

	emit(event: string, request: Request) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(request);
		}
	}

	on(event: string, listener: Listener) {
		this.listeners.set(event, [
			...(this.listeners.get(event) ?? []),
			listener,
		]);
		return this;
	}

	async waitForTimeout(ms: number) {
		const until = this.now + ms;
		for (const step of this.script) {
			if (step.at > this.now && step.at <= until) {
				this.now = step.at;
				step.run(this);
			}
		}
		this.now = until;
	}

	async waitForFunction() {
		this.loadedChecks += 1;
		return null;
	}
}

function fakePage(script: Step[]) {
	return new FakePage(script);
}

function request(resourceType: string): Request {
	return { resourceType: () => resourceType } as Request;
}

function watch(page: FakePage) {
	return watchPageActivity(page as unknown as SettlePage, () => page.now);
}

describe("watchPageActivity", () => {
	it("waits for a navigation a click started, then for quiet", async () => {
		const fetch = request("fetch");
		const page = fakePage([
			{ at: 200, run: (p) => p.emit("request", fetch) },
			{ at: 1_500, run: (p) => p.emit("requestfinished", fetch) },
		]);
		const activity = watch(page);

		await activity.settle();

		expect(page.now).toBeGreaterThanOrEqual(2_000);
		expect(page.now).toBeLessThan(2_200);
		expect(page.loadedChecks).toBe(1);
	});

	it("reads after a short quiet moment when nothing is loading", async () => {
		const page = fakePage([]);
		const activity = watch(page);

		await activity.settle();

		expect(page.now).toBe(500);
	});

	it("ignores streams and requests open longer than a long poll", async () => {
		const page = fakePage([
			{ at: 100, run: (p) => p.emit("request", request("fetch")) },
			{ at: 200, run: (p) => p.emit("request", request("websocket")) },
			{ at: 300, run: (p) => p.emit("request", request("eventsource")) },
		]);
		const activity = watch(page);
		await page.waitForTimeout(10_100);
		const settledFrom = page.now;

		await activity.settle();

		expect(page.now - settledFrom).toBe(500);
	});

	it("stops waiting after four seconds when requests keep coming", async () => {
		const page = fakePage(
			Array.from({ length: 60 }, (_, index) => ({
				at: 100 + index * 100,
				run: (p: FakePage) => p.emit("request", request("fetch")),
			})),
		);
		const activity = watch(page);

		await activity.settle();

		expect(page.now).toBe(4_000);
		expect(page.loadedChecks).toBe(1);
	});
});

describe("performWithRecovery", () => {
	const click: BrowserOperation = {
		kind: "click",
		role: "button",
		name: "Save",
	};
	const timedOut: OperationOutcome = {
		ok: false,
		detail: "Could not click: Timeout 8000ms exceeded.",
	};

	function recover(
		outcomes: OperationOutcome[],
		operation: BrowserOperation = click,
		covering: string | null = null,
	) {
		const keys: string[] = [];
		let calls = 0;
		const page = {
			keyboard: {
				press: async (key: string) => {
					keys.push(key);
				},
			},
		};
		const result = performWithRecovery(
			page,
			operation,
			async () => outcomes[calls++],
			async () => covering,
		);
		return { result, keys, calls: () => calls };
	}

	it("presses Escape and retries once when a click times out", async () => {
		const run = recover([timedOut, { ok: true, detail: "Clicked Save." }]);

		expect(await run.result).toEqual({
			ok: true,
			detail: "Pressed Escape, then: Clicked Save.",
		});
		expect(run.keys).toEqual(["Escape"]);
		expect(run.calls()).toBe(2);
	});

	it("names what covers the target when the retry fails too", async () => {
		const run = recover([timedOut, timedOut], click, "an open menu");

		expect(await run.result).toEqual({
			ok: false,
			detail: `${timedOut.detail} It is covered by an open menu; close that first.`,
		});
	});

	it("returns a refusal or another failure as it is, without retrying", async () => {
		const refused = { ok: false, detail: "Refused: it deletes data." };
		const run = recover([refused]);

		expect(await run.result).toBe(refused);
		expect(run.keys).toEqual([]);
		expect(run.calls()).toBe(1);
	});

	it("does not retry a navigation", async () => {
		const run = recover([timedOut], { kind: "goto", path: "/app" });

		expect(await run.result).toBe(timedOut);
		expect(run.keys).toEqual([]);
	});
});
