/**
 * Wiring tests for the persistent-error-toast cap
 * applied through the global `toast.error` choke point.
 *
 * The pure eviction logic is unit-tested in `toast-error-cap.test.ts`. Here we
 * verify the patch DRIVES it correctly end-to-end: persistent error toasts are
 * capped with replace-oldest, a deliberately-transient (finite-duration) error
 * is exempt, and a same-id replacement consumes no new slot.
 *
 * Lives in its own file (not `toast-error-defaults.test.ts`) so the module —
 * and thus the module-level cap instance — is imported fresh, with a stateful
 * sonner mock that mirrors the real store (error → push+return id, dismiss →
 * remove, getToasts → live).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	let counter = 0;
	const live: Array<{ id: string | number }> = [];
	const error = vi.fn(
		(_message: unknown, opts?: { id?: string | number }) => {
			const id = opts?.id ?? `auto-${counter++}`;
			if (!live.some((t) => t.id === id)) {
				live.push({ id });
			}
			return id;
		},
	);
	const dismiss = vi.fn((id: string | number) => {
		const i = live.findIndex((t) => t.id === id);
		if (i !== -1) {
			live.splice(i, 1);
		}
	});
	const getToasts = vi.fn(() => live);
	return {
		error,
		dismiss,
		getToasts,
		success: vi.fn(),
		base: vi.fn(),
		reset() {
			counter = 0;
			live.length = 0;
		},
		get live() {
			return live;
		},
	};
});

vi.mock("sonner", () => {
	const toast = Object.assign(h.base, {
		error: h.error,
		success: h.success,
		dismiss: h.dismiss,
		getToasts: h.getToasts,
	});
	return { toast };
});

import { toast } from "sonner";
import { MAX_PERSISTENT_ERROR_TOASTS } from "../toast-error-cap";
import { installPersistentErrorToastDefaults } from "../toast-error-defaults";

// Mirror the app-root install (module-scope side effect already ran on import).
installPersistentErrorToastDefaults();

beforeEach(() => {
	vi.clearAllMocks();
	h.reset();
});

describe("persistent error toast cap (replace-oldest)", () => {
	it("uses a cap within the spec's 10–15 range", () => {
		expect(MAX_PERSISTENT_ERROR_TOASTS).toBeGreaterThanOrEqual(10);
		expect(MAX_PERSISTENT_ERROR_TOASTS).toBeLessThanOrEqual(15);
	});

	it("evicts the oldest persistent error once the cap is exceeded", () => {
		for (let i = 0; i < MAX_PERSISTENT_ERROR_TOASTS; i++) {
			toast.error(`err ${i}`);
		}
		expect(h.dismiss).not.toHaveBeenCalled();
		expect(h.live).toHaveLength(MAX_PERSISTENT_ERROR_TOASTS);

		toast.error("one too many"); // exceeds the cap

		expect(h.dismiss).toHaveBeenCalledTimes(1);
		expect(h.dismiss).toHaveBeenCalledWith("auto-0"); // the oldest
		expect(h.live).toHaveLength(MAX_PERSISTENT_ERROR_TOASTS);
		expect(h.live.some((t) => t.id === "auto-0")).toBe(false);
	});

	it("exempts an explicit finite-duration error from the cap", () => {
		toast.error("transient", { duration: 2000 });

		// Non-persistent → the cap is never consulted, nothing evicted.
		expect(h.getToasts).not.toHaveBeenCalled();
		expect(h.dismiss).not.toHaveBeenCalled();
	});

	it("does not evict on a repeated same-id error (replacement)", () => {
		for (let i = 0; i < MAX_PERSISTENT_ERROR_TOASTS; i++) {
			toast.error(`err ${i}`);
		}

		toast.error("updated copy", { id: "auto-3" }); // id of a live toast

		expect(h.dismiss).not.toHaveBeenCalled();
		expect(h.live).toHaveLength(MAX_PERSISTENT_ERROR_TOASTS);
	});
});
