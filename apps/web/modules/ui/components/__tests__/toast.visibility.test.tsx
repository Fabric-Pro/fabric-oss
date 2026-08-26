/**
 * Pins the AC-10 invariant for Fizzy #1668: the app-root `<Toaster>` must hand
 * sonner a `visibleToasts` EQUAL to the persistent-error cap.
 *
 * The store-level cap (`toast-error-defaults.ts`) bounds the number of retained
 * persistent error toasts to `MAX_PERSISTENT_ERROR_TOASTS`. sonner renders every
 * store toast but marks any beyond `visibleToasts` as `data-visible=false`
 * (`opacity: 0; pointer-events: none`). So a retained error toast is only
 * actually visible AND individually dismissible (AC-10) while
 * `visibleToasts >= cap`. The two are coupled by a shared import — this test
 * keeps them from silently drifting apart (e.g. bumping the cap to 15 while
 * leaving `visibleToasts` at 10 would hide the 5 oldest errors with no other
 * test noticing).
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	props: undefined as Record<string, unknown> | undefined,
}));

vi.mock("sonner", () => ({
	// Capture the props the app `<Toaster>` forwards to sonner's Toaster.
	Toaster: (props: Record<string, unknown>) => {
		captured.props = props;
		return null;
	},
	toast: Object.assign(vi.fn(), {
		error: vi.fn(),
		dismiss: vi.fn(),
		getToasts: vi.fn(() => []),
	}),
}));

vi.mock("next-themes", () => ({
	useTheme: () => ({ theme: "light" }),
}));

import { Toaster } from "../toast";
import { MAX_PERSISTENT_ERROR_TOASTS } from "../toast-error-cap";

describe("app <Toaster> persistent-error visibility", () => {
	it("forwards visibleToasts equal to the persistent-error cap (AC-10)", () => {
		render(<Toaster />);
		expect(captured.props?.visibleToasts).toBe(MAX_PERSISTENT_ERROR_TOASTS);
	});

	it("renders the error stack collapsed (expand=false) for REQ-7", () => {
		render(<Toaster />);
		expect(captured.props?.expand).toBe(false);
	});
});
