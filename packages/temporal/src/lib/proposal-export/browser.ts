/**
 * The Chromium the Proposal export prints and screenshots with (Fizzy #2946).
 *
 * One browser per export, never pooled, closed when the export ends or its
 * time budget runs out. Every page runs with JavaScript off, offline, with
 * service workers blocked and every request aborted, the hardening frame
 * export established; the print page carries all it needs inline.
 *
 * Interim mode, until the sandbox or a render container without secrets
 * holds: Chromium's sandbox does not start under the worker image's default
 * seccomp profile, so it runs with `--no-sandbox`. To keep what it could
 * reach small, it is launched with an explicit minimal environment (no
 * database, storage or model credentials; Playwright would otherwise pass
 * the worker's whole `process.env`), it never runs page JavaScript, and it
 * only ever loads the committed print fonts.
 *
 * Font hinting is off, as for every server-side print: see
 * `print-chromium-args.ts`.
 */

import { tmpdir } from "node:os";
import {
	type Browser,
	type BrowserContextOptions,
	chromium,
	type LaunchOptions,
	type Page,
} from "playwright";
import { PRINT_CHROMIUM_ARGS } from "../print-chromium-args";
import { exportFailure } from "./failures";

/** Context options every export page uses. */
export const EXPORT_CONTEXT_OPTIONS: BrowserContextOptions = {
	javaScriptEnabled: false,
	offline: true,
	serviceWorkers: "block",
	acceptDownloads: false,
	colorScheme: "light",
	locale: "en-US",
	timezoneId: "UTC",
};

/** The longest a launch may take before the export gives up on it. */
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * The only environment Chromium sees: a search path and a scratch home
 * directory. Nothing else of the worker's environment reaches it.
 */
export function exportBrowserEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: tmpdir(),
	};
}

/** Launch options of the export's Chromium. */
export function exportLaunchOptions(timeoutMs: number): LaunchOptions {
	return {
		headless: true,
		// Interim sandbox and font hinting: see the module comment.
		args: [...PRINT_CHROMIUM_ARGS],
		env: exportBrowserEnv(),
		timeout: Math.max(1, Math.min(LAUNCH_TIMEOUT_MS, timeoutMs)),
	};
}

/** What a caller may set on an export page's context; nothing that loosens it. */
export interface ExportPageOptions {
	/** 2 for crisp screenshots; print ignores it. */
	deviceScaleFactor?: number;
	viewport?: { width: number; height: number };
}

export interface ExportBrowser {
	/**
	 * A page in a fresh hardened context: JavaScript off, offline, every
	 * request aborted. Its default timeout is the time left in the budget.
	 */
	newPage(options?: ExportPageOptions): Promise<Page>;
	/** Requests the pages tried to make; all of them were aborted. */
	readonly blockedRequests: number;
}

/**
 * Run `work` with one export browser that closes when `work` settles or at
 * `deadline` (epoch milliseconds), whichever comes first. Running past the
 * deadline fails the export with `EXPORT_TIMED_OUT`, which is not retried.
 */
export async function withExportBrowser<T>(
	deadline: number,
	work: (browser: ExportBrowser) => Promise<T>,
): Promise<T> {
	const remaining = () => deadline - Date.now();
	if (remaining() <= 0) {
		throw exportFailure("EXPORT_TIMED_OUT");
	}
	const browser: Browser = await chromium.launch(
		exportLaunchOptions(remaining()),
	);

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void browser.close().catch(() => undefined);
	}, remaining());

	let blockedRequests = 0;
	const session: ExportBrowser = {
		async newPage(options = {}) {
			const left = remaining();
			if (left <= 0) {
				throw exportFailure("EXPORT_TIMED_OUT");
			}
			const context = await browser.newContext({
				...EXPORT_CONTEXT_OPTIONS,
				...(options.deviceScaleFactor
					? { deviceScaleFactor: options.deviceScaleFactor }
					: {}),
				...(options.viewport ? { viewport: options.viewport } : {}),
			});
			await context.route("**/*", (route) => {
				blockedRequests++;
				return route.abort("blockedbyclient");
			});
			const page = await context.newPage();
			page.setDefaultTimeout(left);
			return page;
		},
		get blockedRequests() {
			return blockedRequests;
		},
	};

	try {
		const result = await work(session);
		if (timedOut) {
			throw exportFailure("EXPORT_TIMED_OUT");
		}
		return result;
	} catch (error) {
		// A page call can fail on its own timeout a moment before the
		// deadline timer fires; past the deadline, either is the budget.
		if (timedOut || Date.now() >= deadline) {
			throw exportFailure("EXPORT_TIMED_OUT");
		}
		throw error;
	} finally {
		clearTimeout(timer);
		await browser.close().catch(() => undefined);
	}
}
