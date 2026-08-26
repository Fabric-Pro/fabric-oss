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
		// process.exit() with no argument honors the test-result exitCode set
		// by vitest. Wrapping in setTimeout (.unref()'d) gives in-flight async
		// work a moment to settle before the forced exit.
		setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
	};
}
