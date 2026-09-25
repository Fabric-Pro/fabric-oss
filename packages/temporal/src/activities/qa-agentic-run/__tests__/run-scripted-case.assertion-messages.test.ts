/**
 * Fizzy #2235 — a scripted assertion failure must carry both sides of the
 * comparison, in the exact `Expected:` / `Received:` shape
 * `parseAssertionValues` (`@repo/database`) already recognises, so the RCA
 * model and a bug body get real values instead of "did not match".
 *
 * `TRUSTED_RUNNER` is plain JS text run inside a sandbox, not a module this
 * package can import — so this test isolates its pure step-execution logic
 * with `node:vm` and runs it for real against a fake `page`, rather than
 * duplicating the message strings in TypeScript and hoping they stay in
 * sync. Only `executeStep` and what it calls are evaluated; `main()` (which
 * touches `process.env`, a real sandbox and Playwright) is sliced off before
 * the source ever reaches `vm`.
 */

import { createContext, runInContext } from "node:vm";
import { parseAssertionValues } from "@repo/database";
import { describe, expect, it } from "vitest";
import { TRUSTED_RUNNER } from "../run-scripted-case";

interface FakeLocator {
	first(): FakeLocator;
	isVisible(): Promise<boolean>;
	textContent(): Promise<string | null>;
}

interface FakePage {
	url(): string;
	getByRole: (...args: unknown[]) => FakeLocator;
	getByLabel: (...args: unknown[]) => FakeLocator;
	getByText: (...args: unknown[]) => FakeLocator;
	getByPlaceholder: (...args: unknown[]) => FakeLocator;
	getByTestId: (...args: unknown[]) => FakeLocator;
}

function loadRunnerHelpers(): Record<string, unknown> {
	// Isolate everything ABOVE `main()` — the helpers and `executeStep` — and
	// never evaluate `main()` itself.
	const boundary = TRUSTED_RUNNER.indexOf("\nasync function main() {");
	if (boundary === -1) {
		throw new Error(
			"Could not find the main() boundary in TRUSTED_RUNNER — its shape changed; update this test's slice point.",
		);
	}
	const helperSource = TRUSTED_RUNNER.slice(0, boundary);

	const sandbox: Record<string, unknown> = {
		URL,
		require(name: string) {
			if (name === "node:fs") {
				return {};
			}
			throw new Error(
				`Unexpected require("${name}") from the sandboxed runner helpers.`,
			);
		},
	};
	createContext(sandbox);
	runInContext(
		`${helperSource}
globalThis.__executeStep = executeStep;
globalThis.__urlForDisplay = urlForDisplay;
globalThis.__describeBlockedNavigation = describeBlockedNavigation;`,
		sandbox,
	);
	return sandbox;
}

function loadExecuteStep(): (
	page: FakePage,
	baseUrl: string,
	step: Record<string, unknown>,
) => Promise<void> {
	return loadRunnerHelpers().__executeStep as (
		page: FakePage,
		baseUrl: string,
		step: Record<string, unknown>,
	) => Promise<void>;
}

function locatorReturning(overrides: Partial<FakeLocator> = {}): FakeLocator {
	const locator: FakeLocator = {
		first: () => locator,
		isVisible: async () => true,
		textContent: async () => "",
		...overrides,
	};
	return locator;
}

function fakePage(
	overrides: Partial<FakePage> & { url: () => string },
): FakePage {
	const miss = () => locatorReturning();
	return {
		getByRole: miss,
		getByLabel: miss,
		getByText: miss,
		getByPlaceholder: miss,
		getByTestId: miss,
		...overrides,
	};
}

const BASE_URL = "https://example.com";

describe("TRUSTED_RUNNER assertion failure messages", () => {
	it("assertUrl reports the resolved expected URL and the actual one, in the direction parseAssertionValues expects", async () => {
		const executeStep = loadExecuteStep();
		const page = fakePage({ url: () => "https://example.com/en/docs/x" });

		let thrown: Error | undefined;
		try {
			await executeStep(page, BASE_URL, {
				action: "assertUrl",
				path: "/docs/x",
			});
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown).toBeDefined();
		const parsed = parseAssertionValues(thrown?.message);
		expect(parsed).toEqual({
			expected: "https://example.com/docs/x",
			actual: "https://example.com/en/docs/x",
		});
	});

	it("assertText reports the expected substring and what the element actually had", async () => {
		const executeStep = loadExecuteStep();
		const page = fakePage({
			url: () => BASE_URL,
			getByTestId: () =>
				locatorReturning({ textContent: async () => "Goodbye" }),
		});

		let thrown: Error | undefined;
		try {
			await executeStep(page, BASE_URL, {
				action: "assertText",
				locator: { by: "testId", value: "banner" },
				value: "Welcome",
			});
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown).toBeDefined();
		const parsed = parseAssertionValues(thrown?.message);
		expect(parsed).toEqual({ expected: "Welcome", actual: "Goodbye" });
	});

	it("assertText names an empty element rather than an empty Received value", async () => {
		const executeStep = loadExecuteStep();
		const page = fakePage({
			url: () => BASE_URL,
			getByTestId: () =>
				locatorReturning({ textContent: async () => null }),
		});

		let thrown: Error | undefined;
		try {
			await executeStep(page, BASE_URL, {
				action: "assertText",
				locator: { by: "testId", value: "banner" },
				value: "Welcome",
			});
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("(the element had no text)");
	});

	it("assertVisible names the locator instead of failing anonymously", async () => {
		const executeStep = loadExecuteStep();
		const page = fakePage({
			url: () => BASE_URL,
			getByRole: () => locatorReturning({ isVisible: async () => false }),
		});

		let thrown: Error | undefined;
		try {
			await executeStep(page, BASE_URL, {
				action: "assertVisible",
				locator: { by: "role", role: "button", name: "Sign in" },
			});
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain('role=button "Sign in"');
	});

	it("step-number prefixing (main()'s own wrapping) preserves the multi-line shape", () => {
		// `main()` wraps a caught step failure as
		// `"Step " + (index + 1) + " failed: " + safeMessage(error)` — a plain
		// string concatenation, so the newlines inside the inner message are
		// untouched and still land at the start of their own line.
		const inner =
			"Page URL did not match the expected path.\nExpected: https://example.com/docs/x\nReceived: https://example.com/en/docs/x";
		const wrapped = `Step 2 failed: ${inner}`;
		expect(parseAssertionValues(wrapped)).toEqual({
			expected: "https://example.com/docs/x",
			actual: "https://example.com/en/docs/x",
		});
	});
});

describe("TRUSTED_RUNNER explains a blocked navigation (Fizzy #2232 parity)", () => {
	it("names the off-origin redirect target without its query or fragment", () => {
		const helpers = loadRunnerHelpers();
		const urlForDisplay = helpers.__urlForDisplay as (
			url: string,
		) => string;
		const describeBlockedNavigation =
			helpers.__describeBlockedNavigation as (
				url: string | null,
			) => string;

		const explanation = describeBlockedNavigation(
			urlForDisplay(
				"https://sso.example.org/authorize?code=secret-code#access_token=t1",
			),
		);

		expect(explanation).toBe(
			"The page redirected to https://sso.example.org/authorize, outside this environment's origin — check the environment's base URL.",
		);
	});

	it("says nothing when no off-origin request was refused", () => {
		const describeBlockedNavigation = loadRunnerHelpers()
			.__describeBlockedNavigation as (url: string | null) => string;

		expect(describeBlockedNavigation(null)).toBe("");
	});
});
