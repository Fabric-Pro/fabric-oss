"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { TopicStatus } from "./topic-shared";

/**
 * Optimistic topic status (Fizzy #2646), shared by the topic list (Inbox
 * layout) and the topic page.
 *
 * A status write used to leave the control on the OLD value, disabled, until
 * the whole topic list had been re-read — so a save that had worked looked
 * like one that had not. This shows the NEW value, with "Saving…" then
 * "Saved", from the moment it is chosen.
 *
 * The topic stays BUSY (its controls disabled) until a fetch that completed
 * AFTER the write landed has reached the query that owns the topic — the same
 * window the page always had, now showing the right value — or until it is
 * UNLOCKED (below). What makes this simple: until a SUCCESSFUL fetch that
 * completed after the write arrives, what is on screen is the written value,
 * never a cached one that predates the user's own change, so nothing ever has
 * to guess whether it does. `refresh` (the owner's `invalidateQueries`) is
 * called right after the settle time is taken; with TanStack's default
 * `cancelRefetch` it cancels any fetch already in flight and starts a new
 * one, so every fetch that can complete after the settle time started after
 * the server committed the write. All timestamps are this browser's
 * `Date.now()`.
 *
 * Release is judged at READ time (`serverUpdatedAt > settledAt`), so a query
 * that is already newer when the write settles releases it in that same
 * render; an effect only tidies state afterwards.
 *
 * UNLOCKED means the controls work again ("Saved", then idle) but the saved
 * value stays on screen until a successful fetch that completed after the
 * write retires it: the cached value is known to predate the write the server
 * accepted, so it is never swapped back in. A second write started
 * meanwhile replaces the saved value; if it FAILS, the first write's value
 * comes back (still unlocked, and retired by the same rule), not the cached
 * one. Two things unlock a topic:
 * - a confirming fetch that FAILS (`serverErrorAt > settledAt`) — it carries
 *   no new data, and the owner's error UI offers the retry;
 * - a confirming fetch that never arrives: after OVERLAY_MAX_MS the safety
 *   net unlocks the topic, says so in the console and refreshes once more.
 *
 * Held by whoever OWNS the query — `PublishingSuiteList`, or `TopicItemPage`
 * for one topic — never by a row: the refetch that confirms a status change
 * moves the row to another Inbox section, which remounts it.
 */

export type TopicStatusSaveState = "idle" | "saving" | "saved" | "error";

export type TopicStatusOverlay = {
	status: TopicStatus;
	declineReason: string | null;
	publishedUrl: string | null;
};

export type OverlayServerTopic = {
	id: string;
	status: string;
	declineReason: string | null;
	publishedUrl: string | null;
};

/** How long "Saved" stays up after the topic is released or unlocked. */
export const SAVED_DISPLAY_MS = 2500;

/**
 * A confirming refetch that never arrives must not lock a topic forever:
 * after this long the topic is unlocked, still showing the saved value.
 */
export const OVERLAY_MAX_MS = 10_000;

type Entry = {
	token: number;
	overlay: TopicStatusOverlay;
	settledAt: number | null;
	// Set when a failed confirming fetch or the OVERLAY_MAX_MS safety net
	// unlocks the write: no longer busy, but still shown until a successful
	// fetch that completed after the write retires it.
	unlocked: boolean;
	// The SETTLED write this one replaced, if it was still held when this one
	// started. Restored if this write FAILS: that write's value, not the
	// cache's, is the newest the server accepted — and the read-time rule
	// still retires it once a successful fetch newer than it arrives. Read
	// by nothing else. One level is enough: a write cannot start while
	// another is in flight, so the write replaced is the newest accepted
	// one, and whatever IT replaced is older.
	fallback: Entry | null;
};

type Feedback =
	| { state: "saving" | "saved"; token: number }
	| {
			state: "error";
			token: number;
			failedAt: number;
			attempted: TopicStatusOverlay;
	  };

type Timer = ReturnType<typeof setTimeout>;

/**
 * The topic as it should be SHOWN: the overlay's status, reason and URL over
 * the cached ones. The same object when there is no overlay, so a mount at
 * rest renders exactly what it did before this existed.
 */
export function applyStatusOverlay<
	T extends {
		status: string;
		declineReason: string | null;
		publishedUrl: string | null;
	},
>(topic: T, overlay: TopicStatusOverlay | null): T {
	if (!overlay) {
		return topic;
	}
	return {
		...topic,
		status: overlay.status,
		declineReason: overlay.declineReason,
		publishedUrl: overlay.publishedUrl,
	};
}

function without<V>(map: ReadonlyMap<string, V>, id: string) {
	if (!map.has(id)) {
		return map;
	}
	const next = new Map(map);
	next.delete(id);
	return next;
}

function shows(server: OverlayServerTopic, value: TopicStatusOverlay) {
	return (
		server.status === value.status &&
		server.publishedUrl === value.publishedUrl &&
		server.declineReason === value.declineReason
	);
}

function clear(timers: Map<string, Timer>, id: string) {
	const timer = timers.get(id);
	if (timer) {
		clearTimeout(timer);
		timers.delete(id);
	}
}

/**
 * @param serverTopics the topics currently in the owning query. State for a
 *   topic that leaves it is dropped. Their values are read ONLY to word the
 *   indicator after a failed write — never to decide what is shown.
 * @param serverUpdatedAt the owning query's `dataUpdatedAt`. A successful
 *   fetch that completed after a write retires its saved value.
 * @param serverErrorAt the owning query's `errorUpdatedAt`. A fetch that
 *   FAILED after a write unlocks the topic but keeps the saved value on
 *   screen: it carries no newer data than the write.
 */
export function useTopicStatusOverlay(
	serverTopics: ReadonlyArray<OverlayServerTopic>,
	serverUpdatedAt: number,
	serverErrorAt = 0,
) {
	const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(
		() => new Map(),
	);
	const [feedback, setFeedback] = useState<ReadonlyMap<string, Feedback>>(
		() => new Map(),
	);
	// The token of each topic's CURRENT write. "Has a token" is "busy", read
	// synchronously so `run` can refuse a second write in the same tick the
	// first one starts, before any re-render.
	const tokenById = useRef(new Map<string, number>());
	const lastToken = useRef(0);
	const refreshById = useRef(new Map<string, () => unknown>());
	const safetyTimers = useRef(new Map<string, Timer>());
	const savedTimers = useRef(new Map<string, Timer>());
	// Set on unmount: a write that settles after its owner is gone must not
	// arm a timer nobody will clear.
	const disposed = useRef(false);

	// Strictly later: a fetch stamped in the same millisecond as the settle may
	// have started before the commit, so it cannot count. Where the browser
	// coarsens `Date.now()`, the worst case is the OVERLAY_MAX_MS safety net
	// (unlocked, the saved value shown until the next fetch).
	const isReleased = (entry: Entry) =>
		entry.settledAt !== null && serverUpdatedAt > entry.settledAt;
	// The confirming fetch failed: nothing newer than the write arrived, so
	// the saved value stays, but the topic is no longer busy. Judged at read
	// time like release; the tidy step below unlocks it for `run` before paint.
	const readFailedAfterSettle = (entry: Entry) =>
		entry.settledAt !== null && serverErrorAt > entry.settledAt;

	/** Hide "Saved" SAVED_DISPLAY_MS from now — only if it is still that write's. */
	const expireSaved = useCallback((id: string, token: number) => {
		clear(savedTimers.current, id);
		savedTimers.current.set(
			id,
			setTimeout(() => {
				savedTimers.current.delete(id);
				setFeedback((prev) => {
					const current = prev.get(id);
					return current?.state === "saved" && current.token === token
						? without(prev, id)
						: prev;
				});
			}, SAVED_DISPLAY_MS),
		);
	}, []);

	/** End a write's busy window — a no-op unless it is still the current one. */
	const release = useCallback(
		(id: string, token: number) => {
			if (tokenById.current.get(id) !== token) {
				return;
			}
			tokenById.current.delete(id);
			refreshById.current.delete(id);
			clear(safetyTimers.current, id);
			setEntries((prev) =>
				prev.get(id)?.token === token ? without(prev, id) : prev,
			);
			expireSaved(id, token);
		},
		[expireSaved],
	);

	/**
	 * End the busy window but KEEP the saved value on screen — the cached one
	 * predates the write — until a successful fetch that completed after the
	 * write retires it. Returns false, a no-op, unless it is still the
	 * current write.
	 */
	const unlock = useCallback(
		(id: string, token: number): boolean => {
			if (tokenById.current.get(id) !== token) {
				return false;
			}
			tokenById.current.delete(id);
			refreshById.current.delete(id);
			clear(safetyTimers.current, id);
			setEntries((prev) => {
				const entry = prev.get(id);
				return entry?.token === token
					? new Map(prev).set(id, { ...entry, unlocked: true })
					: prev;
			});
			expireSaved(id, token);
			return true;
		},
		[expireSaved],
	);

	/**
	 * The safety net: no confirming fetch arrived at all. Unlock, say so, and
	 * ask for the confirming fetch once more.
	 */
	const unlockUnconfirmed = useCallback(
		(id: string, token: number) => {
			const again = refreshById.current.get(id);
			if (!unlock(id, token)) {
				return;
			}
			console.warn(
				"[publishing] status change not confirmed by a refetch within 10s — unlocked; still showing the saved value",
				{ topicId: id },
			);
			again?.();
		},
		[unlock],
	);

	// Tidy after each change of the server view: release what the owning query
	// has confirmed, unlock what a failed confirming fetch left without an
	// answer, drop topics that left it, and re-word a failed write the server
	// now shows as saved after all. A LAYOUT effect so the busy token is gone
	// before the browser paints the re-enabled control — otherwise a click in
	// the gap would meet `run`'s guard and be refused silently.
	useLayoutEffect(() => {
		// Nothing to tidy at rest — the owner passes a fresh array every render.
		if (entries.size === 0 && feedback.size === 0) {
			return;
		}
		const byId = new Map(serverTopics.map((t) => [t.id, t]));
		for (const [id, entry] of entries) {
			if (!byId.has(id)) {
				tokenById.current.delete(id);
				refreshById.current.delete(id);
				clear(safetyTimers.current, id);
				setEntries((prev) => without(prev, id));
			} else if (
				entry.settledAt !== null &&
				serverUpdatedAt > entry.settledAt
			) {
				if (tokenById.current.get(id) === entry.token) {
					release(id, entry.token);
				} else {
					// Already unlocked: only the saved value is left to drop.
					setEntries((prev) =>
						prev.get(id)?.token === entry.token
							? without(prev, id)
							: prev,
					);
				}
			} else if (
				entry.settledAt !== null &&
				serverErrorAt > entry.settledAt &&
				tokenById.current.get(id) === entry.token
			) {
				// Quietly, and without refreshing again: the read already
				// happened and failed; the owner's error UI offers the retry.
				unlock(id, entry.token);
			}
		}
		for (const [id, item] of feedback) {
			const current = byId.get(id);
			if (!current) {
				clear(savedTimers.current, id);
				setFeedback((prev) => without(prev, id));
			} else if (
				// Data only: a failed read shows nothing newer than the cache.
				item.state === "error" &&
				serverUpdatedAt > item.failedAt &&
				shows(current, item.attempted)
			) {
				setFeedback((prev) =>
					prev.get(id) === item
						? new Map(prev).set(id, {
								state: "saved",
								token: item.token,
							})
						: prev,
				);
				expireSaved(id, item.token);
			}
		}
	}, [
		serverTopics,
		serverUpdatedAt,
		serverErrorAt,
		entries,
		feedback,
		release,
		unlock,
		expireSaved,
	]);

	useEffect(() => {
		// Re-armed on (StrictMode) remount.
		disposed.current = false;
		const safety = safetyTimers.current;
		const saved = savedTimers.current;
		return () => {
			disposed.current = true;
			for (const timer of [...safety.values(), ...saved.values()]) {
				clearTimeout(timer);
			}
			safety.clear();
			saved.clear();
		};
	}, []);

	const run = useCallback(
		async (
			id: string,
			next: TopicStatusOverlay,
			write: () => Promise<unknown>,
			refresh: () => unknown,
		): Promise<void> => {
			if (tokenById.current.has(id)) {
				// Unreachable from the UI — every entry point is disabled while
				// the topic is busy. Silent on purpose (spec §4.1).
				throw new Error(
					"A status change for this topic is still being saved.",
				);
			}
			lastToken.current += 1;
			const token = lastToken.current;
			tokenById.current.set(id, token);
			refreshById.current.set(id, refresh);
			clear(savedTimers.current, id);
			clear(safetyTimers.current, id);
			setEntries((prev) => {
				// From `prev`, not a render-time closure: the entry this write
				// replaces is whatever is there when the update applies.
				const previous = prev.get(id);
				return new Map(prev).set(id, {
					token,
					overlay: next,
					settledAt: null,
					unlocked: false,
					fallback:
						previous && previous.settledAt !== null
							? { ...previous, fallback: null }
							: null,
				});
			});
			setFeedback((prev) =>
				new Map(prev).set(id, { state: "saving", token }),
			);

			try {
				await write();
			} catch (error) {
				const failedAt = Date.now();
				if (tokenById.current.get(id) === token) {
					tokenById.current.delete(id);
					refreshById.current.delete(id);
				}
				// Back to the accepted write this one replaced, if any — never
				// to the cache, which predates it. Restored UNLOCKED (its busy
				// token is not given back) with ITS OWN token and settle time,
				// so the read-time rule retires it at once if a successful fetch
				// newer than it has already arrived, and the tidy step drops it.
				setEntries((prev) => {
					const entry = prev.get(id);
					if (entry?.token !== token) {
						return prev;
					}
					return entry.fallback
						? new Map(prev).set(id, {
								...entry.fallback,
								unlocked: true,
								fallback: null,
							})
						: without(prev, id);
				});
				// Only while this write's own indicator is up: a stale write that
				// fails must not overwrite a newer write's "Saving…".
				setFeedback((prev) =>
					prev.get(id)?.token === token
						? new Map(prev).set(id, {
								state: "error",
								token,
								failedAt,
								attempted: next,
							})
						: prev,
				);
				// A request can fail after the server committed (e.g. the
				// connection drops before the response arrives): let the cache
				// catch up rather than trust the failure.
				refresh();
				throw error;
			}

			if (disposed.current) {
				// The owner is gone (the user navigated away mid-write): nothing
				// on screen to confirm, but the cache should still catch up.
				refresh();
				return;
			}
			if (tokenById.current.get(id) !== token) {
				// The topic left the list while the write was out: nothing on
				// screen waits for it, but the write committed and the cache
				// should still catch up.
				refresh();
				return;
			}
			const settledAt = Date.now();
			setEntries((prev) => {
				const entry = prev.get(id);
				return entry?.token === token
					? new Map(prev).set(id, { ...entry, settledAt })
					: prev;
			});
			setFeedback((prev) =>
				new Map(prev).set(id, { state: "saved", token }),
			);
			safetyTimers.current.set(
				id,
				setTimeout(() => {
					safetyTimers.current.delete(id);
					unlockUnconfirmed(id, token);
				}, OVERLAY_MAX_MS),
			);
			// After the settle time is taken: the fetch this starts is the one
			// that can confirm the write.
			refresh();
		},
		[unlockUnconfirmed],
	);

	const liveEntry = (id: string) => {
		const entry = entries.get(id);
		return entry && !isReleased(entry) ? entry : null;
	};

	return {
		// Shown until retired, unlocked or not.
		overlayFor: (id: string): TopicStatusOverlay | null =>
			liveEntry(id)?.overlay ?? null,
		isBusy: (id: string): boolean => {
			const entry = liveEntry(id);
			return (
				entry !== null &&
				!entry.unlocked &&
				!readFailedAfterSettle(entry)
			);
		},
		saveStateFor: (id: string): TopicStatusSaveState =>
			feedback.get(id)?.state ?? "idle",
		run,
	};
}
