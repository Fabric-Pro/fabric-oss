/**
 * Real-render test for the global error-toast policy.
 *
 * The companion unit test (`toast-error-defaults.test.ts`) mocks sonner and
 * only asserts the OPTIONS the override forwards. This test renders the REAL
 * sonner `<Toaster duration={5000}>` and advances fake timers past that window
 * to prove the end-to-end product requirement: an error toast is still on
 * screen after 5s (persists), while a success toast has auto-dismissed.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Real sonner — no mock — so we exercise sonner's actual duration handling.
import { Toaster, toast } from "sonner";
import { installPersistentErrorToastDefaults } from "../toast-error-defaults";

// Importing the module already self-installs the policy; this is a no-op that
// documents the dependency.
installPersistentErrorToastDefaults();

describe("global error-toast policy (live <Toaster>)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		act(() => {
			toast.dismiss();
			vi.runOnlyPendingTimers();
		});
		vi.useRealTimers();
	});

	it("keeps an error toast past 5s while a success toast auto-dismisses", () => {
		render(<Toaster duration={5000} />);

		act(() => {
			toast.error("Persistent sync error");
			toast.success("Saved");
		});
		// Let both toasts mount.
		act(() => {
			vi.advanceTimersByTime(50);
		});

		expect(screen.getByText("Persistent sync error")).toBeInTheDocument();
		expect(screen.getByText("Saved")).toBeInTheDocument();

		// Advance well past the 5s auto-close window (+ removal animation).
		act(() => {
			vi.advanceTimersByTime(8000);
		});

		// Success has auto-dismissed; the error persists.
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		expect(screen.getByText("Persistent sync error")).toBeInTheDocument();
	});
});
