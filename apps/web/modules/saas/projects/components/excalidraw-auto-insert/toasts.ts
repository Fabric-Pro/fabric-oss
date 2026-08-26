/**
 * Sonner toast helpers for the Excalidraw chat -> editor auto-insert
 * feature. Centralised so the button (D2), the hook (D1), and the
 * copy-embed-code path (D7) all surface the same Sonner-bound copy.
 *
 * Spec sections:
 *   - § 8.5  Toast contract (success + destructive)
 *   - § 11   Error matrix rows 2-4 (forbidden, db, editor failures)
 *   - § FR-10 Universal-fallback Copy embed code toast
 *   - § 14.4 Accessibility -- Sonner sets role="status" / role="alert"
 *            natively; do NOT add ARIA on the wrapper.
 *   - § 14.7 i18n keys
 *
 * The helpers accept a `t` translator (next-intl's `useTranslations`
 * result) instead of calling `useTranslations` themselves. Two reasons:
 *   1. Sonner toasts can be triggered from non-component code paths
 *      (effect cleanups, retry handlers) where calling React hooks is
 *      illegal. The caller's `t` reference is captured at render time
 *      and stays valid for the lifetime of the toast.
 *   2. It keeps this file React-hook-free and easy to unit-test by
 *      passing in a fake translator.
 */

import { toast } from "sonner";

/** Translator shape compatible with next-intl's `useTranslations` result. */
export type AutoInsertTranslator = (
	key: string,
	values?: Record<string, string>,
) => string;

/**
 * Inputs to the success toast.
 */
export interface ToastSuccessOptions {
	/** Translator scoped to the `diagrams.autoInsert` namespace. */
	t: AutoInsertTranslator;
	/** Doc / feature title -- substituted into `{docName}`. */
	docName: string;
	/**
	 * Click handler for the "Go to embed" Sonner action. The hook (D1)
	 * passes a callback that scrolls the newly-inserted node into view.
	 * The action is keyboard-reachable because Sonner renders it as a
	 * real `<button>`.
	 */
	onGoToEmbed: () => void;
}

/**
 * Fire the success toast (`role="status"`) after a successful insert.
 * Copy: spec § 8.5 / § 14.7 (`toastSuccess`, `toastSuccessAction`).
 */
export function toastSuccess(options: ToastSuccessOptions): void {
	const { t, docName, onGoToEmbed } = options;
	toast.success(t("toastSuccess", { docName }), {
		action: {
			label: t("toastSuccessAction"),
			onClick: onGoToEmbed,
		},
	});
}

/**
 * Fire the generic destructive toast for `db` failures (spec § 11
 * row 3). The button returns to its idle state so the user can retry.
 */
export function toastErrorDb(t: AutoInsertTranslator): void {
	toast.error(t("toastErrorDb"));
}

/**
 * Fire the destructive toast for the `forbidden` failure class (spec
 * § 11 row 2) -- flag-off, personal-scope, or permission-denied
 * server response.
 */
export function toastErrorForbidden(t: AutoInsertTranslator): void {
	toast.error(t("toastErrorForbidden"));
}

/**
 * Fire the destructive toast for clipboard failures (spec § 11 row 9
 * / FR-10). Uses Sonner's default destructive surface; the copy itself
 * is the calm/advisory "your browser blocked clipboard access" string
 * from spec § 14.7.
 */
export function toastCopyFailed(t: AutoInsertTranslator): void {
	toast.error(t("toastCopyFailed"));
}
