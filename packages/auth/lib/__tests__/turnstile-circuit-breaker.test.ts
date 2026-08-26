import { beforeEach, describe, expect, it } from "vitest";

import {
	type CircuitBreaker,
	createCircuitBreaker,
} from "../turnstile-circuit-breaker";

describe("turnstile circuit breaker", () => {
	let cb: CircuitBreaker;
	let now = 1_000_000;

	beforeEach(() => {
		now = 1_000_000;
		cb = createCircuitBreaker({
			failureThreshold: 5,
			windowMs: 60_000,
			cooldownMs: 30_000,
			now: () => now,
		});
	});

	it("starts closed (allows pass-through)", () => {
		expect(cb.shouldAllow()).toBe(true);
	});

	it("opens after failureThreshold failures within window", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordFailure();
		}
		expect(cb.shouldAllow()).toBe(false);
	});

	it("does not open with stale failures outside the window", () => {
		for (let i = 0; i < 4; i++) {
			cb.recordFailure();
		}
		now += 61_000;
		cb.recordFailure();
		expect(cb.shouldAllow()).toBe(true);
	});

	it("half-opens after cooldownMs", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordFailure();
		}
		expect(cb.shouldAllow()).toBe(false);
		now += 30_001;
		expect(cb.shouldAllow()).toBe(true);
	});

	it("recordSuccess closes the breaker", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordFailure();
		}
		now += 30_001;
		expect(cb.shouldAllow()).toBe(true);
		cb.recordSuccess();
		expect(cb.shouldAllow()).toBe(true);
		for (let i = 0; i < 4; i++) {
			cb.recordFailure();
		}
		expect(cb.shouldAllow()).toBe(true);
	});

	it("re-opens on first failed trial after half-open", () => {
		for (let i = 0; i < 5; i++) {
			cb.recordFailure();
		}
		expect(cb.shouldAllow()).toBe(false);
		now += 30_001; // half-open
		expect(cb.shouldAllow()).toBe(true);
		cb.recordFailure(); // trial fails
		expect(cb.shouldAllow()).toBe(false); // re-opens immediately
	});
});
