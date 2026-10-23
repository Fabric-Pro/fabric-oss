/** Bound model resolution and generation even when a provider ignores abort. */
export async function withTranscriptSummaryTimeout<T>(
	call: (signal: AbortSignal) => Promise<T | null>,
	timeoutMs: number,
	cancellationSignal?: AbortSignal,
): Promise<{ summary: T | null; timedOut: boolean; latencyMs: number }> {
	const startedAt = Date.now();
	let timedOut = false;
	const controller = new AbortController();
	const cancel = () => controller.abort(cancellationSignal?.reason);
	if (cancellationSignal?.aborted) {
		return { summary: null, timedOut: false, latencyMs: 0 };
	}
	cancellationSignal?.addEventListener("abort", cancel, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const stopped = new Promise<null>((resolve) => {
			onAbort = () => resolve(null);
			controller.signal.addEventListener("abort", onAbort, {
				once: true,
			});
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort(new Error("Meeting summary deadline reached"));
			}, timeoutMs);
		});
		const summary = await Promise.race([call(controller.signal), stopped]);
		return { summary, timedOut, latencyMs: Date.now() - startedAt };
	} finally {
		clearTimeout(timer);
		cancellationSignal?.removeEventListener("abort", cancel);
		if (onAbort) {
			controller.signal.removeEventListener("abort", onAbort);
		}
	}
}
