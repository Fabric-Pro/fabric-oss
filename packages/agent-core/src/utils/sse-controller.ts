/**
 * `createSseController`
 *
 * Wraps a `ReadableStream` controller used for server-sent events. It tracks
 * whether the controller is still open, enqueues without throwing when the
 * client has already disconnected, closes at most once, and can run an SSE
 * keepalive comment timer.
 *
 * A caller whose `cancel()` handler must stop the keepalive creates the wrapper
 * before the `ReadableStream`, because `cancel()` runs outside `start()`;
 * `start()` then calls `attach(controller)`. A caller with no keepalive can
 * create and attach it inside `start()`.
 */

const KEEPALIVE_COMMENT = ":keepalive\n\n";

export interface SseControllerOptions {
	/** Called once when an enqueue discovers the controller is closed. */
	onClosedDuringEnqueue?: () => void;
	/** Called when `controller.close()` throws (already closed). */
	onCloseThrew?: () => void;
}

interface SseKeepaliveOptions {
	intervalMs: number;
	/** Clear the timer when a keepalive enqueue finds the controller closed. */
	stopOnClosed: boolean;
}

export interface SseController {
	/** Binds the stream controller (call from `start()`) and marks it open. */
	attach(controller: ReadableStreamDefaultController<Uint8Array>): void;
	/** True once attached and until closed or found closed by an enqueue. */
	readonly isOpen: boolean;
	/** The attached controller's `desiredSize`, or null when not attached. */
	readonly desiredSize: number | null;
	/**
	 * Enqueues bytes. Returns true if enqueued, false if the controller is
	 * closed. Only `ERR_INVALID_STATE` is treated as closed; other errors
	 * propagate.
	 */
	enqueue(data: Uint8Array): boolean;
	/** Closes the controller once; a throw from `close()` is swallowed. */
	close(): void;
	startKeepalive(options: SseKeepaliveOptions): void;
	/** Clears the keepalive timer; safe to call repeatedly. */
	stopKeepalive(): void;
}

export function createSseController(
	options: SseControllerOptions = {},
): SseController {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let open = false;
	let keepalive: ReturnType<typeof setInterval> | undefined;
	const encoder = new TextEncoder();

	const enqueue = (data: Uint8Array): boolean => {
		if (!(open && controller)) {
			return false;
		}
		try {
			controller.enqueue(data);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ERR_INVALID_STATE") {
				open = false;
				options.onClosedDuringEnqueue?.();
				return false;
			}
			throw error;
		}
	};

	const stopKeepalive = () => {
		if (keepalive !== undefined) {
			clearInterval(keepalive);
			keepalive = undefined;
		}
	};

	return {
		attach(next) {
			controller = next;
			open = true;
		},
		get isOpen() {
			return open;
		},
		get desiredSize() {
			return controller?.desiredSize ?? null;
		},
		enqueue,
		close() {
			if (!(open && controller)) {
				return;
			}
			open = false;
			try {
				controller.close();
			} catch {
				options.onCloseThrew?.();
			}
		},
		startKeepalive({ intervalMs, stopOnClosed }) {
			stopKeepalive();
			keepalive = setInterval(() => {
				if (
					!enqueue(encoder.encode(KEEPALIVE_COMMENT)) &&
					stopOnClosed
				) {
					stopKeepalive();
				}
			}, intervalMs);
		},
		stopKeepalive,
	};
}
