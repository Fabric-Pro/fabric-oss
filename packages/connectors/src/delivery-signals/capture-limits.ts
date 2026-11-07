/** Pure bounds for the currently qualified Slack root-message adapter. */
export const DELIVERY_SOURCE_CAPTURE_PAGE_SIZE = 50;
export const DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES = 16_384;
/** 16 KiB text can expand sixfold in JSON; selected metadata is separately bounded. */
export const DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES = 100 * 1024;
/** Existing encrypted observation storage ceiling, including cipher framing. */
export const DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS = 262_144;

// The database's independent 200-item/page safety ceiling is intentionally
// broader. It does not increase this adapter's actual 50-item provider page.

/** Selected history is read in explicit windows; storage retention starts at capture time. */
export const DELIVERY_SOURCE_CAPTURE_WINDOW_MS = 7 * 86_400_000;
export const DELIVERY_SOURCE_CAPTURE_MAX_LOOKBACK_MS = 90 * 86_400_000;
export interface DeliverySourceCaptureWindow {
	start: string;
	end: string;
}
/** Pure and shared: pass a clock only for new admission, never to rewrite a retry's intent. */
export function isDeliverySourceCaptureWindow(
	value: DeliverySourceCaptureWindow,
	now?: number,
): boolean {
	const start = Date.parse(value.start);
	const end = Date.parse(value.end);
	return (
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		start < end &&
		end - start <= DELIVERY_SOURCE_CAPTURE_WINDOW_MS &&
		(now === undefined ||
			(Number.isFinite(now) &&
				end <= now &&
				start >= now - DELIVERY_SOURCE_CAPTURE_MAX_LOOKBACK_MS))
	);
}
