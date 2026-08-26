/**
 * Smoke tests for the shared Esc-context hook used by the four AI surfaces
 * (Nexus, the Fabric Agent launcher, Loom Direct, Loom Orchestrator).
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` section 8.8
 * (decision 9 / AC-7).
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEscToStopOrClose } from "../useEscToStopOrClose";

function dispatchEscape(): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	const preventDefaultSpy = vi.spyOn(event, "preventDefault");
	const stopPropagationSpy = vi.spyOn(event, "stopPropagation");
	document.dispatchEvent(event);
	// Re-attach the spies onto the event so callers can introspect them.
	(
		event as unknown as { __preventDefaultSpy: typeof preventDefaultSpy }
	).__preventDefaultSpy = preventDefaultSpy;
	(
		event as unknown as { __stopPropagationSpy: typeof stopPropagationSpy }
	).__stopPropagationSpy = stopPropagationSpy;
	return event;
}

function getSpies(event: KeyboardEvent) {
	const e = event as unknown as {
		__preventDefaultSpy: ReturnType<typeof vi.spyOn>;
		__stopPropagationSpy: ReturnType<typeof vi.spyOn>;
	};
	return {
		preventDefault: e.__preventDefaultSpy,
		stopPropagation: e.__stopPropagationSpy,
	};
}

describe("useEscToStopOrClose", () => {
	it("calls onStop and stops propagation when Esc is pressed while in-flight", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: true,
				onStop,
				onClose,
			}),
		);

		const event = dispatchEscape();
		const { preventDefault, stopPropagation } = getSpies(event);

		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(stopPropagation).toHaveBeenCalledTimes(1);
	});

	it("calls onClose when Esc is pressed while idle and onClose is provided", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: false,
				onStop,
				onClose,
			}),
		);

		dispatchEscape();

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onStop).not.toHaveBeenCalled();
	});

	it("is a no-op when idle and no onClose is provided", () => {
		const onStop = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: false,
				onStop,
			}),
		);

		const event = dispatchEscape();
		const { preventDefault, stopPropagation } = getSpies(event);

		expect(onStop).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		expect(stopPropagation).not.toHaveBeenCalled();
	});

	it("does nothing when enabled=false (in-flight branch)", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: true,
				onStop,
				onClose,
				enabled: false,
			}),
		);

		const event = dispatchEscape();
		const { preventDefault, stopPropagation } = getSpies(event);

		expect(onStop).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		expect(stopPropagation).not.toHaveBeenCalled();
	});

	it("does nothing when enabled=false (idle branch)", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: false,
				onStop,
				onClose,
				enabled: false,
			}),
		);

		dispatchEscape();

		expect(onStop).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("ignores non-Escape keys", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		renderHook(() =>
			useEscToStopOrClose({
				isInFlight: true,
				onStop,
				onClose,
			}),
		);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

		expect(onStop).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("removes the listener on unmount (no leak)", () => {
		const onStop = vi.fn();
		const onClose = vi.fn();
		const { unmount } = renderHook(() =>
			useEscToStopOrClose({
				isInFlight: true,
				onStop,
				onClose,
			}),
		);

		unmount();
		dispatchEscape();

		expect(onStop).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("uses the latest onStop/onClose without re-binding the listener", () => {
		const firstStop = vi.fn();
		const secondStop = vi.fn();
		const { rerender } = renderHook(
			({ onStop }: { onStop: () => void }) =>
				useEscToStopOrClose({ isInFlight: true, onStop }),
			{ initialProps: { onStop: firstStop } },
		);

		rerender({ onStop: secondStop });
		dispatchEscape();

		expect(firstStop).not.toHaveBeenCalled();
		expect(secondStop).toHaveBeenCalledTimes(1);
	});
});
