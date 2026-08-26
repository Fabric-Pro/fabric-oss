/**
 * A failed AI run does not always arrive as a failed HTTP response.
 *
 * CopilotKit streams the AG-UI protocol over `text/event-stream`, and the
 * status line is committed the moment the stream opens — before the agent has
 * run at all. Everything that can go wrong after that point (the agent service
 * unreachable or still starting, the provider rejecting the request, the run
 * exceeding its ceiling) can therefore only be reported *inside* the stream, as
 * a terminal `RUN_ERROR` frame on an otherwise perfectly healthy **200**:
 *
 *     HTTP 200 text/event-stream
 *     data: {"type":"RUN_ERROR","message":"fetch failed","code":"INCOMPLETE_STREAM"}
 *
 * Nothing surfaced that. `<CopilotKit onError>` is wired on every chat surface,
 * but v1 only invokes it when a `publicApiKey`/`publicLicenseKey` is set, which
 * a self-hosted deployment has no reason to have — so it never fires here, and
 * `CopilotFetchErrorInterceptor` was written to compensate. That interceptor
 * keys off the HTTP status, and this failure carries a successful one. Between
 * the two the user saw nothing whatsoever: no reply, no error, their own
 * message gone from the thread — an assistant that had simply stopped
 * answering, which is indistinguishable from the feature being broken.
 */

/** The payload of an AG-UI `RUN_ERROR` frame, as far as we rely on it. */
export interface AgUiRunError {
	message?: string;
	code?: string;
}

/**
 * How long a run may send **nothing at all** before the user is told.
 *
 * Deliberately a gap between frames rather than a cap on total duration. A long
 * run is not a stuck one: document generation legitimately takes minutes, and
 * throughout it the stream keeps producing tokens, state deltas and tool
 * events. A run that has sent nothing for a minute and a half is a different
 * animal, and it is the shape with no other signal at all — no error frame to
 * catch, no closed connection, nothing for the status code to say. Capping
 * total duration instead would kill the healthy long runs and still miss this.
 */
export const STREAM_SILENCE_MS = 90_000;

/**
 * Told when a run goes quiet, and again if it comes back.
 *
 * Both halves matter. Announcing a stall the run then recovers from, and
 * leaving that on screen while the assistant visibly answers, is a false alarm
 * of exactly the kind this module exists to prevent — so a stall reported here
 * is expected to be retractable by the caller.
 */
export interface StreamSilenceHooks {
	onSilence?: () => void;
	onResume?: () => void;
	/** Overridable so tests do not have to wait ninety seconds. */
	silenceMs?: number;
}

const RUN_ERROR_TYPE = "RUN_ERROR";

/**
 * Parse one newline-delimited SSE line, returning the `RUN_ERROR` it carries.
 *
 * The cheap `includes` guard matters: a healthy run streams a frame per token,
 * and `JSON.parse` on every one of them would be real work done on the hot path
 * purely to discover it was an ordinary token.
 *
 * A frame that does not parse is skipped rather than thrown — a malformed frame
 * must never break the run the user is waiting on.
 */
function parseRunErrorFrame(line: string): AgUiRunError | null {
	if (!line.startsWith("data:")) {
		return null;
	}
	const payload = line.slice("data:".length).trim();
	if (!payload.includes(RUN_ERROR_TYPE)) {
		return null;
	}
	try {
		const frame = JSON.parse(payload) as {
			type?: unknown;
			message?: unknown;
			code?: unknown;
		};
		if (frame.type !== RUN_ERROR_TYPE) {
			return null;
		}
		return {
			message:
				typeof frame.message === "string" ? frame.message : undefined,
			code: typeof frame.code === "string" ? frame.code : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Watch an AG-UI event stream for the terminal `RUN_ERROR` frame, resolving
 * `null` for a stream that ends without one.
 *
 * The response passed in is left untouched — reading happens on a clone, taken
 * here rather than at the call site so that anything which is not an event
 * stream is rejected *before* a clone exists. That ordering matters: cloning
 * tees the body, and a tee nobody drains buffers the whole response in memory.
 * The clone is taken synchronously, before this function's first `await`, so it
 * is always in place before the caller can start reading its own copy.
 *
 * Reading stops at the first `RUN_ERROR`: the frame is terminal, so there is
 * nothing after it worth draining.
 *
 * A tee's two branches share one pull, so a chunk either branch asks for is
 * enqueued for both. This loop does no rendering, so it will usually run ahead
 * of the app's own parser, and the app's branch — not this one — is where the
 * slack accumulates. That is accepted rather than overlooked: the backlog is
 * bounded by the response, and an AG-UI chat turn is text measured in tens of
 * kilobytes. It would stop being free if a surface ever streamed something
 * substantially larger through this endpoint shape, and the fix then is to pass
 * the body through a transform instead of teeing it, so there is one consumer
 * setting the pace again.
 */
export async function findAgUiRunError(
	response: Response,
	hooks?: StreamSilenceHooks,
): Promise<AgUiRunError | null> {
	if (!response.headers.get("content-type")?.includes("text/event-stream")) {
		return null;
	}
	const body = response.clone().body;
	if (!body) {
		return null;
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";

	// The silence watchdog. Armed before every read and disarmed by the chunk
	// that answers it, so it measures the gap between frames rather than the
	// length of the run.
	const silenceMs = hooks?.silenceMs ?? STREAM_SILENCE_MS;
	let silenceTimer: ReturnType<typeof setTimeout> | undefined;
	let reportedSilence = false;
	const armSilence = () => {
		clearTimeout(silenceTimer);
		if (!hooks?.onSilence && !hooks?.onResume) {
			return;
		}
		silenceTimer = setTimeout(() => {
			reportedSilence = true;
			hooks?.onSilence?.();
		}, silenceMs);
	};
	const noteActivity = () => {
		if (reportedSilence) {
			reportedSilence = false;
			hooks?.onResume?.();
		}
		armSilence();
	};

	try {
		armSilence();
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				// Whatever is left is the last line, which has no trailing
				// newline to have flushed it out of the buffer above.
				return parseRunErrorFrame(buffered.trim());
			}
			noteActivity();
			buffered += decoder.decode(value, { stream: true });
			const lines = buffered.split("\n");
			// The tail is whatever arrived after the last newline — an
			// incomplete line that must wait for the next chunk.
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const runError = parseRunErrorFrame(line.trim());
				if (runError) {
					return runError;
				}
			}
		}
	} finally {
		// Only `noteActivity` retracts, and deliberately so: a stall that ends
		// with the stream simply closing, no content and no error frame, is the
		// failure the notice was raised for. Retracting on any end would clear
		// it in exactly the case the user most needs to keep reading — a run
		// that went quiet and then quietly gave up.
		clearTimeout(silenceTimer);
		// Releases the tee'd buffer whether we stopped early on a hit or ran to
		// the end; without it the clone keeps buffering for a stream nobody is
		// reading any more.
		await reader.cancel().catch(() => undefined);
	}
}
