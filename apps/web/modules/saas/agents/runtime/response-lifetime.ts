/** Bind both sides of the SDK's response tee to the HTTP response lifetime. */
export function createAgentResponseLifetime(request: Request) {
	const lifetime = new AbortController();
	const signal = AbortSignal.any([request.signal, lifetime.signal]);
	let failure: { cause: unknown } | undefined;
	const response = (original: Response): Response => {
		if (
			!original.body ||
			original.headers.get("content-type")?.split(";")[0]?.trim() !==
				"text/event-stream"
		) {
			return original;
		}
		const reader = original.body.getReader();
		let closed = false;
		let abort: () => void;
		const release = () => {
			closed = true;
			signal.removeEventListener("abort", abort);
			reader.releaseLock();
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				abort = () => {
					if (closed) {
						return;
					}
					closed = true;
					signal.removeEventListener("abort", abort);
					if (failure) {
						controller.error(failure.cause);
					} else {
						controller.close();
					}
					// The client is gone; a source cancellation failure has no reader.
					void reader
						.cancel(signal.reason)
						.catch(() => undefined)
						.finally(release);
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) {
					abort();
				}
			},
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (closed) {
						return;
					}
					if (done) {
						release();
						controller.close();
					} else {
						controller.enqueue(value);
					}
				} catch (error) {
					if (closed) {
						return;
					}
					release();
					failure = { cause: error };
					controller.error(error);
					lifetime.abort(error);
				}
			},
			async cancel(reason) {
				closed = true;
				signal.removeEventListener("abort", abort);
				lifetime.abort(reason);
				try {
					await reader.cancel(reason);
				} finally {
					release();
				}
			},
		});
		return new Response(body, {
			status: original.status,
			statusText: original.statusText,
			headers: original.headers,
		});
	};
	return {
		// Only POST endpoints stream; keep Next's GET request proxy untouched.
		request:
			request.method === "POST"
				? new Request(request, { signal })
				: request,
		response,
	};
}
