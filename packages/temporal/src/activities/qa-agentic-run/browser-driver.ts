/**
 * The browser half of the agentic test runner.
 *
 * Deliberately a SMALL, CLOSED set of operations. The model chooses among these
 * and supplies their arguments; it never supplies code, a selector expression or
 * a URL to navigate to outside the environment's own origin. That containment is
 * the point: an agent driving a browser with a customer's real credentials is
 * only as safe as the narrowest thing it is able to ask for.
 *
 * Targets are addressed by ARIA role + accessible name rather than CSS, because
 * that is the same vocabulary the aria snapshot hands the model. A model that
 * reads "button «Sign in»" and answers `{role: "button", name: "Sign in"}` is
 * quoting what it saw; one answering `div.btn-primary > span:nth-child(2)` is
 * inventing.
 *
 * Nothing here logs a credential. `fillSecret` exists precisely so the password
 * path cannot accidentally travel through the same code that records an
 * observation.
 */

import { logger } from "@repo/logs";
import {
	getBlockedOutboundReason,
	getUnsafeUrlReason,
} from "@repo/utils/url-security";
import type { Browser, BrowserContext, Page } from "playwright";
import { settleNavigation } from "../browser-automation/relay-response";
import {
	installOutboundRequestGuard,
	type OutboundRefusalCode,
} from "../browser-automation/url-guard";

export { settleNavigation } from "../browser-automation/relay-response";

/** The closed set of things a step is allowed to do. */
export type BrowserOperation =
	| { kind: "click"; role: string; name: string }
	| { kind: "fill"; role: string; name: string; text: string }
	| { kind: "press"; key: string }
	| { kind: "goto"; path: string }
	| { kind: "wait"; ms: number };

export interface OpenBrowserOptions {
	browser: string;
	/** "1920x1080" — the QA policy's own format. */
	resolution: string;
	timeoutMs: number;
	/** The only HTTP(S) origin this credentialed browser may reach. */
	targetOrigin: string;
	signal?: AbortSignal;
	scopedHTTPHeaders?: {
		origin: string;
		headers: Record<string, string>;
	};
}

/**
 * Why the browser's own route handler refused to let a request through —
 * recorded so a later "could not open the page" failure can say WHICH side
 * must act, instead of the bare `net::ERR_BLOCKED_BY_CLIENT` every refusal
 * collapses to at the Playwright layer.
 *
 * - `off-origin` — the request targeted a host outside the environment's
 *   configured origin (including a redirect that left it). Something about
 *   the ENVIRONMENT needs fixing — its base URL, or where it sends the
 *   browser.
 * - `unsafe-address` — the request stayed on the configured origin, but that
 *   host resolved to a private/loopback/link-local address. Also an
 *   environment configuration problem, not a Fabric outage.
 * - `connection-refused`, `host-not-found`, `certificate-invalid` — the
 *   proxying fetch reached far enough to get a definite answer from the
 *   environment's own host or its DNS: nothing listening, no such name, or a
 *   certificate that does not verify. These are the environment's to fix.
 * - `fetch-failed` — every other proxy failure (timeout, reset, unreachable
 *   network). One request cannot tell a host that is down or firewalled off
 *   from the public internet apart from a failure of the runner's own
 *   network, so this kind names both and blames neither.
 */
export type BrowserRefusalKind =
	| "off-origin"
	| "unsafe-address"
	| "connection-refused"
	| "host-not-found"
	| "certificate-invalid"
	| "tls-failed"
	| "fetch-failed";

export function refusalKindForGuardCode(
	code: OutboundRefusalCode,
): BrowserRefusalKind {
	switch (code) {
		case "off-origin":
			return "off-origin";
		case "destination-refused":
			return "unsafe-address";
		case "invalid-url":
		case "unsupported-scheme":
		case "unsupported-response":
		case "missing-location":
		case "redirect-replay":
		case "redirect-limit":
		case "direct-connection":
			return "fetch-failed";
		default: {
			const exhaustive: never = code;
			return exhaustive;
		}
	}
}

/** Node/undici codes for a TLS certificate the environment presented and the
 * runner could not verify. */
const CERTIFICATE_ERROR_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"CERT_UNTRUSTED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The system error code behind a failed fetch: undici wraps the socket or
 * DNS error as `cause` of a generic `TypeError("fetch failed")`. */
function fetchFailureCode(err: unknown): string | null {
	const pending = [err];
	const seen = new Set<unknown>();
	while (pending.length > 0) {
		const candidate = pending.shift();
		if (candidate === undefined || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			"code" in candidate &&
			typeof candidate.code === "string" &&
			!(
				candidate instanceof Error &&
				candidate.cause &&
				candidate.code === "UNSAFE_OUTBOUND_URL"
			)
		) {
			return candidate.code;
		}
		if (candidate instanceof Error) {
			pending.push(candidate.cause);
			if (candidate instanceof AggregateError) {
				pending.push(...candidate.errors);
			}
		}
	}
	return null;
}

/**
 * Which kind of refusal a failed proxy fetch is. Exported for its tests: the
 * wording a user reads depends entirely on this split, and getting it wrong
 * sends someone to debug the wrong side (Fizzy #2232).
 */
export function classifyFetchFailure(
	err: unknown,
): Exclude<BrowserRefusalKind, "off-origin" | "unsafe-address"> {
	const code = fetchFailureCode(err);
	if (code === "ECONNREFUSED") {
		return "connection-refused";
	}
	if (code === "ENOTFOUND") {
		return "host-not-found";
	}
	if (code !== null && CERTIFICATE_ERROR_CODES.has(code)) {
		return "certificate-invalid";
	}
	if (
		code !== null &&
		(code === "EPROTO" ||
			code.startsWith("ERR_SSL_") ||
			code.startsWith("ERR_TLS_"))
	) {
		return "tls-failed";
	}
	return "fetch-failed";
}

export function refusalForFetchError(
	url: string,
	error: unknown,
	isNavigation = true,
): BrowserRefusal {
	const code = fetchFailureCode(error);
	const kind =
		code === "UNSAFE_OUTBOUND_URL" ||
		getBlockedOutboundReason(error) ||
		getUnsafeUrlReason(url)
			? "unsafe-address"
			: classifyFetchFailure(error);
	const detail =
		code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
			? code
			: error instanceof Error && error.name === "TimeoutError"
				? "TIMEOUT: the request timed out"
				: "the request failed before a response was received";
	return { url: urlForDisplay(url), kind, detail, isNavigation };
}

/** A safe, neutral message when Playwright failed before the guard recorded one. */
export function describeNavigationFailure(url: string, error: unknown): string {
	return describeBrowserRefusal(refusalForFetchError(url, error));
}

export interface BrowserRefusal {
	url: string;
	kind: BrowserRefusalKind;
	detail: string;
	isNavigation?: boolean;
}

/** Last N refusals kept per run — enough to explain the failure that follows
 * without letting an adversarial page turn this into unbounded memory. */
const MAX_TRACKED_REFUSALS = 20;

/**
 * Origin + pathname only — never the query string or fragment.
 *
 * A refused off-origin redirect is routinely an OAuth or SSO hop, and its
 * query string or fragment can carry a `code`, `state`, or an access token
 * for the site it was refused reaching. This is the only form a refusal's
 * URL is ever stored, logged, or shown in — `recordRefusal` sanitizes at the
 * point of capture, so nothing downstream (the case's `failureMessage`,
 * persisted and later read by the RCA model) can leak what a page redirected
 * with.
 */
export function urlForDisplay(urlString: string): string {
	try {
		const url = new URL(urlString);
		return `${url.origin}${url.pathname}`;
	} catch {
		// Unparseable input: never echo it raw. Strip from the first
		// `?`/`#` — the only place a query or fragment could start — rather
		// than trust an origin that failed to parse.
		return urlString.split(/[?#]/)[0] ?? "";
	}
}

function recordRefusal(
	refusals: BrowserRefusal[],
	kind: BrowserRefusalKind,
	url: string,
	detail: string,
	isNavigation = false,
): void {
	refusals.push({ url: urlForDisplay(url), kind, detail, isNavigation });
	if (refusals.length > MAX_TRACKED_REFUSALS) {
		const resourceIndex = refusals.findIndex(
			(refusal) => refusal.isNavigation === false,
		);
		refusals.splice(resourceIndex < 0 ? 0 : resourceIndex, 1);
	}
	// Origin and kind only — never headers, cookies, or query strings, which
	// can carry a session token or another credential the log must not hold.
	let origin: string | null = null;
	try {
		origin = new URL(url).origin;
	} catch {
		origin = null;
	}
	logger.warn("qa.agentic_run.browser_request_blocked", { kind, origin });
}

/**
 * The plain-language explanation for one refusal, naming which side must act.
 * Exported so a caller building a user-facing "could not open the page"
 * message can append it without duplicating the wording per refusal kind.
 */
export function describeBrowserRefusal(refusal: BrowserRefusal): string {
	switch (refusal.kind) {
		case "off-origin":
			return `${refusal.isNavigation === false ? "A subresource requested" : "The page redirected to"} ${refusal.url}, outside this environment's origin — check the environment's base URL.`;
		case "unsafe-address":
			return `${refusal.url} resolved to a non-public address (${refusal.detail}) — this is an environment configuration problem, not a Fabric outage.`;
		case "connection-refused":
			return `${refusal.url} refused the connection (${refusal.detail}) — check that the environment is running and accepting connections.`;
		case "host-not-found":
			return `${refusal.url} does not resolve (${refusal.detail}) — check the environment's base URL.`;
		case "certificate-invalid":
			return `${refusal.url} presented a certificate the runner could not verify (${refusal.detail}) — check the environment's TLS certificate.`;
		case "tls-failed":
			return `${refusal.url} could not complete a TLS handshake (${refusal.detail}) — check the environment's TLS configuration.`;
		case "fetch-failed":
			return `The runner's request to ${refusal.url} failed before any response (${refusal.detail}). Either the environment is down or not reachable from the public internet, or the runner's own network failed — if the URL opens from outside your network, report it to Fabric support.`;
		default: {
			const never: never = refusal.kind;
			return String(never);
		}
	}
}

/**
 * The explanation for the MOST RECENT refusal, or `null` when none was
 * recorded — the shape a caller wants when it already knows a navigation
 * failed with `ERR_BLOCKED_BY_CLIENT` and just needs to know why.
 */
export function explainBlockedNavigation(
	refusals: readonly BrowserRefusal[],
): string | null {
	for (let index = refusals.length - 1; index >= 0; index -= 1) {
		const refusal = refusals[index];
		if (refusal?.isNavigation) {
			return describeBrowserRefusal(refusal);
		}
	}
	for (let index = refusals.length - 1; index >= 0; index -= 1) {
		const refusal = refusals[index];
		if (refusal?.isNavigation === undefined) {
			return describeBrowserRefusal(refusal);
		}
	}
	return null;
}

export interface RunnerBrowser {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	/** Bounded log of requests the route handler refused, most recent last. */
	refusals: BrowserRefusal[];
	abortController?: AbortController;
}

/**
 * Parse "1920x1080" into a viewport. Falls back to 1920x1080 rather than
 * throwing: a malformed resolution in a settings row must not be the reason a
 * run cannot start, and the default is the one the settings page itself offers
 * first.
 */
export function parseResolution(resolution: string): {
	width: number;
	height: number;
} {
	const match = /^(\d{3,5})x(\d{3,5})$/.exec(resolution.trim());
	if (!match) {
		return { width: 1920, height: 1080 };
	}
	return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Launch a browser for one run.
 *
 * A fresh context per run, never a shared or reused one. Cookies and storage
 * from a previous run leaking into the next would make a test that only passes
 * second look like a test that passes.
 */
export async function openBrowser(
	options: OpenBrowserOptions,
): Promise<RunnerBrowser> {
	// Imported dynamically for the same reason session-manager.ts does it: the
	// worker bundles activities eagerly and Playwright must not be resolved in
	// processes that never drive a browser.
	const playwright = await import("playwright");
	const engine =
		options.browser === "firefox"
			? playwright.firefox
			: options.browser === "webkit"
				? playwright.webkit
				: playwright.chromium;

	const browser = await engine.launch({ headless: true });
	// Everything after the launch has to clean up after itself. The caller wraps
	// this in `try { runner = await openBrowser() } finally { close(runner) }`,
	// which is correct and still cannot help here: if `newContext` or `newPage`
	// throws, this function never RETURNS, so `runner` is still null when the
	// finally runs and the browser that did launch is orphaned — a live Chromium
	// process held until it can be closed.
	//
	// Context or page creation can fail after launch because the browser process
	// exits, the worker loses resources, or Playwright rejects an option. Temporal
	// retries the activity, so an unclosed process would repeat per attempt.
	const refusals: BrowserRefusal[] = [];
	const abortController = new AbortController();
	try {
		const context = await browser.newContext({
			viewport: parseResolution(options.resolution),
			serviceWorkers: "block",
		});
		await installOutboundRequestGuard(context, undefined, {
			allowedOrigin: options.targetOrigin,
			relayHeaders:
				options.scopedHTTPHeaders?.origin === options.targetOrigin
					? options.scopedHTTPHeaders.headers
					: undefined,
			relayTimeoutMs: Math.max(
				1,
				Math.min(options.timeoutMs - 1_000, 25_000),
			),
			signal: options.signal
				? AbortSignal.any([options.signal, abortController.signal])
				: abortController.signal,
			onRequestFailed: ({ url, error, isNavigation }) => {
				const refusal = refusalForFetchError(url, error, isNavigation);
				recordRefusal(
					refusals,
					refusal.kind,
					url,
					refusal.detail,
					isNavigation,
				);
			},
			onBlocked: ({ url, code, reason, isNavigation }) => {
				recordRefusal(
					refusals,
					refusalKindForGuardCode(code),
					url,
					reason,
					isNavigation,
				);
			},
		});
		const page = await context.newPage();
		page.setDefaultTimeout(options.timeoutMs);
		return { browser, context, page, refusals, abortController };
	} catch (err) {
		abortController.abort();
		// Closing the browser closes any context it already owns, so this one call
		// covers both the `newContext` and the `newPage` failure. Best-effort: the
		// original error is what the caller needs, and a close failure here must
		// not replace it with a less useful one.
		await browser.close().catch(() => {});
		throw err;
	}
}

export async function closeBrowser(runner: RunnerBrowser): Promise<void> {
	runner.abortController?.abort();
	// Best-effort and in order. A browser left running outlives the activity and
	// leaks a process on the worker, so a failure to close one layer must not
	// stop the next from being tried.
	for (const close of [
		() => runner.page.close(),
		() => runner.context.close(),
		() => runner.browser.close(),
	]) {
		try {
			await close();
		} catch {
			// Nothing actionable: the run's verdict is already decided by now.
		}
	}
}

/**
 * A compact ARIA description of what is on screen — the model's eyes.
 *
 * Truncated hard. A large app's aria tree can run to tens of thousands of
 * tokens, which would blow both the context window and the cost estimate this
 * feature is capped against. The cut is announced in the text so the model knows
 * it is looking at a partial page rather than a short one.
 */
export async function snapshotPage(
	page: Page,
	limit = 12_000,
): Promise<string> {
	let snapshot: string;
	try {
		snapshot = await page.locator("body").ariaSnapshot();
	} catch (err) {
		// A page mid-navigation cannot be snapshotted. That is a fact worth
		// handing to the model, not an exception worth ending the run over.
		return `(The page could not be read: ${err instanceof Error ? err.message : String(err)})`;
	}
	return snapshot.length <= limit
		? snapshot
		: `${snapshot.slice(0, limit)}\n… snapshot truncated; the page is larger than shown.`;
}

/**
 * Resolve an operation's target. Exported so the failure to find something is
 * reported as an observation ("no button called X") rather than as a thrown
 * timeout with a Playwright stack in it.
 */
function locate(page: Page, role: string, name: string) {
	// `getByRole` with an exact-ish name is the closest match to what the aria
	// snapshot showed the model. Not exact:true — accessible names routinely
	// carry surrounding whitespace or a trailing icon label, and failing a step
	// over that would blame the product for a naming subtlety.
	return page.getByRole(role as Parameters<Page["getByRole"]>[0], {
		name,
	});
}

export interface OperationOutcome {
	ok: boolean;
	/** What happened, in words a person reads in the step log. */
	detail: string;
}

/**
 * Perform one operation.
 *
 * Never throws for an ordinary "could not do that" — a missing element is a
 * result, and the step log is where it belongs. Only a genuinely broken page
 * (navigation dead) surfaces as ok:false with the reason.
 */
export async function performOperation(
	page: Page,
	operation: BrowserOperation,
	baseUrl: string,
	refusals: readonly BrowserRefusal[] = [],
): Promise<OperationOutcome> {
	const previousRefusals = new Set(refusals);
	try {
		let detail: string;
		switch (operation.kind) {
			case "click":
				await locate(page, operation.role, operation.name)
					.first()
					.click();
				detail = `Clicked ${operation.role} “${operation.name}”.`;
				break;
			case "fill":
				await locate(page, operation.role, operation.name)
					.first()
					.fill(operation.text);
				detail = `Typed into ${operation.role} “${operation.name}”.`;
				break;
			case "press":
				await page.keyboard.press(operation.key);
				detail = `Pressed ${operation.key}.`;
				break;
			case "goto": {
				const target = resolveSameOriginUrl(baseUrl, operation.path);
				if (!target) {
					// The one operation that could leave the system under test.
					// Refused rather than clamped, so the step log says the model
					// tried it.
					return {
						ok: false,
						detail: `The requested navigation was outside this environment's origin — check the environment's base URL.`,
					};
				}
				await page.goto(target, { waitUntil: "domcontentloaded" });
				detail = `Navigated to ${urlForDisplay(target)}.`;
				break;
			}
			case "wait": {
				const ms = Math.min(Math.max(operation.ms, 0), 10_000);
				await page.waitForTimeout(ms);
				detail = `Waited ${ms}ms.`;
				break;
			}
			default: {
				// Exhaustiveness: a new operation added to the union without a
				// branch here fails the build rather than silently no-opping.
				const never: never = operation;
				return {
					ok: false,
					detail: `Unsupported operation: ${String(never)}`,
				};
			}
		}
		await settleNavigation(page);
		const refusal = explainBlockedNavigation(
			refusals.filter((entry) => !previousRefusals.has(entry)),
		);
		return refusal ? { ok: false, detail: refusal } : { ok: true, detail };
	} catch (err) {
		const explanation = explainBlockedNavigation(
			refusals.filter((refusal) => !previousRefusals.has(refusal)),
		);
		if (explanation) {
			return { ok: false, detail: explanation };
		}
		return {
			ok: false,
			detail:
				err instanceof Error
					? // Playwright's timeout messages are multi-paragraph and include
						// a selector dump; only the first line is useful in a log a
						// person reads.
						(err.message.split("\n")[0] ?? err.message)
					: String(err),
		};
	}
}

/**
 * Keep navigation inside the environment being tested.
 *
 * Returns null for anything that would leave the origin. This is the guard that
 * stops a run signed in with a customer's credential from being talked into
 * visiting somewhere else with that session live.
 */
export function resolveSameOriginUrl(
	baseUrl: string,
	path: string,
): string | null {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		return null;
	}
	let candidate: URL;
	try {
		candidate = new URL(path, base);
	} catch {
		return null;
	}
	return candidate.origin === base.origin ? candidate.toString() : null;
}

/**
 * Type a secret into a field.
 *
 * Separate from {@link performOperation} on purpose. The password never becomes
 * part of an operation object, so it cannot be logged by the generic
 * "what did we just do" path, cannot reach the model, and cannot end up in a
 * step observation. The only thing recorded is that a sign-in was attempted.
 */
export async function fillSecret(
	page: Page,
	role: string,
	name: string,
	secret: string,
): Promise<boolean> {
	try {
		await locate(page, role, name).first().fill(secret);
		return true;
	} catch {
		return false;
	}
}

function isAbortedNavigation(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("net::ERR_ABORTED") ||
			error.message.includes("Navigation interrupted by another one"))
	);
}

async function openAppAfterFormSignIn(
	page: Page,
	baseUrl: string,
): Promise<OperationOutcome> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
			return { ok: true, detail: "Opened the app after sign-in." };
		} catch (error) {
			lastError = error;
			if (!isAbortedNavigation(error) || attempt === 1) {
				break;
			}
			try {
				await page.waitForLoadState("domcontentloaded", {
					timeout: 5_000,
				});
			} catch {
				// The competing navigation may itself be long-running. The retry
				// below is still the authoritative attempt to open the app.
			}
		}
	}

	return {
		ok: false,
		detail: `Signed in, but could not then open ${urlForDisplay(baseUrl)}. ${describeNavigationFailure(baseUrl, lastError)}`,
	};
}

/**
 * Sign in with a FORM credential, deterministically — no model involved.
 *
 * The model is not asked to do this, and that is a security decision rather than
 * a simplification. Handing an agent the password and letting it decide where to
 * put it means the secret is in a prompt, in a provider's logs, and one
 * hallucinated field away from being typed into a search box that posts it
 * somewhere. Here the secret only ever reaches {@link fillSecret}.
 *
 * The field-finding is intentionally boring: the label or placeholder a sign-in
 * form uses is one of a handful of words in practice, and when it is not, the
 * honest outcome is "could not sign in" rather than a clever guess that half
 * works and produces a run full of false failures.
 */
export async function signInWithForm(
	page: Page,
	baseUrl: string,
	username: string,
	secret: string,
	/**
	 * Where the form actually lives, when it is not at `baseUrl`.
	 *
	 * Null means "the form is at the base URL", which is what this always
	 * assumed. It only holds for an app whose landing page is its login page;
	 * anything with a marketing site in front of it had to point `baseUrl` at
	 * the login page and misdescribe where the app is.
	 */
	signInUrl?: string | null,
): Promise<OperationOutcome> {
	const formUrl = signInUrl?.trim() || baseUrl;
	try {
		await page.goto(formUrl, { waitUntil: "domcontentloaded" });
		await settleNavigation(page);
	} catch (err) {
		return {
			ok: false,
			detail: describeNavigationFailure(formUrl, err),
		};
	}

	const usernameField = page
		.getByLabel(/e-?mail|username|user name|login/i)
		.or(page.locator('input[type="email"]'))
		.or(page.locator('input[name="email" i], input[name="username" i]'))
		.first();
	try {
		await usernameField.fill(username);
	} catch {
		return {
			ok: false,
			// Names the URL actually visited and the field that would move it,
			// because "the sign-in page" is ambiguous once there are two.
			detail: signInUrl
				? `Could not find a username or email field at ${formUrl}. Check the environment's sign-in URL points at the page with the form.`
				: `Could not find a username or email field at ${formUrl}. Set the environment's sign-in URL if the form is on a different page from the app.`,
		};
	}

	// Password inputs have no implicit ARIA role, so they are located by type
	// rather than by role — the one place this file does not use the model's
	// vocabulary, because the accessibility tree simply does not expose them.
	const passwordField = page.locator('input[type="password"]').first();
	let filled = false;
	try {
		await passwordField.fill(secret);
		filled = true;
	} catch {
		filled = false;
	}
	if (!filled) {
		return {
			ok: false,
			detail: "Could not find a password field on the sign-in page.",
		};
	}

	const submit = page
		.getByRole("button", { name: /sign in|log ?in|continue|submit/i })
		.first();
	try {
		await submit.click();
	} catch {
		// Some forms submit on Enter and have no button with a recognisable name.
		await page.keyboard.press("Enter");
	}

	try {
		await page.waitForLoadState("networkidle", { timeout: 15_000 });
	} catch {
		// A page that keeps a socket open never reaches networkidle. Not a
		// sign-in failure on its own — the next step's snapshot will show
		// whether we are actually in.
	}

	// Signing in somewhere else leaves the browser on whatever that form
	// redirected to, which is not necessarily the app under test. Go to the base
	// URL so every case starts from the same place regardless of where the form
	// lived. Skipped when they are the same page — a second navigation there
	// would throw away a redirect the app just made.
	if (formUrl !== baseUrl) {
		const openedApp = await openAppAfterFormSignIn(page, baseUrl);
		if (!openedApp.ok) {
			return openedApp;
		}
	}

	try {
		await settleNavigation(page);
		return { ok: true, detail: "Submitted the sign-in form." };
	} catch (error) {
		return {
			ok: false,
			detail:
				error instanceof Error
					? (error.message.split("\n")[0] ?? error.message)
					: String(error),
		};
	}
}

/** A PNG of the current viewport, for evidence. */
export async function captureScreenshot(page: Page): Promise<Buffer | null> {
	try {
		return await page.screenshot({ type: "png" });
	} catch {
		// Evidence is desirable, never load-bearing: a screenshot that cannot be
		// taken must not change a step's verdict.
		return null;
	}
}
