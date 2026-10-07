import { describe, expect, it, vi } from "vitest";
import {
	type DispatchGuard,
	guardDispatch,
	rethrowIfDispatchStopped,
	runWithDispatchGuard,
} from "../lib/dispatch-guard";

function guardWith(overrides: Partial<DispatchGuard> = {}): DispatchGuard {
	return {
		key: "turn-example-1",
		assertDispatchable: vi.fn(async () => undefined),
		abortSignal: () => undefined,
		rethrowIfStopped: () => undefined,
		...overrides,
	};
}

describe("guardDispatch", () => {
	it("returns the caller's signal itself, or undefined, outside guarded code", async () => {
		const signal = new AbortController().signal;

		expect(await guardDispatch(signal)).toBe(signal);
		expect(await guardDispatch()).toBeUndefined();
	});

	it("checks the guard before every request and throws its stop", async () => {
		const stop = new Error("turn stopped");
		const guard = guardWith({
			assertDispatchable: vi.fn(async () => {
				throw stop;
			}),
		});

		await expect(
			runWithDispatchGuard(guard, () => guardDispatch()),
		).rejects.toBe(stop);
		await expect(
			runWithDispatchGuard(guard, () => guardDispatch()),
		).rejects.toBe(stop);
		expect(guard.assertDispatchable).toHaveBeenCalledTimes(2);
	});

	it("returns the guard's signal when the caller has none", async () => {
		const guardSignal = new AbortController().signal;
		const guard = guardWith({ abortSignal: () => guardSignal });

		expect(await runWithDispatchGuard(guard, () => guardDispatch())).toBe(
			guardSignal,
		);
	});

	it("merges the caller's signal with the guard's, each abort keeping its own reason", async () => {
		const own = new AbortController();
		const stopController = new AbortController();
		const guard = guardWith({ abortSignal: () => stopController.signal });

		const merged = await runWithDispatchGuard(guard, () =>
			guardDispatch(own.signal),
		);
		expect(merged).not.toBe(own.signal);
		expect(merged?.aborted).toBe(false);

		const stop = new Error("turn stopped");
		stopController.abort(stop);
		expect(merged?.aborted).toBe(true);
		expect(merged?.reason).toBe(stop);

		const own2 = new AbortController();
		const merged2 = await runWithDispatchGuard(
			guardWith({ abortSignal: () => new AbortController().signal }),
			() => guardDispatch(own2.signal),
		);
		own2.abort();
		expect(merged2?.reason).toBeInstanceOf(DOMException);
		expect((merged2?.reason as DOMException).name).toBe("AbortError");
	});

	it("keeps the caller's signal when the guard has none", async () => {
		const signal = new AbortController().signal;

		expect(
			await runWithDispatchGuard(guardWith(), () =>
				guardDispatch(signal),
			),
		).toBe(signal);
	});
});

describe("rethrowIfDispatchStopped", () => {
	it("is a no-op outside guarded code", () => {
		expect(() => rethrowIfDispatchStopped(new Error("x"))).not.toThrow();
	});

	it("hands the error to the active guard", () => {
		const stop = new Error("turn stopped");
		const guard = guardWith({
			rethrowIfStopped: (error) => {
				if (error === stop) {
					throw error;
				}
			},
		});

		runWithDispatchGuard(guard, () => {
			expect(() => rethrowIfDispatchStopped(stop)).toThrow(stop);
			expect(() =>
				rethrowIfDispatchStopped(new Error("ordinary")),
			).not.toThrow();
		});
	});
});
