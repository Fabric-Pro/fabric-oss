/**
 * Timing for a capture's browser: when a client-rendered page is ready to be
 * read, and why a click did not land.
 *
 * A single-page app keeps working after a click returns. It fetches the next
 * screen's code and data, then swaps the content, so a page read straight
 * away still shows the previous screen or a list whose rows have not arrived,
 * and the model gives up on the right screen. Playwright's `networkidle`
 * cannot see this: it is reached once per document and never resets on an
 * in-app navigation. So the capture watches the page's own requests.
 */
import type { Locator, Page, Request } from "playwright";
import type {
	BrowserOperation,
	OperationOutcome,
} from "../qa-agentic-run/browser-driver";

/** A click or fill that cannot land fails after this, not after 30 s. */
export const ACTION_TIMEOUT_MS = 8_000;
/** A `goto` keeps the runner's full allowance for a cold page. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** Requests must stay quiet this long before a read. */
const QUIET_MS = 500;
/** Longest a read waits for quiet requests. */
const SETTLE_MAX_MS = 4_000;
/** Longest a read then waits for loading indicators to go. */
const LOADED_MAX_MS = 3_000;
/** A request open longer than this is a long poll, not a page loading. */
const LONG_REQUEST_MS = 10_000;
const POLL_MS = 100;
/** Connections that stay open for the life of the page. */
const STREAMS = new Set(["websocket", "eventsource"]);

/**
 * In-page check that nothing visible still says it is loading: a busy region,
 * an indeterminate progress bar, or a skeleton block. Pulsing dots smaller
 * than a skeleton (a "live" badge) do not count.
 */
const PAGE_LOADED = `!Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]:not([aria-valuenow]), .animate-pulse, .skeleton')).some((element) => {
	const box = element.getBoundingClientRect();
	return box.width >= 24 && box.height >= 8;
})`;

/** The part of a page this module listens to and waits on. */
export type SettlePage = Pick<
	Page,
	"on" | "waitForTimeout" | "waitForFunction"
>;

export interface PageActivity {
	/**
	 * Wait until the page's requests have been quiet for a moment and no
	 * loading indicator shows. Bounded; a page that never settles is read as
	 * it is.
	 */
	settle(): Promise<void>;
}

/** Start watching `page`'s requests. Call once, before the first operation. */
export function watchPageActivity(
	page: SettlePage,
	now: () => number = Date.now,
): PageActivity {
	const pending = new Map<Request, number>();
	let lastChange = now();
	page.on("request", (request) => {
		if (!STREAMS.has(request.resourceType())) {
			pending.set(request, now());
			lastChange = now();
		}
	});
	const finish = (request: Request) => {
		if (pending.delete(request)) {
			lastChange = now();
		}
	};
	page.on("requestfinished", finish);
	page.on("requestfailed", finish);
	const loading = () => {
		const at = now();
		for (const started of pending.values()) {
			if (at - started < LONG_REQUEST_MS) {
				return true;
			}
		}
		return false;
	};
	return {
		settle: async () => {
			const start = now();
			const deadline = start + SETTLE_MAX_MS;
			// The quiet window opens no earlier than this call: a navigation a
			// click started may not have sent its first request yet.
			while (
				now() < deadline &&
				(loading() || now() - Math.max(lastChange, start) < QUIET_MS)
			) {
				await page.waitForTimeout(POLL_MS);
			}
			try {
				await page.waitForFunction(PAGE_LOADED, undefined, {
					timeout: LOADED_MAX_MS,
				});
			} catch {
				// A spinner that never stops must not cost the capture.
			}
		},
	};
}

const TIMED_OUT = /Timeout \d+ms exceeded/;

/**
 * Run a step; when a click or fill times out, press Escape once (an open menu
 * or popover makes the rest of the page ignore the pointer) and try again.
 * When that fails too, the result names what covers the target, so the model
 * closes it instead of clicking again. A refusal is returned as it is.
 */
export async function performWithRecovery(
	page: { keyboard: Pick<Page["keyboard"], "press"> },
	operation: BrowserOperation,
	perform: () => Promise<OperationOutcome>,
	cover: () => Promise<string | null>,
): Promise<OperationOutcome> {
	const first = await perform();
	if (
		first.ok ||
		(operation.kind !== "click" && operation.kind !== "fill") ||
		!TIMED_OUT.test(first.detail)
	) {
		return first;
	}
	try {
		await page.keyboard.press("Escape");
	} catch {
		return first;
	}
	const second = await perform();
	if (second.ok) {
		return { ok: true, detail: `Pressed Escape, then: ${second.detail}` };
	}
	const covering = await cover();
	return covering
		? {
				ok: false,
				detail: `${second.detail} It is covered by ${covering}; close that first.`,
			}
		: second;
}

/**
 * What sits on top of `target` when a click on it timed out, such as
 * `a dialog “Get started”`, so the model can close it instead of clicking
 * again. Null when nothing covers it or it cannot be read.
 */
export async function describeCover(target: Locator): Promise<string | null> {
	try {
		const handle = await target.elementHandle({ timeout: 1_000 });
		if (!handle) {
			return null;
		}
		return await handle.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const hit = document.elementFromPoint(
				box.x + box.width / 2,
				box.y + box.height / 2,
			);
			if (!hit || element.contains(hit)) {
				return null;
			}
			if (hit.contains(element)) {
				// The target ignores the pointer: an open menu or modal has
				// disabled the rest of the page.
				const open = document.querySelector(
					'[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"]',
				);
				return open
					? `an open ${open.getAttribute("role") || "dialog"}`
					: null;
			}
			const layer = hit.closest(
				'[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]',
			);
			const node = layer ?? hit;
			const heading = node.querySelector('h1, h2, h3, [role="heading"]');
			const label = (
				node.getAttribute("aria-label") ||
				heading?.textContent ||
				""
			)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 60);
			const kind = layer ? "a dialog" : "another element";
			return label ? `${kind} “${label}”` : kind;
		});
	} catch {
		return null;
	}
}
