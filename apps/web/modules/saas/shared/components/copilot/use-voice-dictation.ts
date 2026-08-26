"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Shared voice-dictation state machine for any chat input surface
 * (CopilotSidebarInput / Loom + Fabric Agent ChatInput). Single-shot
 * recognizer (`continuous = false`, `interimResults = false`) with auto-
 * retry on silent ends — see comments on `startRecognition` for the full
 * rationale carried over from CopilotSidebarInput PR #828 / #839.
 *
 * Owning the lifecycle in one hook means future changes (lang, retry
 * budget, error copy, telemetry) ship to every surface at once.
 */

/** Format seconds as `M:SS` for the in-row recording timer. */
export function formatRecordingDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface UseVoiceDictationOptions {
	/**
	 * Called with the recognized transcript whenever a session yields a
	 * result. The consumer owns the textarea state and decides how to
	 * append (e.g., prepend a single space when there's already text).
	 */
	onTranscript: (transcript: string) => void;
	/**
	 * When true the recognizer is forcibly stopped if active and `toggle()`
	 * becomes a no-op. Mirror this to `inProgress`/`isLoading` so the mic
	 * auto-stops the moment the AI starts responding — the textarea is
	 * disabled in that state and any active recognizer would silently
	 * buffer audio the user can no longer send.
	 */
	disabled?: boolean;
}

export interface UseVoiceDictationResult {
	/** Currently recording — `true` between click and first natural pause. */
	isRecording: boolean;
	/** Browser exposes `SpeechRecognition` (or `webkitSpeechRecognition`). */
	hasSpeechSupport: boolean;
	/** Seconds elapsed since recording started — drives the M:SS chip. */
	recordingSeconds: number;
	/** Toggle recording on click (start if idle, stop if recording). */
	toggle: () => void;
	/** Idempotent stop — safe to call from cleanup paths. */
	stop: () => void;
}

export function useVoiceDictation({
	onTranscript,
	disabled = false,
}: UseVoiceDictationOptions): UseVoiceDictationResult {
	const [isRecording, setIsRecording] = useState(false);
	const [hasSpeechSupport, setHasSpeechSupport] = useState(false);
	const [recordingSeconds, setRecordingSeconds] = useState(0);
	const recognitionRef = useRef<any>(null);
	const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Auto-retry counter (per click cycle) and stop flag — see
	// startRecognition for the retry rationale.
	const retryCountRef = useRef(0);
	const stopRequestedRef = useRef(false);
	// Most recent transient-error code in the current click cycle. Used by
	// onend to decide whether retry-exhaustion should surface a toast (network
	// → yes, the user wants to know; no-speech → no, silence is valid). A
	// successful result, manual stop, or fresh click cycle clears this so a
	// stale code never haunts the next session.
	const lastErrorCodeRef = useRef<string | null>(null);
	// Keep the latest `onTranscript` in a ref so the recognizer's `onresult`
	// handler always calls through to the freshest closure without forcing
	// the consumer to memoize.
	const onTranscriptRef = useRef(onTranscript);
	useEffect(() => {
		onTranscriptRef.current = onTranscript;
	}, [onTranscript]);

	// Namespace matches the existing `tTooltips("voiceInput.*")` callsites in
	// CopilotSidebarInput so the i18n keys (and the unit-test assertions that
	// rely on next-intl returning the leaf key verbatim) stay identical.
	const tTooltips = useTranslations("tooltips.copilot");

	useEffect(() => {
		const supported = !!(
			(window as any).SpeechRecognition ||
			(window as any).webkitSpeechRecognition
		);
		setHasSpeechSupport(supported);
	}, []);

	useEffect(() => {
		return () => {
			if (tickIntervalRef.current) {
				clearInterval(tickIntervalRef.current);
				tickIntervalRef.current = null;
			}
			const recognition = recognitionRef.current;
			if (recognition) {
				// Detach handlers BEFORE stop so the async `onend` /
				// `onresult` that follow do not setState on an unmounted
				// component, and the SR instance becomes eligible for GC.
				recognition.onresult = null;
				recognition.onerror = null;
				recognition.onend = null;
				recognition.stop();
				recognitionRef.current = null;
			}
		};
	}, []);

	const stopRecordingTick = useCallback(() => {
		if (tickIntervalRef.current) {
			clearInterval(tickIntervalRef.current);
			tickIntervalRef.current = null;
		}
	}, []);

	// Voice dictation lifecycle — single-shot per click with auto-retry.
	//
	// Why single-shot: Chromium's `continuous = true` mode often only emits
	// interim results that never finalize, so the transcript never reaches
	// the textarea (PR #828). Single-shot is reliable but ends after the
	// first natural pause.
	//
	// Why auto-retry on silent end: the two most common failures are
	// `no-speech` (Chromium fails to register audio in the first ~200-500ms
	// after `start()` while spinning up) and `network` (online recognition
	// service flaky WebSocket handshake — emitted often enough that treating
	// it as terminal scolded the user with a toast even after they'd just
	// dictated successfully). Both recover on the next attempt the vast
	// majority of the time. We auto-retry up to 2 times; on retry-
	// exhaustion the right toast is surfaced based on which code was last
	// seen (see `onend` below).
	//
	// Why defensive abort + ref-clearing: Chromium retains an internal handle
	// to the previous recognizer after `onend` fires. Without explicit abort,
	// `recognition.start()` throws InvalidStateError on subsequent clicks and
	// the mic silently does nothing.
	const startRecognition = useCallback(() => {
		const SpeechRecognition =
			(window as any).SpeechRecognition ||
			(window as any).webkitSpeechRecognition;
		if (!SpeechRecognition) {
			return;
		}

		const previous = recognitionRef.current;
		if (previous) {
			try {
				previous.onresult = null;
				previous.onerror = null;
				previous.onend = null;
				previous.abort();
			} catch {}
			recognitionRef.current = null;
		}

		const recognition = new SpeechRecognition();
		recognition.continuous = false;
		recognition.interimResults = false;
		recognition.lang = "en-US";

		let gotResultThisSession = false;

		recognition.onresult = (event: any) => {
			gotResultThisSession = true;
			const transcript = event.results[0][0].transcript as string;
			onTranscriptRef.current(transcript);
			// A successful capture supersedes any transient errors earlier in
			// this cycle (Chromium sometimes fires a trailing `network` event
			// AFTER `onresult` succeeds — without this, the user would see a
			// false-alarm toast despite having their transcript in the input).
			lastErrorCodeRef.current = null;
			// Visual stop the moment we have the transcript — onend will
			// follow shortly and clear the tick.
			setIsRecording(false);
		};

		recognition.onerror = (event: any) => {
			const code = event?.error;

			// Transient errors — swallow and let `onend` decide whether to
			// auto-retry. `no-speech` happens when Chromium fails to register
			// audio in the first ~200-500ms after `start()`; `network` is
			// emitted by Chromium's online recognition service on flaky
			// WebSocket handshakes. Both recover on the next attempt the
			// vast majority of the time. We remember which one fired so
			// retry-exhaustion can surface the right toast (network → tell
			// the user, no-speech → stay silent).
			if (code === "no-speech" || code === "network") {
				lastErrorCodeRef.current = code;
				return;
			}

			if (code === "not-allowed" || code === "service-not-allowed") {
				toast.error(tTooltips("voiceInput.denied"));
			} else if (code === "audio-capture") {
				toast.error(tTooltips("voiceInput.noDevice"));
			}
			// `aborted` and any unknown error: silent stop, no retry, no
			// toast — `aborted` is the manual-stop / unmount / tab-hidden
			// teardown signal and the user already knows they triggered it.
			stopRequestedRef.current = true;
			setIsRecording(false);
		};

		recognition.onend = () => {
			if (recognitionRef.current === recognition) {
				recognitionRef.current = null;
			}

			if (stopRequestedRef.current) {
				setIsRecording(false);
				stopRecordingTick();
				retryCountRef.current = 0;
				// Manual stop / unmount / tab-hide supersedes any pending
				// transient error — don't pop a toast the user can no
				// longer act on.
				lastErrorCodeRef.current = null;
				return;
			}

			if (gotResultThisSession) {
				setIsRecording(false);
				stopRecordingTick();
				retryCountRef.current = 0;
				// Already cleared in onresult; reassert here so a tail-error
				// fired between onresult and onend (Chromium does this) can't
				// leak into the next click cycle.
				lastErrorCodeRef.current = null;
				return;
			}

			const MAX_RETRIES = 2;
			if (retryCountRef.current < MAX_RETRIES) {
				retryCountRef.current += 1;
				queueMicrotask(() => {
					if (!stopRequestedRef.current) {
						startRecognition();
					}
				});
				return;
			}

			// Max retries hit with no result. Capture and clear the last
			// error code BEFORE setState so a re-render can't observe a
			// stale value.
			const lastError = lastErrorCodeRef.current;
			lastErrorCodeRef.current = null;
			retryCountRef.current = 0;
			setIsRecording(false);
			stopRecordingTick();

			// `no-speech` exhaustion: stay silent — the user clicked the mic
			// but never spoke. Silence is a valid outcome.
			// `network` exhaustion: surface the toast — the user spoke (or
			// tried to) and Chromium's recognition service kept failing.
			// They should know to type instead.
			if (lastError === "network") {
				toast.error(tTooltips("voiceInput.network"));
			}
		};

		recognitionRef.current = recognition;
		try {
			recognition.start();
		} catch {
			recognitionRef.current = null;
			retryCountRef.current = 0;
			setIsRecording(false);
			stopRecordingTick();
			return;
		}

		setIsRecording(true);
		// Only reset the timer on the initial start, not on auto-retry — the
		// click cycle should feel continuous.
		if (tickIntervalRef.current === null) {
			setRecordingSeconds(0);
			tickIntervalRef.current = setInterval(() => {
				setRecordingSeconds((s) => s + 1);
			}, 1000);
		}
	}, [tTooltips, stopRecordingTick]);

	const stop = useCallback(() => {
		stopRequestedRef.current = true;
		retryCountRef.current = 0;
		// User-initiated stop — discard any transient error tracked this
		// cycle so it can't pop a toast after we've already torn down.
		lastErrorCodeRef.current = null;
		const r = recognitionRef.current;
		if (r) {
			try {
				r.onresult = null;
				r.onerror = null;
				r.onend = null;
				r.abort();
			} catch {}
			recognitionRef.current = null;
		}
		setIsRecording(false);
		stopRecordingTick();
	}, [stopRecordingTick]);

	const toggle = useCallback(() => {
		if (disabled) {
			return;
		}
		if (isRecording) {
			stop();
		} else {
			stopRequestedRef.current = false;
			retryCountRef.current = 0;
			lastErrorCodeRef.current = null;
			startRecognition();
		}
	}, [disabled, isRecording, startRecognition, stop]);

	// Auto-stop recording the moment the consumer flips `disabled` — the
	// textarea is typically disabled in that state, so an active mic would
	// silently buffer audio the user can no longer send.
	useEffect(() => {
		if (disabled && isRecording) {
			stop();
		}
	}, [disabled, isRecording, stop]);

	return { isRecording, hasSpeechSupport, recordingSeconds, toggle, stop };
}
