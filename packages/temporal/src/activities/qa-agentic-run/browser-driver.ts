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

import { safeFetchOutbound } from "@repo/utils/url-security";
import type { Browser, BrowserContext, Page } from "playwright";

type BrowserCookie = Parameters<BrowserContext["addCookies"]>[0][number];

/** The closed set of things a step is allowed to do. */
export type BrowserOperation =
	| { kind: "click"; role: string; name: string }
	| { kind: "fill"; role: string; name: string; text: string }
	| { kind: "press"; key: string }
	| { kind: "goto"; path: string }
	| { kind: "wait"; ms: number }
	/** The page already satisfies the step — assess without touching anything. */
	| { kind: "none" };

export interface OpenBrowserOptions {
	browser: string;
	/** "1920x1080" — the QA policy's own format. */
	resolution: string;
	timeoutMs: number;
	/** The only HTTP(S) origin this credentialed browser may reach. */
	targetOrigin: string;
	scopedHTTPHeaders?: {
		origin: string;
		headers: Record<string, string>;
	};
}

export interface RunnerBrowser {
	browser: Browser;
	context: BrowserContext;
	page: Page;
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

export function headersForRequest(
	requestUrl: string,
	requestHeaders: Record<string, string>,
	scopedHeaders: OpenBrowserOptions["scopedHTTPHeaders"],
): Record<string, string> {
	if (!scopedHeaders) {
		return requestHeaders;
	}

	let requestOrigin: string;
	try {
		requestOrigin = new URL(requestUrl).origin;
	} catch {
		return requestHeaders;
	}
	if (requestOrigin !== scopedHeaders.origin) {
		return requestHeaders;
	}

	const overriddenNames = new Set(
		Object.keys(scopedHeaders.headers).map((name) => name.toLowerCase()),
	);
	return {
		...Object.fromEntries(
			Object.entries(requestHeaders).filter(
				([name]) => !overriddenNames.has(name.toLowerCase()),
			),
		),
		...scopedHeaders.headers,
	};
}

function parseResponseCookie(
	responseUrl: string,
	rawCookie: string,
): BrowserCookie | null {
	const parsedResponseUrl = new URL(responseUrl);
	const [nameValue, ...rawAttributes] = rawCookie.split(";");
	if (!nameValue) {
		return null;
	}

	const separator = nameValue.indexOf("=");
	if (separator <= 0) {
		return null;
	}

	const name = nameValue.slice(0, separator).trim();
	const value = nameValue.slice(separator + 1).trim();
	const attributes = new Map<string, string>();
	for (const rawAttribute of rawAttributes) {
		const attribute = rawAttribute.trim();
		if (!attribute) {
			continue;
		}
		const attributeSeparator = attribute.indexOf("=");
		const key = (
			attributeSeparator === -1
				? attribute
				: attribute.slice(0, attributeSeparator)
		)
			.trim()
			.toLowerCase();
		const attributeValue =
			attributeSeparator === -1
				? ""
				: attribute.slice(attributeSeparator + 1).trim();
		attributes.set(key, attributeValue);
	}

	const configuredPath = attributes.get("path");
	const lastSlash = parsedResponseUrl.pathname.lastIndexOf("/");
	const defaultPath =
		lastSlash <= 0 ? "/" : parsedResponseUrl.pathname.slice(0, lastSlash);
	const path = configuredPath?.startsWith("/") ? configuredPath : defaultPath;
	const cookie: BrowserCookie = {
		name,
		value,
		domain: parsedResponseUrl.hostname,
		path,
		httpOnly: attributes.has("httponly"),
		secure: attributes.has("secure"),
	};
	const domain = attributes.get("domain");
	if (domain) {
		const responseHost = parsedResponseUrl.hostname.toLowerCase();
		const cookieDomain = domain.replace(/^\./, "").toLowerCase();
		if (
			responseHost !== cookieDomain &&
			!responseHost.endsWith(`.${cookieDomain}`)
		) {
			return null;
		}
		cookie.domain = domain;
	}

	const sameSite = attributes.get("samesite")?.toLowerCase();
	if (sameSite === "strict") {
		cookie.sameSite = "Strict";
	} else if (sameSite === "lax") {
		cookie.sameSite = "Lax";
	} else if (sameSite === "none") {
		cookie.sameSite = "None";
	}

	const maxAge = attributes.get("max-age");
	if (maxAge !== undefined) {
		const seconds = Number.parseInt(maxAge, 10);
		if (Number.isFinite(seconds)) {
			cookie.expires = Math.max(
				1,
				Math.floor(Date.now() / 1000) + seconds,
			);
		}
	} else {
		const expires = attributes.get("expires");
		if (expires) {
			const timestamp = Date.parse(expires);
			if (Number.isFinite(timestamp)) {
				cookie.expires = Math.max(1, Math.floor(timestamp / 1000));
			}
		}
	}

	return cookie;
}

function responseCookiesForBrowser(
	responseUrl: string,
	headers: Headers,
): BrowserCookie[] {
	return headers
		.getSetCookie()
		.map((rawCookie) => parseResponseCookie(responseUrl, rawCookie))
		.filter((cookie): cookie is BrowserCookie => cookie !== null);
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
	try {
		const context = await browser.newContext({
			viewport: parseResolution(options.resolution),
		});
		await context.route("**/*", async (route) => {
			const request = route.request();
			const requestUrl = request.url();
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(requestUrl);
			} catch {
				await route.abort("blockedbyclient");
				return;
			}
			if (
				parsedUrl.protocol !== "http:" &&
				parsedUrl.protocol !== "https:"
			) {
				await route.continue();
				return;
			}
			if (parsedUrl.origin !== options.targetOrigin) {
				await route.abort("blockedbyclient");
				return;
			}
			try {
				const method = request.method();
				const response = await safeFetchOutbound(requestUrl, {
					method,
					// Fulfil redirects back to Playwright instead of following them in
					// the server-side fetch. The browser then issues the next request,
					// which passes through this same origin guard before any network
					// access. This preserves browser navigation semantics (including
					// POST redirect handling) without widening the credential boundary.
					redirect: "manual",
					headers: headersForRequest(
						requestUrl,
						request.headers(),
						options.scopedHTTPHeaders,
					),
					body:
						method === "GET" || method === "HEAD"
							? undefined
							: (request.postData() ?? undefined),
				});
				const responseHeaders: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					if (key.toLowerCase() !== "set-cookie") {
						responseHeaders[key] = value;
					}
				});
				const responseCookies = responseCookiesForBrowser(
					requestUrl,
					response.headers,
				);
				if (responseCookies.length > 0) {
					await context.addCookies(responseCookies);
				}
				await route.fulfill({
					status: response.status,
					headers: responseHeaders,
					body: Buffer.from(await response.arrayBuffer()),
				});
			} catch {
				await route.abort("blockedbyclient");
			}
		});
		const page = await context.newPage();
		page.setDefaultTimeout(options.timeoutMs);
		return { browser, context, page };
	} catch (err) {
		// Closing the browser closes any context it already owns, so this one call
		// covers both the `newContext` and the `newPage` failure. Best-effort: the
		// original error is what the caller needs, and a close failure here must
		// not replace it with a less useful one.
		await browser.close().catch(() => {});
		throw err;
	}
}

export async function closeBrowser(runner: RunnerBrowser): Promise<void> {
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
): Promise<OperationOutcome> {
	try {
		switch (operation.kind) {
			case "click":
				await locate(page, operation.role, operation.name)
					.first()
					.click();
				return {
					ok: true,
					detail: `Clicked ${operation.role} “${operation.name}”.`,
				};
			case "fill":
				await locate(page, operation.role, operation.name)
					.first()
					.fill(operation.text);
				return {
					ok: true,
					detail: `Typed into ${operation.role} “${operation.name}”.`,
				};
			case "press":
				await page.keyboard.press(operation.key);
				return { ok: true, detail: `Pressed ${operation.key}.` };
			case "goto": {
				const target = resolveSameOriginUrl(baseUrl, operation.path);
				if (!target) {
					// The one operation that could leave the system under test.
					// Refused rather than clamped, so the step log says the model
					// tried it.
					return {
						ok: false,
						detail: `Refused to navigate outside ${baseUrl}.`,
					};
				}
				await page.goto(target, { waitUntil: "domcontentloaded" });
				return { ok: true, detail: `Navigated to ${target}.` };
			}
			case "wait":
				await page.waitForTimeout(
					Math.min(Math.max(operation.ms, 0), 10_000),
				);
				return { ok: true, detail: `Waited ${operation.ms}ms.` };
			case "none":
				return {
					ok: true,
					detail: "No interaction needed — checked the page as it stood.",
				};
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
	} catch (err) {
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
	} catch (err) {
		return {
			ok: false,
			detail: `Could not open ${formUrl}: ${err instanceof Error ? err.message : String(err)}`,
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
		try {
			await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
		} catch (err) {
			return {
				ok: false,
				detail: `Signed in, but could not then open ${baseUrl}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}

	return { ok: true, detail: "Submitted the sign-in form." };
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
