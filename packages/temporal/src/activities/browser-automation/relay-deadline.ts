/**
 * One deadline for everything a single intercepted request makes the relay do.
 * A timer rather than `AbortSignal.timeout` so callers can dispose it when a
 * relay response finishes early.
 */
export function createRelayDeadline(timeoutMs: number): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException(
					`Relayed request exceeded ${timeoutMs} ms`,
					"TimeoutError",
				),
			),
		timeoutMs,
	);
	return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
