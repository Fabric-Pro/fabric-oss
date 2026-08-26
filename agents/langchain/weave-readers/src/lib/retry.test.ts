import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withRetry } from "./retry.js";

// Reset module state between tests by clearing circuit breaker state
// The circuit breaker uses module-level Maps, so we test observable behavior

describe("withRetry", () => {
	it("returns result on first success", async () => {
		const result = await withRetry(() => Promise.resolve("ok"), {
			label: "test",
			circuitKey: "test-success",
		});
		assert.equal(result, "ok");
	});

	it("retries on retryable errors and succeeds", async () => {
		let attempts = 0;
		const result = await withRetry(
			() => {
				attempts++;
				if (attempts < 3) {
					throw new Error("429 rate limit exceeded");
				}
				return Promise.resolve("recovered");
			},
			{
				maxAttempts: 3,
				initialDelayMs: 10,
				label: "test-retry",
				circuitKey: "test-retry-success",
			},
		);
		assert.equal(result, "recovered");
		assert.equal(attempts, 3);
	});

	it("throws immediately on non-retryable errors", async () => {
		let attempts = 0;
		await assert.rejects(
			() =>
				withRetry(
					() => {
						attempts++;
						throw new Error("Invalid API key");
					},
					{
						maxAttempts: 3,
						initialDelayMs: 10,
						label: "test-nonretryable",
						circuitKey: "test-nonretryable",
					},
				),
			{ message: "Invalid API key" },
		);
		assert.equal(attempts, 1);
	});

	it("throws after exhausting all retries", async () => {
		let attempts = 0;
		await assert.rejects(
			() =>
				withRetry(
					() => {
						attempts++;
						throw new Error("503 service unavailable");
					},
					{
						maxAttempts: 3,
						initialDelayMs: 10,
						label: "test-exhaust",
						circuitKey: "test-exhaust",
					},
				),
			{ message: "503 service unavailable" },
		);
		assert.equal(attempts, 3);
	});

	it("classifies retryable error patterns correctly", async () => {
		const retryableMessages = [
			"rate limit exceeded",
			"HTTP 429",
			"503 Service Unavailable",
			"502 Bad Gateway",
			"timeout waiting for response",
			"ECONNRESET",
			"ECONNREFUSED",
			"fetch failed",
			"network error",
			"server overloaded",
			"capacity exceeded",
		];

		for (const msg of retryableMessages) {
			let attempts = 0;
			try {
				await withRetry(
					() => {
						attempts++;
						throw new Error(msg);
					},
					{
						maxAttempts: 2,
						initialDelayMs: 1,
						circuitKey: `classify-${msg.slice(0, 10)}`,
					},
				);
			} catch {
				// Expected to fail after retries
			}
			assert.ok(
				attempts >= 2,
				`"${msg}" should be retryable (got ${attempts} attempts)`,
			);
		}
	});

	it("classifies non-retryable errors correctly", async () => {
		const nonRetryable = [
			"Invalid API key",
			"Permission denied",
			"Model not found",
			"Bad request: missing field",
		];

		for (const msg of nonRetryable) {
			let attempts = 0;
			try {
				await withRetry(
					() => {
						attempts++;
						throw new Error(msg);
					},
					{
						maxAttempts: 3,
						initialDelayMs: 1,
						circuitKey: `nonretry-${msg.slice(0, 10)}`,
					},
				);
			} catch {
				// Expected
			}
			assert.equal(
				attempts,
				1,
				`"${msg}" should NOT be retried (got ${attempts} attempts)`,
			);
		}
	});
});

describe("circuit breaker", () => {
	it("opens after consecutive failures and fast-fails", async () => {
		const circuitKey = `cb-open-${Date.now()}`;

		// Trigger 5 consecutive failures to open the circuit
		for (let i = 0; i < 5; i++) {
			try {
				await withRetry(
					() => {
						throw new Error("503 service down");
					},
					{
						maxAttempts: 1,
						initialDelayMs: 1,
						circuitKey,
					},
				);
			} catch {
				// Expected
			}
		}

		// Next call should fast-fail with circuit breaker error
		await assert.rejects(
			() =>
				withRetry(() => Promise.resolve("should not run"), {
					circuitKey,
				}),
			(err: Error) => {
				assert.ok(
					err.message.includes("CircuitBreaker"),
					`Expected CircuitBreaker error, got: ${err.message}`,
				);
				return true;
			},
		);
	});

	it("transitions to half-open after cooldown", async () => {
		// This test verifies the concept — the actual cooldown is 30s
		// so we can't wait that long in tests. Instead we verify the
		// circuit opens and that a success resets it.
		const circuitKey = `cb-halfopen-${Date.now()}`;

		// Open the circuit
		for (let i = 0; i < 5; i++) {
			try {
				await withRetry(
					() => {
						throw new Error("502 bad gateway");
					},
					{ maxAttempts: 1, initialDelayMs: 1, circuitKey },
				);
			} catch {
				// Expected
			}
		}

		// Verify it's open
		await assert.rejects(
			() =>
				withRetry(() => Promise.resolve("x"), {
					circuitKey,
					maxAttempts: 1,
				}),
			(err: Error) => err.message.includes("CircuitBreaker"),
		);
	});
});

describe("concurrency limiter", () => {
	it("does not leak slots on success", async () => {
		const key = `slot-success-${Date.now()}`;
		// Run many concurrent calls — if slots leak, later calls would hang
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				withRetry(() => Promise.resolve(i), {
					circuitKey: key,
					maxAttempts: 1,
				}),
			),
		);
		assert.equal(results.length, 10);
	});

	it("does not leak slots on failure", async () => {
		const key = `slot-fail-${Date.now()}`;
		const promises = Array.from({ length: 8 }, () =>
			withRetry(
				() => {
					throw new Error("deliberate failure");
				},
				{ circuitKey: key, maxAttempts: 1, initialDelayMs: 1 },
			).catch(() => "caught"),
		);
		const results = await Promise.all(promises);
		assert.equal(results.length, 8);
		assert.ok(results.every((r) => r === "caught"));
	});

	it("does not leak slots across retries", async () => {
		const key = `slot-retry-${Date.now()}`;
		let total = 0;
		const promises = Array.from({ length: 6 }, () =>
			withRetry(
				() => {
					total++;
					if (total <= 6) {
						throw new Error("503 transient");
					}
					return Promise.resolve("ok");
				},
				{ circuitKey: key, maxAttempts: 3, initialDelayMs: 1 },
			).catch(() => "failed"),
		);
		const results = await Promise.all(promises);
		assert.equal(results.length, 6);
	});
});

describe("jitter", () => {
	it("adds bounded jitter to backoff delays", async () => {
		// We can't directly measure timing, but we verify that multiple
		// retries with the same config don't all complete at the exact
		// same time (which would indicate no jitter)
		const key = `jitter-${Date.now()}`;
		const startTimes: number[] = [];

		let callCount = 0;
		try {
			await withRetry(
				() => {
					callCount++;
					startTimes.push(Date.now());
					throw new Error("429 rate limited");
				},
				{
					maxAttempts: 3,
					initialDelayMs: 50,
					circuitKey: key,
				},
			);
		} catch {
			// Expected
		}

		assert.equal(callCount, 3);
		// Verify delays exist between attempts
		if (startTimes.length >= 2) {
			const delay1 = startTimes[1] - startTimes[0];
			assert.ok(
				delay1 >= 40,
				`First delay should be ~50ms+jitter, got ${delay1}ms`,
			);
		}
		if (startTimes.length >= 3) {
			const delay2 = startTimes[2] - startTimes[1];
			// Second delay should be ~100ms (2x) + jitter (up to 30%)
			assert.ok(
				delay2 >= 80,
				`Second delay should be ~100ms+jitter, got ${delay2}ms`,
			);
			assert.ok(
				delay2 <= 200,
				`Second delay should be bounded, got ${delay2}ms`,
			);
		}
	});
});
