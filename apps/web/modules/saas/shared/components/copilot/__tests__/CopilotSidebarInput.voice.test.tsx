/**
 * Unit tests for the voice-dictation state machine in
 * `createCopilotSidebarInput`. Single-shot recognizer (`continuous = false`,
 * `interimResults = false`) — the production-tested config. The recognizer
 * auto-stops on the first natural pause, fires `onresult` once with
 * `event.results[0][0].transcript`, and the user clicks again to dictate
 * another phrase. UI extras (M:SS timer, "Listening…" placeholder,
 * aria-pressed toggle) are layered on top.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ------------------------------------------------------------------

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	// `CopilotSidebarInput` reads OPENAPI_SPEC_CONTEXT through the provider,
	// which only the app layout mounts. `true` is the interesting value: it
	// leaves the spec guard live, so these suites run the same path production
	// does rather than a disabled shortcut.
	useFeatureFlag: () => true,
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
	},
}));

const trackEventMock = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

const mockOrpc = {
	createUploadUrl: vi.fn(),
	upload: vi.fn(),
	process: vi.fn(),
	getStatus: vi.fn(),
	getContent: vi.fn(),
};

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		ai: {
			documents: {
				createUploadUrl: (...args: unknown[]) =>
					mockOrpc.createUploadUrl(...args),
				upload: (...args: unknown[]) => mockOrpc.upload(...args),
				process: (...args: unknown[]) => mockOrpc.process(...args),
				getStatus: (...args: unknown[]) => mockOrpc.getStatus(...args),
				getContent: (...args: unknown[]) =>
					mockOrpc.getContent(...args),
			},
		},
	},
}));

const mockFetch = vi.fn();

// --- Fake SpeechRecognition -------------------------------------------------

class FakeSpeechRecognition {
	static lastInstance: FakeSpeechRecognition | null = null;
	static instances: FakeSpeechRecognition[] = [];

	start = vi.fn();
	stop = vi.fn();
	abort = vi.fn();
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onend: (() => void) | null = null;

	constructor() {
		FakeSpeechRecognition.lastInstance = this;
		FakeSpeechRecognition.instances.push(this);
	}

	__fireResult(transcript: string) {
		this.onresult?.({ results: [[{ transcript }]] });
	}

	__fireError(code: string) {
		this.onerror?.({ error: code });
	}

	__fireEnd() {
		this.onend?.();
	}
}

// --- beforeEach / afterEach -------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	FakeSpeechRecognition.lastInstance = null;
	FakeSpeechRecognition.instances = [];
	(globalThis as { fetch?: unknown }).fetch = mockFetch;
	mockFetch.mockResolvedValue({ ok: true, status: 200 });
	(window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition =
		FakeSpeechRecognition;
});

afterEach(() => {
	delete (window as unknown as { SpeechRecognition?: unknown })
		.SpeechRecognition;
	delete (window as unknown as { webkitSpeechRecognition?: unknown })
		.webkitSpeechRecognition;
	delete (globalThis as { fetch?: unknown }).fetch;
});

// Imports under test (after mocks).
import { toast } from "sonner";
import { createCopilotSidebarInput } from "../CopilotSidebarInput";

// --- Helpers ---------------------------------------------------------------

interface RenderInputOptions {
	inProgress?: boolean;
	onSend?: (text: string) => Promise<unknown>;
}

function renderInput(opts: RenderInputOptions = {}) {
	const onSend =
		opts.onSend ?? vi.fn(async (_text: string) => undefined as unknown);
	const Input = createCopilotSidebarInput({
		organizationId: null,
		surface: "feature-assistant",
	});
	const utils = render(
		<Input inProgress={opts.inProgress ?? false} onSend={onSend} />,
	);
	return { ...utils, onSend };
}

function getMicButton(): HTMLButtonElement {
	return screen.getByRole("button", {
		name: "voiceInput.label",
	}) as HTMLButtonElement;
}

// --- Tests ------------------------------------------------------------------

describe("CopilotSidebarInput — voice dictation", () => {
	it("renders a mic button when SpeechRecognition is available", () => {
		renderInput();
		const mic = getMicButton();
		expect(mic).toBeInTheDocument();
		expect(mic).not.toBeDisabled();
	});

	it("renders a disabled mic when SpeechRecognition is missing", () => {
		delete (window as unknown as { SpeechRecognition?: unknown })
			.SpeechRecognition;
		delete (window as unknown as { webkitSpeechRecognition?: unknown })
			.webkitSpeechRecognition;

		renderInput();
		expect(getMicButton()).toBeDisabled();
	});

	it("starts recording on click and configures single-shot mode", () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		expect(instance).not.toBeNull();
		expect(instance?.start).toHaveBeenCalledTimes(1);
		expect(instance?.continuous).toBe(false);
		expect(instance?.interimResults).toBe(false);
		expect(instance?.lang).toBe("en-US");
		expect(mic.className).toContain("text-destructive");
		expect(mic.className).toContain("motion-safe:animate-pulse");
	});

	it("appends transcript on onresult (with leading text)", () => {
		renderInput();
		const textarea = screen.getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;

		act(() => {
			fireEvent.change(textarea, { target: { value: "hello" } });
		});

		const mic = getMicButton();
		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireResult("world");
		});

		expect(textarea.value).toBe("hello world");
		// Single-shot — onresult also resets recording state.
		expect(mic.className).not.toContain("motion-safe:animate-pulse");
	});

	it("appends transcript without leading space when input is empty", () => {
		renderInput();
		const textarea = screen.getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		expect(textarea.value).toBe("");

		const mic = getMicButton();
		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireResult("world");
		});

		expect(textarea.value).toBe("world");
	});

	it("dispatches denied toast on not-allowed error", () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireError("not-allowed");
		});

		expect(toast.error).toHaveBeenCalledWith("voiceInput.denied");
		expect(mic.className).not.toContain("motion-safe:animate-pulse");
	});

	it("stays silent on aborted error", () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireError("aborted");
		});

		expect(toast.error).not.toHaveBeenCalled();
		expect(mic.className).not.toContain("motion-safe:animate-pulse");
	});

	it("does NOT toast on network error when a result was already captured this cycle", async () => {
		// Regression: Chromium occasionally fires a trailing `network` error
		// AFTER `onresult` succeeds. The previous behavior popped a
		// "Voice recognition is unavailable" toast even though the user had
		// their transcript in the input — a false alarm. Successful capture
		// must supersede transient errors in the same cycle.
		renderInput();
		const textarea = screen.getByPlaceholderText(
			"Type a message...",
		) as HTMLTextAreaElement;
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});

		const instance = FakeSpeechRecognition.lastInstance;
		await act(async () => {
			instance?.__fireResult("hello world");
			instance?.__fireError("network");
			instance?.__fireEnd();
			await Promise.resolve();
		});

		expect(textarea.value).toBe("hello world");
		expect(toast.error).not.toHaveBeenCalled();
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("auto-retries on a network error instead of surfacing the toast immediately", async () => {
		// A single `network` error is almost always a transient WebSocket
		// handshake glitch — retrying succeeds the vast majority of the
		// time. Treat it like `no-speech`: swallow and let onend retry,
		// only surface the toast if the entire retry budget is exhausted.
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			first?.__fireError("network");
			first?.__fireEnd();
			await Promise.resolve();
		});

		// A fresh recognizer should have been spun up for the retry —
		// without ever popping the toast.
		const second = FakeSpeechRecognition.lastInstance;
		expect(second).not.toBe(first);
		expect(second?.start).toHaveBeenCalledTimes(1);
		expect(toast.error).not.toHaveBeenCalled();
		expect(mic).toHaveAttribute("aria-pressed", "true");
	});

	it("surfaces the network toast on retry-exhaustion when every attempt fails with network", async () => {
		// The user is on a degraded connection (or Chromium's service is
		// genuinely down): every attempt errors with `network`. After the
		// retry budget is spent the toast surfaces so the user knows to
		// fall back to typing.
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			first?.__fireError("network");
			first?.__fireEnd();
			await Promise.resolve();
		});
		const second = FakeSpeechRecognition.lastInstance;
		expect(second).not.toBe(first);

		await act(async () => {
			second?.__fireError("network");
			second?.__fireEnd();
			await Promise.resolve();
		});
		const third = FakeSpeechRecognition.lastInstance;
		expect(third).not.toBe(second);

		// Third silent end — retries exhausted; toast surfaces.
		await act(async () => {
			third?.__fireError("network");
			third?.__fireEnd();
			await Promise.resolve();
		});

		expect(toast.error).toHaveBeenCalledWith("voiceInput.network");
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("stays silent on retry-exhaustion when the failures were no-speech (not network)", async () => {
		// no-speech exhaustion is silence — the user clicked but never
		// spoke. We track the last error code so the right outcome is
		// chosen: surface the toast for `network` exhaustion, stay quiet
		// for `no-speech`.
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			first?.__fireError("no-speech");
			first?.__fireEnd();
			await Promise.resolve();
		});
		const second = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			second?.__fireError("no-speech");
			second?.__fireEnd();
			await Promise.resolve();
		});
		const third = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			third?.__fireError("no-speech");
			third?.__fireEnd();
			await Promise.resolve();
		});

		expect(toast.error).not.toHaveBeenCalled();
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("transitions back to idle on natural onend after a result", () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		expect(mic.className).toContain("motion-safe:animate-pulse");

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireResult("hello");
			instance?.__fireEnd();
		});

		expect(mic.className).not.toContain("motion-safe:animate-pulse");
	});

	it("auto-retries silent ends (no result fired) up to MAX_RETRIES and then stops silently", async () => {
		// Single-shot recognizer occasionally fails to register audio
		// and ends without firing onresult (Chromium online service
		// glitch). We auto-retry up to 2 times before giving up. When
		// the click cycle ends without a transcript — typically the
		// user clicked but never spoke — we stop silently rather than
		// surface a "didn't catch that" toast.
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;
		expect(first?.start).toHaveBeenCalledTimes(1);

		// Silent end — onend without a preceding onresult.
		await act(async () => {
			first?.__fireEnd();
			await Promise.resolve(); // flush the queueMicrotask
		});

		const second = FakeSpeechRecognition.lastInstance;
		expect(second).not.toBe(first);
		expect(second?.start).toHaveBeenCalledTimes(1);
		// Mic visual stays "recording" through retries.
		expect(mic).toHaveAttribute("aria-pressed", "true");

		// Second silent end — should retry once more.
		await act(async () => {
			second?.__fireEnd();
			await Promise.resolve();
		});
		const third = FakeSpeechRecognition.lastInstance;
		expect(third).not.toBe(second);

		// Third silent end — retries exhausted. Stop silently: the
		// recording state clears with no toast surfaced.
		await act(async () => {
			third?.__fireEnd();
			await Promise.resolve();
		});
		expect(toast.message).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("does NOT auto-retry after a successful capture", async () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;

		await act(async () => {
			first?.__fireResult("hello");
			first?.__fireEnd();
			await Promise.resolve();
		});

		// No new recognizer should have been created.
		expect(FakeSpeechRecognition.lastInstance).toBe(first);
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("starts a fresh recognizer on each click (multi-phrase dictation)", () => {
		renderInput();
		const mic = getMicButton();

		// Cycle 1: click → speak → recognizer auto-ends
		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;
		expect(first?.start).toHaveBeenCalledTimes(1);
		act(() => {
			first?.__fireResult("hello");
			first?.__fireEnd();
		});

		// Cycle 2: click again → fresh instance for the next phrase
		act(() => {
			fireEvent.click(mic);
		});
		const second = FakeSpeechRecognition.lastInstance;
		expect(second).not.toBe(first);
		expect(second?.start).toHaveBeenCalledTimes(1);
	});

	it("aborts a stale recognizer before starting a new session (works-once recovery)", () => {
		// Regression: Chromium retains an internal handle after a session
		// ends. If the previous recognizer instance is still in the ref
		// when the user clicks again, recognition.start() throws
		// InvalidStateError. The fix: defensive abort + ref-clear in
		// startRecognition so the next session always begins clean.
		renderInput();
		const mic = getMicButton();

		// Cycle 1: start a session, fire a result, but never fire onend
		// (simulates the stuck-handle scenario).
		act(() => {
			fireEvent.click(mic);
		});
		const first = FakeSpeechRecognition.lastInstance;
		expect(first?.start).toHaveBeenCalledTimes(1);
		act(() => {
			first?.__fireResult("hello");
		});
		// onend deliberately not fired — ref still holds the stale instance.

		// Cycle 2: click again — defensive cleanup must abort the stale
		// instance, then start a fresh one.
		act(() => {
			fireEvent.click(mic);
		});
		expect(first?.abort).toHaveBeenCalled();

		const second = FakeSpeechRecognition.lastInstance;
		expect(second).not.toBe(first);
		expect(second?.start).toHaveBeenCalledTimes(1);
	});

	it("aborts and detaches handlers when user toggles mic off mid-recording", () => {
		renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const instance = FakeSpeechRecognition.lastInstance;
		expect(mic).toHaveAttribute("aria-pressed", "true");

		// User clicks again to stop — should abort, not stop, and detach
		// handlers so the recognizer's late onend does not flip state.
		act(() => {
			fireEvent.click(mic);
		});

		expect(instance?.abort).toHaveBeenCalled();
		expect(instance?.onresult).toBeNull();
		expect(instance?.onerror).toBeNull();
		expect(instance?.onend).toBeNull();
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("toggles aria-pressed with recording state", () => {
		renderInput();
		const mic = getMicButton();
		expect(mic).toHaveAttribute("aria-pressed", "false");

		act(() => {
			fireEvent.click(mic);
		});
		expect(mic).toHaveAttribute("aria-pressed", "true");

		// Click again to stop while recording
		act(() => {
			fireEvent.click(mic);
		});
		expect(mic).toHaveAttribute("aria-pressed", "false");
	});

	it("shows the elapsed-time label while recording and clears it on stop", () => {
		vi.useFakeTimers();
		try {
			renderInput();
			const mic = getMicButton();

			expect(screen.queryByText(/^\d:\d{2}$/)).toBeNull();

			act(() => {
				fireEvent.click(mic);
			});
			expect(screen.getByText("0:00")).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(1000);
			});
			expect(screen.getByText("0:01")).toBeInTheDocument();

			// Recognizer ends naturally after a successful capture.
			const instance = FakeSpeechRecognition.lastInstance;
			act(() => {
				instance?.__fireResult("done");
				instance?.__fireEnd();
			});
			expect(screen.queryByText("0:01")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("swaps the textarea placeholder to Listening… while recording", () => {
		renderInput();
		expect(
			screen.getByPlaceholderText("Type a message..."),
		).toBeInTheDocument();

		const mic = getMicButton();
		act(() => {
			fireEvent.click(mic);
		});
		expect(screen.getByPlaceholderText("Listening…")).toBeInTheDocument();

		const instance = FakeSpeechRecognition.lastInstance;
		act(() => {
			instance?.__fireResult("done");
			instance?.__fireEnd();
		});
		expect(
			screen.getByPlaceholderText("Type a message..."),
		).toBeInTheDocument();
	});

	it("mic disabled while inProgress", () => {
		renderInput({ inProgress: true });
		expect(getMicButton()).toBeDisabled();
	});

	it("auto-stops an active recording when inProgress flips true", () => {
		const onSend = vi.fn(async () => undefined);
		const Input = createCopilotSidebarInput({
			organizationId: null,
			surface: "feature-assistant",
		});

		function Harness() {
			const [busy, setBusy] = useState(false);
			return (
				<>
					<button
						type="button"
						onClick={() => setBusy(true)}
						data-testid="trigger-busy"
					>
						trigger
					</button>
					<Input inProgress={busy} onSend={onSend} />
				</>
			);
		}

		render(<Harness />);
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const instance = FakeSpeechRecognition.lastInstance;
		expect(mic).toHaveAttribute("aria-pressed", "true");

		// AI starts answering: parent flips inProgress = true.
		act(() => {
			fireEvent.click(screen.getByTestId("trigger-busy"));
		});

		expect(instance?.abort).toHaveBeenCalled();
		expect(getMicButton()).toBeDisabled();
		expect(getMicButton()).toHaveAttribute("aria-pressed", "false");
	});

	it("cleanup: stops recognition and detaches handlers on unmount", () => {
		const { unmount } = renderInput();
		const mic = getMicButton();

		act(() => {
			fireEvent.click(mic);
		});
		const instance = FakeSpeechRecognition.lastInstance;
		expect(instance?.start).toHaveBeenCalledTimes(1);

		unmount();
		expect(instance?.stop).toHaveBeenCalled();
		expect(instance?.onresult).toBeNull();
		expect(instance?.onerror).toBeNull();
		expect(instance?.onend).toBeNull();
	});
});
