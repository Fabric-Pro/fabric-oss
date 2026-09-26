"use client";

/**
 * Prefetches the roadmap "Add" dialog's duplicate check (Fizzy #2180) while
 * the user is still typing, so the request's latency — cold-start, or the
 * typed-decision-model round trip — has usually already happened by the time
 * they reach for Create. `handleSubmit` still runs `checkBeforeCreate`
 * exactly as before; this hook only supplies WHICH request that runs.
 *
 * One check in flight at a time, keyed by the exact trimmed description: a
 * text change aborts whatever was running for the previous text and starts
 * fresh (after the debounce), so a later, larger edit is never checked
 * against wording the user has already changed.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CheckDuplicateResult } from "./CreateStoryDuplicateWarning";

/**
 * Pause after the last keystroke before prefetching. Long enough that normal
 * typing never fires it on every character, short enough that it has usually
 * settled well before the user finishes the rest of the form and clicks
 * Create.
 */
export const PREFETCH_DEBOUNCE_MS = 1_500;

/**
 * Trimmed description length a prefetch requires. Below this a description
 * is too short to carry real duplicate-detection signal, so prefetching it
 * would only spend rate-limit budget (`ai`, 20/min) on a check that would
 * need redoing anyway once the user has typed enough to matter.
 */
export const PREFETCH_MIN_LENGTH = 20;

/** Client-side abort for `checkDuplicate`, shared by the prefetch and the
 * submit-time fallback call — wide relative to the server's own ~20s request
 * deadline so that deadline, not this one, is what normally fires. */
const CHECK_DUPLICATE_CLIENT_TIMEOUT_MS = 30_000;

type PrefetchEntry = {
	text: string;
	promise: Promise<CheckDuplicateResult>;
	controller: AbortController;
	status: "pending" | "settled" | "rejected";
};

export interface UseDuplicateCheckPrefetchParams {
	projectId: string;
	organizationId: string | null;
}

export interface DuplicateCheckPrefetch {
	/** Call on every keystroke. Debounces, then prefetches once the trimmed
	 * text clears the length threshold; a text change cancels whatever was
	 * running for the previous text, debounced or not. */
	onDescriptionChange: (text: string) => void;
	/** Call when the description textarea loses focus. Prefetches
	 * immediately (no debounce) under the same length threshold. */
	onDescriptionBlur: (text: string) => void;
	/**
	 * The request `checkBeforeCreate` should run for `text` at submit time:
	 * the settled or in-flight prefetch for that EXACT text when there is
	 * one, otherwise a fresh call — never both, and never a prefetch that
	 * already rejected (network error, abort, rate limit), which gets a
	 * fresh attempt instead of its own stale failure.
	 */
	getCheckRun: (text: string) => () => Promise<CheckDuplicateResult>;
	/** Drops any cached or in-flight prefetch and cancels its request. Call
	 * when the dialog closes and after a successful create or enrich. */
	reset: () => void;
}

export function useDuplicateCheckPrefetch({
	projectId,
	organizationId,
}: UseDuplicateCheckPrefetchParams): DuplicateCheckPrefetch {
	const entryRef = useRef<PrefetchEntry | null>(null);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearDebounce = useCallback(() => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
	}, []);

	const reset = useCallback(() => {
		clearDebounce();
		entryRef.current?.controller.abort();
		entryRef.current = null;
	}, [clearDebounce]);

	useEffect(() => {
		return reset;
	}, [reset]);

	const startPrefetch = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed.length < PREFETCH_MIN_LENGTH) {
				return;
			}
			if (entryRef.current?.text === trimmed) {
				// Already covered — settled, or already in flight.
				return;
			}
			// A different text superseded whatever was in flight; cancel it
			// so its eventual result is never mistaken for this text's.
			entryRef.current?.controller.abort();

			const controller = new AbortController();
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(CHECK_DUPLICATE_CLIENT_TIMEOUT_MS),
			]);
			const promise = orpcClient.projects.stories.checkDuplicate(
				{ projectId, organizationId, description: trimmed },
				{ signal },
			);
			const entry: PrefetchEntry = {
				text: trimmed,
				promise,
				controller,
				status: "pending",
			};
			entryRef.current = entry;
			// Side-channel status only — `entry.promise` stays the original,
			// unwrapped promise, so awaiting it later reproduces exactly what
			// the caller would have seen resolving or rejecting it directly.
			promise.then(
				() => {
					entry.status = "settled";
				},
				() => {
					entry.status = "rejected";
				},
			);
		},
		[projectId, organizationId],
	);

	const onDescriptionChange = useCallback(
		(text: string) => {
			clearDebounce();
			const trimmed = text.trim();
			if (entryRef.current && entryRef.current.text !== trimmed) {
				entryRef.current.controller.abort();
				entryRef.current = null;
			}
			if (trimmed.length < PREFETCH_MIN_LENGTH) {
				return;
			}
			debounceTimerRef.current = setTimeout(() => {
				debounceTimerRef.current = null;
				startPrefetch(text);
			}, PREFETCH_DEBOUNCE_MS);
		},
		[clearDebounce, startPrefetch],
	);

	const onDescriptionBlur = useCallback(
		(text: string) => {
			clearDebounce();
			startPrefetch(text);
		},
		[clearDebounce, startPrefetch],
	);

	const getCheckRun = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			const entry = entryRef.current;
			if (
				entry &&
				entry.text === trimmed &&
				entry.status !== "rejected"
			) {
				return () => entry.promise;
			}
			return () =>
				orpcClient.projects.stories.checkDuplicate(
					{ projectId, organizationId, description: trimmed },
					{
						signal: AbortSignal.timeout(
							CHECK_DUPLICATE_CLIENT_TIMEOUT_MS,
						),
					},
				);
		},
		[projectId, organizationId],
	);

	return useMemo(
		() => ({ onDescriptionChange, onDescriptionBlur, getCheckRun, reset }),
		[onDescriptionChange, onDescriptionBlur, getCheckRun, reset],
	);
}
