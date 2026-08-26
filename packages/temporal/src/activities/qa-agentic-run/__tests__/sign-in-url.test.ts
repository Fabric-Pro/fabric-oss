/**
 * Where the runner looks for the sign-in form.
 *
 * `targetBaseUrl` used to mean two things at once — "where the application is"
 * and "where the login form is" — because `signInWithForm` navigated to it and
 * expected the fields to be there. That only holds for an app whose landing page
 * IS its login page; anything with a marketing site in front had to point the
 * base URL at the login page and misdescribe where the app is.
 *
 * The two behaviours worth pinning are the ones a customer would notice: a null
 * sign-in URL must behave EXACTLY as before (no existing environment may change
 * meaning), and a set one must sign in there and then land on the app.
 */

import { describe, expect, it, vi } from "vitest";
import { signInWithForm } from "../browser-driver";

/**
 * The smallest page that behaves like the real one for this function: it records
 * navigations, and its locators fill or throw depending on whether the URL it is
 * currently on is the one carrying the form.
 */
function makePage(options: { formAtUrl: string }) {
	const visited: string[] = [];
	let current = "";

	const field = (works: () => boolean) => ({
		fill: vi.fn(async () => {
			if (!works()) {
				throw new Error("no such field");
			}
		}),
		or() {
			return this;
		},
		first() {
			return this;
		},
		click: vi.fn(async () => undefined),
	});

	const onForm = () => current === options.formAtUrl;

	return {
		visited,
		page: {
			goto: vi.fn(async (url: string) => {
				visited.push(url);
				current = url;
			}),
			getByLabel: () => field(onForm),
			locator: () => field(onForm),
			getByRole: () => field(() => true),
			keyboard: { press: vi.fn(async () => undefined) },
			waitForLoadState: vi.fn(async () => undefined),
		} as never,
	};
}

const APP = "https://app.example.com";
const LOGIN = "https://app.example.com/auth/login";

describe("signInWithForm", () => {
	it("signs in at the base URL when no sign-in URL is set", async () => {
		const { page, visited } = makePage({ formAtUrl: APP });

		const result = await signInWithForm(
			page,
			APP,
			"user@example.com",
			"pw",
		);

		expect(result.ok).toBe(true);
		// Exactly one navigation: the previous behaviour, unchanged. A second
		// goto here would throw away whatever the app redirected to on sign-in.
		expect(visited).toEqual([APP]);
	});

	it("signs in at the sign-in URL, then goes to the app", async () => {
		const { page, visited } = makePage({ formAtUrl: LOGIN });

		const result = await signInWithForm(
			page,
			APP,
			"user@example.com",
			"pw",
			LOGIN,
		);

		expect(result.ok).toBe(true);
		// The case must start on the app, not on wherever the login form left us.
		expect(visited).toEqual([LOGIN, APP]);
	});

	it("treats a blank sign-in URL as unset rather than navigating to nothing", async () => {
		const { page, visited } = makePage({ formAtUrl: APP });

		const result = await signInWithForm(
			page,
			APP,
			"user@example.com",
			"pw",
			"   ",
		);

		expect(result.ok).toBe(true);
		expect(visited).toEqual([APP]);
	});

	it("fails with a URL a person can act on when the form is not where it looked", async () => {
		const { page } = makePage({ formAtUrl: LOGIN });

		// No sign-in URL, so it looks at the app root and finds nothing.
		const result = await signInWithForm(
			page,
			APP,
			"user@example.com",
			"pw",
		);

		expect(result.ok).toBe(false);
		// Names the URL actually visited, and the field that would fix it.
		expect(result.detail).toContain(APP);
		expect(result.detail).toContain("sign-in URL");
	});
});
