import { type ExternalToast, toast } from "sonner";
import {
	MAX_PERSISTENT_ERROR_TOASTS,
	PersistentErrorToastCap,
} from "./toast-error-cap";

/**
 * Global UX policy: **error toasts persist until the user dismisses them.**
 *
 * Product requirement (Fizzy): an error message "disappears only when the
 * user clicks it" — by default it stays on screen until the user explicitly
 * dismisses it, instead of vanishing after the global 5s auto-close set on
 * `<Toaster>`.
 *
 * ## Why a one-time singleton override (not `<Toaster>` config or a wrapper)
 *
 * - sonner exposes `duration` only **globally** (`<Toaster duration>`) or
 *   **per-call** (`toast.error(msg, { duration })`). There is **no per-type
 *   duration**, so the Toaster cannot express "errors persist, success/info
 *   auto-dismiss".
 * - `toast` is a single shared singleton imported the same way by ~250 call
 *   sites. Re-exporting a wrapped `toast` would force a 250-file import codemod
 *   (a pure noise wall). Overriding the singleton's `.error` method **once**
 *   changes every call site's default with zero churn.
 *
 * ## Semantics
 *
 * - `toast.error(msg)` defaults to `duration: Infinity` (never auto-closes) +
 *   `closeButton: true` (an explicit dismiss affordance).
 * - **Caller-supplied options still win** (they are spread last): a call that
 *   passes an explicit `duration` (a deliberately transient error — e.g. the
 *   rate-limit "retry shortly" toast) keeps it, and `id` / `description` /
 *   `action` / `onDismiss` / etc. pass through untouched. The policy is an
 *   opt-out-able default, not a hard lock.
 * - **Only `toast.error` is affected.** `success` / `info` / `warning` /
 *   `loading` keep the global 5s auto-dismiss.
 * - **`toast.promise` is intentionally NOT covered.** sonner builds its
 *   promise toasts internally (loading→success→error) under a single
 *   `PromiseData.duration` that spans all three states, so error-only
 *   persistence isn't expressible there without also pinning the loading and
 *   success states. The handful of `toast.promise` call sites keep the default
 *   auto-dismiss; convert them to an explicit `toast.error` in the rejection
 *   handler if a given one needs to persist.
 *
 * ## Cap on simultaneous persistent error toasts (REQ-8 / AC-9)
 *
 * Because persistent error toasts never auto-close, they would otherwise pile
 * up in sonner's store without bound (sonner's `visibleToasts` only hides
 * overflow, it never evicts). Every persistent error toast is routed through a
 * single {@link PersistentErrorToastCap}: when a new one would exceed
 * {@link MAX_PERSISTENT_ERROR_TOASTS}, the oldest is dismissed (replace-oldest).
 * A caller-supplied finite `duration` (a deliberately-transient error) is
 * exempt — it auto-dismisses and never evicts a persistent toast.
 *
 * Idempotent: guarded by a `Symbol` flag stored on the singleton, so repeated
 * imports / dev HMR re-evaluation never wrap the wrapper (unbounded nesting).
 */

const PATCHED = Symbol.for("fabric.toast.error.persistUntilDismissed");

type ErrorFn = typeof toast.error;

// Single cap shared by every error toast (they all flow through `toast.error`).
// Reads sonner's live store and dismisses through sonner's own (unpatched) API.
const persistentErrorCap = new PersistentErrorToastCap(
	MAX_PERSISTENT_ERROR_TOASTS,
	() => toast.getToasts().map((t) => t.id),
	(id) => toast.dismiss(id),
);

/**
 * Install the persist-until-dismissed default on `toast.error`. Safe to call
 * any number of times; only the first call takes effect.
 *
 * Runs as a side effect on import (bottom of this module) so the default is in
 * force for any module that imports it, decoupled from `<Toaster>` render
 * order. Also called explicitly at the app-root Toaster (`toast.tsx`).
 */
export function installPersistentErrorToastDefaults(): void {
	const target = toast as unknown as Record<string | symbol, unknown>;
	if (target[PATCHED]) {
		return;
	}

	// Capture the original BEFORE reassigning. sonner's `error` is an arrow
	// function that lexically captures its own `this` (the internal Observer),
	// so it needs no rebinding — calling it bare is correct.
	const original: ErrorFn = toast.error;

	const patched: ErrorFn = (message, data?: ExternalToast) => {
		const merged: ExternalToast = {
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
			...data,
		};

		// Only PERSISTENT error toasts count toward the cap. A caller that opts
		// into a finite duration (a deliberately-transient error) auto-dismisses
		// on its own and must never evict a persistent toast.
		if (merged.duration !== Number.POSITIVE_INFINITY) {
			return original(message, merged);
		}

		// Reconcile + evict the oldest BEFORE creating, so the visible stack
		// never momentarily exceeds the cap; `data?.id` lets a same-id replace
		// (sonner updates in place) skip eviction.
		persistentErrorCap.makeRoom(data?.id);
		const id = original(message, merged);
		persistentErrorCap.record(id);
		return id;
	};

	toast.error = patched;
	target[PATCHED] = true;
}

// Self-install on import: merely importing this module activates the policy,
// independent of the Toaster component lifecycle.
installPersistentErrorToastDefaults();
