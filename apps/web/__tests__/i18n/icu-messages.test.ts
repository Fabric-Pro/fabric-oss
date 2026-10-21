import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import type { IntlError } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// vitest.setup.ts mocks next-intl; this test needs the real formatter.
const { createTranslator, IntlErrorCode } =
	await vi.importActual<typeof import("next-intl")>("next-intl");

/**
 * Each message must parse in next-intl's development build, and a message that
 * renders without values must read the same in development and production.
 * Messages that need values are checked for syntax only.
 *
 * The two builds differ (use-intl 4.11 `format-message`): development compiles
 * any message containing `<` or `{`, so a literal placeholder such as
 * `fabric-spike/<run>` throws UNCLOSED_TAG there. Production returns a message
 * passed no values verbatim unless it contains `'{` or `'}`, so ICU quoting
 * like `'<run>'` shows its apostrophes in production. Placeholders in copy
 * therefore need rewording, not escaping.
 */

// zod-i18n-map messages in i18next syntax (`{- maximum, datetime}`), carried
// over from the starter template. No caller passed them to next-intl when this
// test was written (source search, not an enforced rule).
const NOT_FORMATTED_BY_NEXT_INTL = ["zod."];

type Messages = Record<string, unknown>;

function collectPaths(node: Messages, prefix: string, out: string[]): void {
	for (const [key, child] of Object.entries(node)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof child === "string") {
			out.push(path);
		} else if (typeof child === "object" && child !== null) {
			collectPaths(child as Messages, path, out);
		}
	}
}

function rawMessage(messages: Messages, path: string): string {
	return path
		.split(".")
		.reduce<unknown>(
			(node, key) => (node as Messages)[key],
			messages,
		) as string;
}

/** Renders `path` with no values, as a plain `t(path)` call does. */
function renderWithoutValues(messages: Messages, path: string) {
	let error: IntlError | undefined;
	const t = createTranslator({
		locale: "en",
		messages,
		onError: (e) => {
			error = e;
		},
	});
	const output = t(path as never);
	return { error, output };
}

function findProblems(messages: Messages): string[] {
	const paths: string[] = [];
	collectPaths(messages, "", paths);
	const problems: string[] = [];
	for (const path of paths) {
		if (
			NOT_FORMATTED_BY_NEXT_INTL.some((prefix) => path.startsWith(prefix))
		) {
			continue;
		}
		const raw = rawMessage(messages, path);
		const { error, output } = renderWithoutValues(messages, path);
		if (error?.code === IntlErrorCode.INVALID_MESSAGE) {
			problems.push(`${path}: ${error.message}`);
		} else if (!error && !/'[{}]/.test(raw) && output !== raw) {
			// Production would skip compiling and show `raw` instead.
			problems.push(
				`${path}: renders as ${JSON.stringify(output)} in development but ${JSON.stringify(raw)} in production`,
			);
		}
	}
	return problems;
}

describe("translation messages", () => {
	it("runs against next-intl's development build, which parses tags", () => {
		// Under the production build the checks below would miss both defects.
		expect(findProblems({ hint: "fabric-spike/<run>" })).toEqual([
			expect.stringContaining("UNCLOSED_TAG"),
		]);
		expect(findProblems({ hint: "fabric-spike/'<run>'" })).toEqual([
			expect.stringContaining("in production"),
		]);
	});

	it.each([
		["en", en],
		["de", de],
	])(
		"%s messages parse, and value-free ones render the same in both builds",
		(_locale, messages) => {
			expect(findProblems(messages as Messages)).toEqual([]);
		},
	);
});
