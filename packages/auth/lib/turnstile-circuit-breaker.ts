export interface CircuitBreaker {
	shouldAllow(): boolean;
	recordFailure(): void;
	recordSuccess(): void;
}

interface CircuitBreakerOptions {
	failureThreshold: number;
	windowMs: number;
	cooldownMs: number;
	now?: () => number;
}

export function createCircuitBreaker(
	opts: CircuitBreakerOptions,
): CircuitBreaker {
	const now = opts.now ?? (() => Date.now());
	let failures: number[] = [];
	let openedAt: number | null = null;

	function pruneFailures() {
		const cutoff = now() - opts.windowMs;
		failures = failures.filter((t) => t >= cutoff);
	}

	return {
		shouldAllow() {
			if (openedAt === null) {
				return true;
			}
			if (now() - openedAt >= opts.cooldownMs) {
				return true;
			}
			return false;
		},
		recordFailure() {
			pruneFailures();
			failures.push(now());
			if (openedAt !== null || failures.length >= opts.failureThreshold) {
				openedAt = now();
			}
		},
		recordSuccess() {
			failures = [];
			openedAt = null;
		},
	};
}
