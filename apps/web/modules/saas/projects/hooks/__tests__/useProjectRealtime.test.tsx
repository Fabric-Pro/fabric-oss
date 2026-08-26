/**
 * Reconnect-budget behavior for `useProjectRealtime`.
 *
 * The SSE endpoint (Upstash Realtime) deliberately closes the stream at its
 * `maxDurationSecs` (~4.5 min / server closes at ~268s by design, to stay
 * under Vercel's function limit) and expects the client to reconnect. So a
 * long-lived session sees many normal open -> drop -> reopen cycles.
 *
 * The hook caps reconnect attempts (to avoid hammering a genuinely-down
 * service, e.g. Redis not configured). That budget must be spent by
 * CONSECUTIVE failures, not by healthy cycles: a successful connection has
 * to reset it. Otherwise a perfectly healthy session permanently disables
 * realtime after a few minutes.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectRealtime } from "../useProjectRealtime";

class MockEventSource {
	static instances: MockEventSource[] = [];

	url: string;
	onopen: ((event?: unknown) => void) | null = null;
	onmessage: ((event: unknown) => void) | null = null;
	onerror: ((event?: unknown) => void) | null = null;
	close = vi.fn();

	constructor(url: string) {
		this.url = url;
		MockEventSource.instances.push(this);
	}

	/** Simulate the server accepting the connection. */
	emitOpen(): void {
		this.onopen?.();
	}

	/** Simulate the server closing the stream (the ~4.5-min expiry). */
	emitError(): void {
		this.onerror?.(new Event("error"));
	}
}

describe("useProjectRealtime reconnect budget", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockEventSource.instances = [];
		window.sessionStorage.clear();
		vi.stubGlobal("EventSource", MockEventSource);
		// The hook is chatty; keep test output pristine while still spying.
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("keeps reconnecting across many successful open/drop cycles", () => {
		renderHook(() => useProjectRealtime({ projectId: "p1" }));

		// Mount opens the first connection.
		expect(MockEventSource.instances).toHaveLength(1);

		// More cycles than the internal reconnect cap (3) — each one is a
		// healthy connection that opens, then drops on the server's timer.
		const cycles = 6;
		for (let i = 0; i < cycles; i++) {
			const current = MockEventSource.instances.at(-1);
			if (!current) {
				throw new Error(`no connection to drive at cycle ${i}`);
			}
			act(() => current.emitOpen()); // server accepts -> healthy
			act(() => current.emitError()); // ~4.5-min expiry closes the stream
			act(() => vi.advanceTimersByTime(60_000)); // let the reconnect fire
		}

		// Every drop must be followed by a reconnect: the initial connection
		// plus one fresh EventSource per cycle. The bug (budget never reset on
		// a successful open) makes the hook give up mid-way, so fewer
		// connections are created.
		expect(MockEventSource.instances).toHaveLength(1 + cycles);

		// A healthy session that keeps reconnecting must never warn that
		// realtime is unavailable — these drops are expected, not failures.
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("warns and gives up only after consecutive failures with no successful open", () => {
		renderHook(() => useProjectRealtime({ projectId: "p1" }));

		// Service is genuinely down: every connection errors immediately and
		// never opens. Follow the reconnect chain, erroring each fresh
		// connection exactly once (a closed EventSource doesn't re-fire), so
		// the hook retries a bounded number of times then stops.
		let driven = 0;
		for (let guard = 0; guard < 20; guard++) {
			const current = MockEventSource.instances[driven];
			if (!current) {
				break; // hook gave up: no new connection to drive
			}
			act(() => current.emitError());
			act(() => vi.advanceTimersByTime(60_000));
			driven++;
		}

		// Bounded retries: initial connection + the internal cap (3) before
		// it stops creating new connections.
		expect(MockEventSource.instances).toHaveLength(1 + 3);

		// The "unavailable" warning is the genuine-failure signal — emitted
		// exactly when it gives up, not on every drop.
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("unavailable"),
		);
	});
});
