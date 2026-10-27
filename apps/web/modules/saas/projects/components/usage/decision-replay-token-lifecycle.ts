const REFRESH_EARLY_MS = 5 * 60_000;
const REUSE_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 30_000;

type Token = { token: string; expiresAt: string };
type Phase =
	| "loading"
	| "valid"
	| "refreshing"
	| "prepared"
	| "retrying"
	| "recovering"
	| "unavailable"
	| "disposed";

/** One project-scoped owner for SDK token handoffs, deadlines and retries.
 * A prepared token is only a candidate: it cannot extend the SDK's deadline.
 * current advances on getNewToken resolution or confirmed frame creation.
 */
export function createReplayTokenLifecycle<T extends Token>({
	mint,
	onToken,
	onUnavailable,
	onError,
}: {
	mint: () => Promise<T>;
	onToken: (token: T, recreate: boolean) => void;
	onUnavailable: () => void;
	onError?: (error: unknown) => void;
}) {
	type Minted = { value: T; expiresAt: number; mintedAt: number };
	let phase: Phase = "loading";
	let current: Minted | undefined;
	let candidate: Minted | undefined;
	let inflight = false;
	let failures = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	const waiters = new Set<{
		resolve: (token: string) => void;
		reject: (error: Error) => void;
	}>();
	const closed = () => phase === "disposed" || phase === "unavailable";
	const error = () => new Error("Dashboard access unavailable");
	const fresh = (token: Minted) =>
		token.expiresAt - Date.now() > REFRESH_EARLY_MS;
	function clearTimers() {
		clearTimeout(refreshTimer);
		clearTimeout(expiryTimer);
		clearTimeout(recoveryTimer);
	}
	function rejectWaiters() {
		for (const waiter of waiters) {
			waiter.reject(error());
		}
		waiters.clear();
	}
	function stop(next: "disposed" | "unavailable") {
		if (closed()) {
			return;
		}
		phase = next;
		clearTimers();
		current = undefined;
		candidate = undefined;
		rejectWaiters();
		if (next === "unavailable") {
			onUnavailable();
		}
	}
	function retry() {
		phase = "retrying";
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(wake, failures++ === 0 ? 30_000 : 60_000);
	}
	function recover() {
		if (closed() || phase === "recovering") {
			return;
		}
		phase = "recovering";
		clearTimers();
		candidate = undefined;
		// SDK callers are bounded by the token they actually hold. The expired
		// frame gets one bounded recovery attempt, including when timers wake late.
		rejectWaiters();
		recoveryTimer = setTimeout(
			() => stop("unavailable"),
			RECOVERY_TIMEOUT_MS,
		);
		request();
	}
	function wake() {
		if (closed()) {
			return;
		}
		const held = current ?? candidate;
		if (held && Date.now() >= held.expiresAt) {
			recover();
		} else if (
			phase === "retrying" ||
			!held ||
			Date.now() >= held.expiresAt - REFRESH_EARLY_MS
		) {
			// A usable pre-mint is already waiting for the SDK; focus events must
			// neither replace the held token nor keep minting more candidates.
			if (current && candidate && fresh(candidate)) {
				return;
			}
			request();
		}
	}
	function expire() {
		if (closed()) {
			return;
		}
		const held = current ?? candidate;
		if (held && Date.now() >= held.expiresAt) {
			recover();
		}
	}
	function handoff(token: Minted) {
		current = token;
		candidate = undefined;
		phase = "valid";
		failures = 0;
		clearTimers();
		expiryTimer = setTimeout(expire, token.expiresAt - Date.now());
		if (fresh(token)) {
			for (const waiter of waiters) {
				waiter.resolve(token.value.token);
			}
			waiters.clear();
			refreshTimer = setTimeout(
				wake,
				token.expiresAt - Date.now() - REFRESH_EARLY_MS,
			);
		} else {
			// A short initial token may create a frame but cannot feed the SDK's
			// zero-delay refresh timer. Waiters still need a fresh mint.
			retry();
		}
	}
	function request() {
		if (closed() || inflight) {
			return;
		}
		inflight = true;
		clearTimeout(refreshTimer);
		if (phase !== "loading" && phase !== "recovering") {
			phase = "refreshing";
		}
		void (async () => mint())()
			.then((value) => {
				inflight = false;
				if (closed()) {
					return;
				}
				const now = Date.now();
				const minted = {
					value,
					expiresAt: Date.parse(value.expiresAt),
					mintedAt: now,
				};
				if (
					!Number.isFinite(minted.expiresAt) ||
					minted.expiresAt <= now
				) {
					throw error();
				}
				if (current && !fresh(minted)) {
					throw error();
				}
				candidate = minted;
				failures = 0;
				if (
					!current ||
					now >= current.expiresAt ||
					phase === "recovering"
				) {
					// Initial/replacement frames acknowledge actual SDK creation through
					// confirmMounted. Async imports do not count as a token handoff.
					clearTimeout(expiryTimer);
					expiryTimer = setTimeout(expire, minted.expiresAt - now);
					onToken(value, true);
				} else if (waiters.size) {
					handoff(minted);
				} else {
					phase = "prepared";
					// Keep the expiry timer for current, which the SDK still holds.
				}
			})
			.catch((cause: unknown) => {
				inflight = false;
				if (closed()) {
					return;
				}
				onError?.(cause);
				if (
					!current ||
					Date.now() >= current.expiresAt ||
					phase === "recovering"
				) {
					stop("unavailable");
				} else {
					retry();
				}
			});
	}
	return {
		start: request,
		wake,
		confirmMounted(value: T) {
			if (closed() || candidate?.value !== value) {
				return;
			}
			handoff(candidate);
		},
		getNewToken(): Promise<string> {
			if (closed()) {
				return Promise.reject(error());
			}
			const now = Date.now();
			if (current && now >= current.expiresAt) {
				recover();
				return Promise.reject(error());
			}
			if (
				!inflight &&
				current &&
				fresh(current) &&
				now - current.mintedAt < REUSE_MS
			) {
				return Promise.resolve(current.value.token);
			}
			const pending = new Promise<string>((resolve, reject) =>
				waiters.add({ resolve, reject }),
			);
			if (
				!inflight &&
				phase === "prepared" &&
				candidate &&
				fresh(candidate)
			) {
				handoff(candidate);
			} else if (
				phase !== "retrying" &&
				!((phase === "loading" || phase === "recovering") && candidate)
			) {
				request();
			}
			return pending;
		},
		dispose: () => stop("disposed"),
	};
}
