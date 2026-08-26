/**
 * Hard cap on simultaneously-live **persistent** error toasts, with
 * replace-oldest overflow.
 *
 * ## Why this can't be left to sonner
 *
 * sonner's `<Toaster visibleToasts>` only controls how many toasts *render*
 * (`isVisible = index + 1 <= visibleToasts`); overflow toasts are hidden
 * (`opacity: 0`) but stay in the store. Our error toasts use
 * `duration: Infinity` (they never auto-close — see `toast-error-defaults.ts`),
 * so without explicit eviction they would accumulate in the store **without
 * bound** — a memory leak (NFR), and the "oldest" would merely be hidden, then
 * pop back into view when a newer toast was dismissed. The spec requires the
 * oldest to be *removed* when the cap is reached.
 *
 * This tracker is the eviction mechanism. It is pure (no sonner import): the
 * patched `toast.error` hands it a `listLiveToastIds` reader (sonner's
 * `toast.getToasts`) and a `dismiss` sink (sonner's `toast.dismiss`).
 *
 * ## Cap value
 *
 * `MAX_PERSISTENT_ERROR_TOASTS = 10` — the low end of the spec's 10–15 range.
 * D4 / CQ2 delegate the exact number to dev and ask that it be documented; 10
 * is chosen because ten infinite, manually-dismissed error toasts already
 * occupy a lot of the top-right corner, so the smallest value in the range
 * minimises DOM/memory footprint while still far exceeding any realistic
 * simultaneous-error burst.
 */

export const MAX_PERSISTENT_ERROR_TOASTS = 10;

/** A sonner toast id. */
type ToastId = string | number;

export class PersistentErrorToastCap {
	/** Tracked live persistent-error toast ids, oldest → newest (FIFO). */
	private ids: ToastId[] = [];

	constructor(
		private readonly cap: number,
		/** Ids sonner currently considers active (its `getToasts`). */
		private readonly listLiveToastIds: () => ToastId[],
		/** Dismiss a toast by id (sonner's `dismiss`). */
		private readonly dismiss: (id: ToastId) => void,
	) {}

	/**
	 * Call BEFORE creating a new persistent error toast.
	 *
	 * Reconciles the tracked set against sonner's live toasts (so a slot freed
	 * by a user-dismissed toast is reclaimed first), then — unless `providedId`
	 * names a toast we already track (a same-id replacement, which sonner
	 * updates in place and which therefore consumes no new slot) — evicts the
	 * oldest tracked toast(s) until there is room for one more.
	 */
	makeRoom(providedId: ToastId | undefined): void {
		this.reconcile();
		if (providedId !== undefined && this.ids.includes(providedId)) {
			return;
		}
		while (this.ids.length >= this.cap) {
			const oldest = this.ids.shift();
			if (oldest !== undefined) {
				this.dismiss(oldest);
			}
		}
	}

	/** Call AFTER creating the toast, with the id sonner returned. */
	record(id: ToastId): void {
		if (!this.ids.includes(id)) {
			this.ids.push(id);
		}
	}

	/** Number of toasts currently tracked (test introspection). */
	get trackedCount(): number {
		return this.ids.length;
	}

	/** Drop tracked ids sonner no longer reports as active. */
	private reconcile(): void {
		const live = new Set(this.listLiveToastIds());
		this.ids = this.ids.filter((id) => live.has(id));
	}
}
