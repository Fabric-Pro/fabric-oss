/**
 * Keep an editor's uploaded images (and pulled file links) on a live signed URL.
 *
 * The document and story editors store an upload as the signed URL it was given
 * at upload time plus its storage key (`data-s3-key`). That URL lapses after an
 * hour, so the rendered element has to be re-pointed at a freshly signed one.
 * Only the DOM is rewritten, never the document: the stored URL stays as it was
 * saved, and an image node's `src` is not something the user changed.
 *
 * Rewriting the DOM once on load is not enough. ProseMirror rebuilds an image's
 * `<img>` from the document whenever the node changes — a resize, a caption,
 * a remount — and the rebuilt element carries the expired URL again. So every
 * document-changing transaction and every mount is re-checked: a URL that is
 * still good is reapplied straight from memory, anything else is signed in
 * batches the resolvers accept (Fizzy #2800).
 *
 * Time passes without edits too, so a timer re-checks when the earliest URL is
 * due for renewal or a failed key may be retried. That keeps an idle reader's
 * file links clickable and lets images recover from a failed load. A URL stays
 * in use for a while past its renewal point, so a renewal that fails does not
 * strand an image rebuilt in the meantime. An image already on screen keeps the
 * URL it loaded from — it needs no new one until it is rebuilt, and
 * re-pointing it would download it again every 50 minutes.
 *
 * Each batch is applied as soon as it answers and is abandoned after 30
 * seconds, so one slow or hung request never holds up the others or the
 * images added after it.
 *
 * An image this cannot fix — storage refused it, the object is gone — is
 * labelled by the ImageLoadFallback extension.
 */

import type { Editor } from "@tiptap/core";

/**
 * When a signed URL is renewed. URLs are signed for an hour
 * (`resolveMediaUrls` / `resolveStoryImageUrls`).
 */
const RENEW_AFTER_MS = 50 * 60 * 1000;

/**
 * How long a signed URL is handed out. Past the renewal point, so a renewal
 * that fails still leaves a rebuilt image a URL that works; short of the hour,
 * so it never gets one with only seconds left on it.
 */
const USABLE_FOR_MS = 55 * 60 * 1000;

/**
 * How long a key that could not be signed is left alone. Transactions fire on
 * every keystroke, so retrying immediately would turn a storage outage into a
 * request per character typed.
 */
const RETRY_AFTER_MS = 60 * 1000;

/** How long a signing request may take before it is treated as failed. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** Both resolvers refuse a request carrying more keys than this. */
const MAX_KEYS_PER_REQUEST = 50;

export interface SignedMediaUrlRefresherOptions {
	editor: Editor;
	/**
	 * The storage key an `<img src>` points at, or null when the image is not
	 * one this refresher may sign. Keys the resolver would reject must map to
	 * null too: the resolvers refuse the WHOLE batch over a single foreign key.
	 */
	keyFromImageSrc: (src: string) => string | null;
	/**
	 * The same, for a stored `data-s3-key`: an image's, when its `src` carries
	 * no key, and a file link's. Stored keys are ignored when omitted.
	 */
	keyFromStoredKey?: (key: string) => string | null;
	/** Also keep `<a data-s3-key>` file links on a live `href`. */
	refreshLinks?: boolean;
	/** Signs keys. A key missing from the result could not be signed. */
	resolve: (keys: string[]) => Promise<Record<string, string>>;
	onError?: (error: unknown) => void;
	/** Clock, for tests. */
	now?: () => number;
}

export interface SignedMediaUrlRefresher {
	/** Reuse a URL signed elsewhere — an upload — rather than signing it again. */
	remember: (key: string, url: string) => void;
	destroy: () => void;
}

/** The editor's DOM, or null before `<EditorContent>` has mounted it. */
function mountedDom(editor: Editor): HTMLElement | null {
	// Before mount `isDestroyed` reads true and `view.dom` throws.
	return editor.isDestroyed ? null : editor.view.dom;
}

/** An `<img>` that decoded a picture; a failed one reports a zero width. */
function isShowing(img: Element): boolean {
	return (
		img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
	);
}

/** `promise`, rejected instead if it has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() =>
					reject(
						new Error(`Signing media URLs timed out after ${ms}ms`),
					),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timeout));
}

export function createSignedMediaUrlRefresher({
	editor,
	keyFromImageSrc,
	keyFromStoredKey,
	refreshLinks = false,
	resolve,
	onError,
	now = Date.now,
}: SignedMediaUrlRefresherOptions): SignedMediaUrlRefresher {
	const signed = new Map<string, { url: string; at: number }>();
	const failedAt = new Map<string, number>();
	const inFlight = new Set<string>();
	let destroyed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const usableUrl = (key: string): string | null => {
		const entry = signed.get(key);
		return entry && now() - entry.at < USABLE_FOR_MS ? entry.url : null;
	};

	const isDue = (key: string): boolean => {
		const entry = signed.get(key);
		return !entry || now() - entry.at >= RENEW_AFTER_MS;
	};

	const mayRetry = (key: string): boolean => {
		const failed = failedAt.get(key);
		return failed === undefined || now() - failed >= RETRY_AFTER_MS;
	};

	const storedKey = (element: Element): string | null => {
		const key = element.getAttribute("data-s3-key");
		return key && keyFromStoredKey ? keyFromStoredKey(key) : null;
	};

	/**
	 * When the earliest of these keys next needs signing, if ever: its renewal
	 * point while that is ahead, else its retry time. A key being signed is
	 * rescheduled when its request settles, and a due key that may be retried
	 * is being signed, not scheduled. Scheduling a due key off its renewal
	 * point — already past — re-armed a zero-delay timer that rescanned the
	 * editor until the retry was due.
	 */
	const nextCheckAt = (keys: Iterable<string>): number => {
		let next = Number.POSITIVE_INFINITY;
		for (const key of keys) {
			if (inFlight.has(key)) {
				continue;
			}
			const entry = signed.get(key);
			const failed = failedAt.get(key);
			if (entry && !isDue(key)) {
				next = Math.min(next, entry.at + RENEW_AFTER_MS);
			} else if (failed !== undefined) {
				next = Math.min(next, failed + RETRY_AFTER_MS);
			}
		}
		return next;
	};

	const schedule = (at: number): void => {
		clearTimeout(timer);
		timer = undefined;
		if (destroyed || !Number.isFinite(at)) {
			return;
		}
		timer = setTimeout(refresh, Math.max(0, at - now()));
	};

	const refresh = (): void => {
		const dom = destroyed ? null : mountedDom(editor);
		if (!dom) {
			return;
		}
		const seen = new Set<string>();
		const unsigned = new Set<string>();
		const point = (
			key: string | null,
			current: string,
			apply: ((url: string) => void) | null,
		) => {
			if (!key) {
				return;
			}
			seen.add(key);
			const url = usableUrl(key);
			if (apply && url && url !== current) {
				apply(url);
			}
			if (isDue(key) && mayRetry(key) && !inFlight.has(key)) {
				unsigned.add(key);
			}
		};

		for (const img of dom.querySelectorAll("img[src], img[data-s3-key]")) {
			const src = img.getAttribute("src") ?? "";
			point(
				keyFromImageSrc(src) ?? storedKey(img),
				src,
				isShowing(img) ? null : (url) => img.setAttribute("src", url),
			);
		}
		if (refreshLinks) {
			for (const link of dom.querySelectorAll("a[data-s3-key]")) {
				point(storedKey(link), link.getAttribute("href") ?? "", (url) =>
					link.setAttribute("href", url),
				);
			}
		}

		const keys = [...unsigned];
		for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
			void sign(keys.slice(i, i + MAX_KEYS_PER_REQUEST));
		}
		schedule(nextCheckAt(seen));
	};

	/** Sign one batch; it lands, fails or times out on its own. */
	const sign = async (batch: string[]): Promise<void> => {
		for (const key of batch) {
			inFlight.add(key);
		}
		let urls: Record<string, string> = {};
		try {
			// Inside the `try`, so a resolver that throws synchronously is
			// reported like any other failure.
			urls = await withTimeout(resolve(batch), REQUEST_TIMEOUT_MS);
		} catch (error) {
			onError?.(error);
		}
		const at = now();
		for (const key of batch) {
			inFlight.delete(key);
			const url = urls[key];
			if (url) {
				signed.set(key, { url, at });
				failedAt.delete(key);
			} else {
				failedAt.set(key, at);
			}
		}
		// Apply what was signed, pick up anything that appeared meanwhile, and
		// schedule the next check.
		refresh();
	};

	const onTransaction = ({
		transaction,
	}: {
		transaction: { docChanged: boolean };
	}) => {
		if (transaction.docChanged) {
			refresh();
		}
	};

	editor.on("transaction", onTransaction);
	editor.on("mount", refresh);
	refresh();

	return {
		remember(key, url) {
			signed.set(key, { url, at: now() });
			failedAt.delete(key);
		},
		destroy() {
			destroyed = true;
			clearTimeout(timer);
			editor.off("transaction", onTransaction);
			editor.off("mount", refresh);
		},
	};
}
