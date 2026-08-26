/**
 * Retry with exponential backoff, circuit breaker, and concurrency limiter
 * for resilient LLM calls in weave agent services.
 */

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

const RETRYABLE_PATTERNS = [
	"rate limit",
	"429",
	"503",
	"502",
	"timeout",
	"econnreset",
	"econnrefused",
	"fetch failed",
	"network",
	"overloaded",
	"capacity",
];

function isRetryable(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();
	return RETRYABLE_PATTERNS.some((p) => message.includes(p));
}

// ---------------------------------------------------------------------------
// Circuit Breaker — fast-fail after repeated LLM failures
// ---------------------------------------------------------------------------

interface CircuitState {
	failures: number;
	lastFailure: number;
	state: "closed" | "open" | "half-open";
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 30_000;
const circuits = new Map<string, CircuitState>();

function getCircuit(provider: string): CircuitState {
	let circuit = circuits.get(provider);
	if (!circuit) {
		circuit = { failures: 0, lastFailure: 0, state: "closed" };
		circuits.set(provider, circuit);
	}
	// Auto-transition from open -> half-open after cooldown
	if (
		circuit.state === "open" &&
		Date.now() - circuit.lastFailure > CIRCUIT_RESET_MS
	) {
		circuit.state = "half-open";
	}
	return circuit;
}

function recordSuccess(provider: string) {
	const circuit = getCircuit(provider);
	circuit.failures = 0;
	circuit.state = "closed";
}

function recordFailure(provider: string) {
	const circuit = getCircuit(provider);
	circuit.failures++;
	circuit.lastFailure = Date.now();
	if (circuit.failures >= CIRCUIT_THRESHOLD) {
		circuit.state = "open";
		console.error(
			`[CircuitBreaker] OPEN for "${provider}" after ${circuit.failures} consecutive failures`,
		);
	}
}

// ---------------------------------------------------------------------------
// Concurrency Limiter — prevent overwhelming the single-process event loop
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_LLM_CALLS || "4");
let activeCount = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
	if (activeCount < MAX_CONCURRENT) {
		activeCount++;
		return;
	}
	return new Promise<void>((resolve) => {
		waitQueue.push(() => {
			activeCount++;
			resolve();
		});
	});
}

function releaseSlot() {
	activeCount--;
	const next = waitQueue.shift();
	if (next) {
		next();
	}
}

// ---------------------------------------------------------------------------
// withRetry — combines retry, circuit breaker, and concurrency limiter
// ---------------------------------------------------------------------------

export async function withRetry<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts?: number;
		initialDelayMs?: number;
		label?: string;
		circuitKey?: string;
	} = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 3;
	const initialDelay = options.initialDelayMs ?? 1000;
	const label = options.label ?? "operation";
	const circuitKey = options.circuitKey ?? "llm";

	// Circuit breaker check
	const circuit = getCircuit(circuitKey);
	if (circuit.state === "open") {
		throw new Error(
			`[CircuitBreaker] "${circuitKey}" is OPEN — fast-failing. Will probe in ${Math.ceil((CIRCUIT_RESET_MS - (Date.now() - circuit.lastFailure)) / 1000)}s`,
		);
	}

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// Acquire concurrency slot per attempt — released before backoff sleep
		// so we don't hold a slot while waiting
		await acquireSlot();
		try {
			const result = await fn();
			recordSuccess(circuitKey);
			return result;
		} catch (error) {
			lastError = error;

			if (attempt === maxAttempts || !isRetryable(error)) {
				recordFailure(circuitKey);
				throw error;
			}

			// Exponential backoff + jitter to avoid synchronized retries
			const baseDelay = initialDelay * 2 ** (attempt - 1);
			const jitter = Math.random() * baseDelay * 0.3;
			const delay = Math.round(baseDelay + jitter);
			console.warn(
				`[Retry] ${label} attempt ${attempt}/${maxAttempts} failed (retrying in ${delay}ms):`,
				error instanceof Error ? error.message : error,
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		} finally {
			releaseSlot();
		}
	}

	recordFailure(circuitKey);
	throw lastError;
}
