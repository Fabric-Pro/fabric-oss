/**
 * Vitest globalTeardown hack: force the main vitest process to exit even when
 * test code leaks open handles (PrismaPg pool, gRPC keep-alive, etc.). Vitest's
 * `teardownTimeout` is supposed to do this but doesn't reliably force-kill the
 * main process — see vitest issue #3909. Without this, post-test hangs of 2-5
 * minutes are common in CI for packages with heavy module graphs.
 *
 * The teardown runs AFTER vitest has reported test results and set
 * process.exitCode based on pass/fail. `process.exit()` with no argument
 * uses that exitCode, so we preserve the test result. The setTimeout
 * is .unref()'d so it doesn't itself block a natural exit on the rare
 * case the process was about to exit cleanly anyway.
 */
export default function setup() {
	return async () => {
		// `process.exit()` does not wait for the event loop to drain, which is
		// the whole point here — it leaves regardless of what is still holding a
		// handle open.
		//
		// This used to call `process._exit` through a hand-written cast that
		// asserted the method existed. It does not: Node's internal is
		// `reallyExit`, and `_exit` has never been on `process`. So the timer
		// threw `TypeError: process._exit is not a function` AFTER vitest had
		// printed its results, and the runner exited 1 on a fully green suite —
		// every local run reported failure and the real exit code was lost. The
		// cast is what hid it, by promising the type system a method nobody had
		// checked for.
		setTimeout(
			() =>
				process.exit(
					typeof process.exitCode === "number" ? process.exitCode : 0,
				),
			500,
		).unref();
	};
}
