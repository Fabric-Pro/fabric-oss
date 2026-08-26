/**
 * Unit tests for the global error-toast policy.
 *
 * Product requirement (Fizzy): an error toast "disappears only when the user
 * clicks it" — by default it must NOT auto-dismiss after the global 5s window.
 * This is enforced application-wide by overriding `toast.error` once at
 * app-root load (`toast-error-defaults.ts`), so every one of the ~250
 * `toast.error` call sites inherits the persist-until-dismiss default with
 * zero churn. Callers may still opt out by passing an explicit `duration`.
 *
 * sonner exposes duration only globally (`<Toaster duration>`) or per-call —
 * there is no per-type duration — and re-exporting a wrapped `toast` would
 * force a 250-file import codemod. Overriding the shared singleton's `.error`
 * method is the single-point mechanism these tests pin down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sonner's `toast` singleton so we can inspect the options the override
// forwards to the underlying implementation. `error`/`success` are spies; the
// override re-binds `error` to point at this spy.
const { errorSpy, successSpy, baseSpy, dismissSpy, getToastsSpy } = vi.hoisted(
	() => ({
		errorSpy: vi.fn(() => "id-err"),
		successSpy: vi.fn(() => "id-ok"),
		baseSpy: vi.fn(() => "id-base"),
		// The persist-cap reconciles against sonner's live toasts and evicts
		// via dismiss. Here the store is always empty, so the cap never evicts
		// and these option-passthrough assertions stay focused on the override.
		dismissSpy: vi.fn(),
		getToastsSpy: vi.fn(() => []),
	}),
);

vi.mock("sonner", () => {
	const toast = Object.assign(baseSpy, {
		error: errorSpy,
		success: successSpy,
		dismiss: dismissSpy,
		getToasts: getToastsSpy,
	});
	return { toast };
});

import { toast } from "sonner";
import { installPersistentErrorToastDefaults } from "../toast-error-defaults";

// Apply once — mirrors the module-scope call made by the app-root <Toaster>.
installPersistentErrorToastDefaults();

beforeEach(() => {
	vi.clearAllMocks();
});

describe("global error-toast policy (persist until dismissed)", () => {
	it("defaults error toasts to duration:Infinity + closeButton:true", () => {
		toast.error("Failed to sync story");

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("Failed to sync story", {
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
		});
	});

	it("passes caller description/id through while keeping the persist default", () => {
		toast.error("Failed to sync story", {
			description: "This feature is synced to a different PM tool.",
			id: "sync-1",
		});

		expect(errorSpy).toHaveBeenCalledWith("Failed to sync story", {
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
			description: "This feature is synced to a different PM tool.",
			id: "sync-1",
		});
	});

	it("lets an explicit caller duration win (deliberately transient error)", () => {
		toast.error("brief error", { duration: 4000 });

		expect(errorSpy).toHaveBeenCalledWith("brief error", {
			duration: 4000,
			closeButton: true,
		});
	});

	it("lets a caller opt out of the close button explicitly", () => {
		toast.error("no x button", { closeButton: false });

		expect(errorSpy).toHaveBeenCalledWith("no x button", {
			duration: Number.POSITIVE_INFINITY,
			closeButton: false,
		});
	});

	it("does NOT alter success toasts (they keep the global 5s auto-dismiss)", () => {
		toast.success("Saved");

		expect(successSpy).toHaveBeenCalledTimes(1);
		expect(successSpy).toHaveBeenCalledWith("Saved");
		expect(successSpy).not.toHaveBeenCalledWith(
			"Saved",
			expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
		);
	});

	it("is idempotent — repeated install does not double-invoke the original", () => {
		installPersistentErrorToastDefaults();
		installPersistentErrorToastDefaults();

		toast.error("x");

		// The underlying sonner implementation is invoked exactly once per
		// toast.error call regardless of how many times install ran.
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith("x", {
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
		});
	});
});
