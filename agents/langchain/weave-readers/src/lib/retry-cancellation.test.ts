import { afterEach, expect, it, vi } from "vitest";
import { withRetry } from "./retry.js";

afterEach(() => vi.useRealTimers());

it("refuses an already aborted attempt", async () => {
	const attempt = vi.fn(async () => "unused");
	await expect(
		withRetry(attempt, {
			signal: AbortSignal.abort(),
			circuitKey: "example-aborted",
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(attempt).not.toHaveBeenCalled();
});

it("removes an aborted waiter from the concurrency queue", async () => {
	const releases: Array<() => void> = [];
	const active = Array.from({ length: 4 }, () =>
		withRetry(
			() =>
				new Promise<void>((resolve) => {
					releases.push(resolve);
				}),
			{ circuitKey: "example-active" },
		),
	);
	await vi.waitFor(() => expect(releases).toHaveLength(4));
	const controller = new AbortController();
	const attempt = vi.fn(async () => "unused");
	const pending = withRetry(attempt, {
		signal: controller.signal,
		circuitKey: "example-waiter",
	});
	const rejected = expect(pending).rejects.toMatchObject({
		name: "AbortError",
	});
	controller.abort();
	// Release the active work even when running against the uncancellable implementation.
	for (const release of releases) {
		release();
	}
	await Promise.all(active);
	await rejected;
	expect(attempt).not.toHaveBeenCalled();
	expect(
		await withRetry(async () => "ok", { circuitKey: "example-next" }),
	).toBe("ok");
});
