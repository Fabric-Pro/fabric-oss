/**
 * Pins the theme a visitor gets before they have ever chosen one.
 *
 * This value has now been wrong in both directions. It shipped as `"dark"`,
 * which put every fresh browser in dark mode regardless of the operating
 * system; Fizzy #2359 replaced that with `"light"`, which made the same
 * mistake with the opposite colour. Fizzy #2518 settled it: the app defers to
 * the operating system's `prefers-color-scheme` and only overrides it when
 * someone has actually picked a theme. Any concrete value here is a
 * regression, not a preference.
 *
 * A single word in `config/index.ts` is trivially reverted by a merge, a
 * copy-paste from an older branch, or a well-meaning "restore the old look"
 * edit, and nothing else in the suite would notice: the app renders fine
 * either way. So this is a deliberate exception to the house rule of testing
 * behaviour rather than implementation — the value IS the behaviour here, and
 * pinning it turns a silent regression into a red build.
 *
 * The second assertion is not redundant. `config/types.ts` types the default
 * as `Config["ui"]["enabledThemes"][number] | "system"`, a union of the
 * *declared* theme names — it does not track the array that is actually
 * configured. So narrowing `enabledThemes` to `["dark"]` still compiles, and
 * only the second assertion catches a palette that cannot serve both arms of
 * the system preference.
 *
 * Neither assertion can tell a configured `"system"` from an *honoured* one —
 * both read configuration, and the provider is free to ignore it. That claim
 * needs the real library resolving a real media query, and is made in
 * `apps/web/__tests__/system-theme-resolution.test.tsx`.
 *
 * Deliberately imports the real `@repo/config` — mocking it here would pin the
 * mock, not the shipped configuration. The complementary check, that the
 * provider forwards this value instead of hardcoding its own, lives in
 * `apps/web/modules/shared/components/ClientProviders.test.tsx`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "@repo/config";
import { describe, expect, it } from "vitest";

describe("default theme", () => {
	it("defers to the visitor's system preference", () => {
		expect(config.ui.defaultTheme).toBe("system");
	});

	it("keeps both themes selectable, so either resolution lands", () => {
		// "system" is not itself renderable: it resolves to one of these two.
		// Dropping either one leaves half the visitors with a default that
		// cannot be applied.
		expect(config.ui.enabledThemes).toContain("light");
		expect(config.ui.enabledThemes).toContain("dark");
	});
});

/**
 * Pins the one line that keeps the marketing and documentation routes on the
 * application's theme authority.
 *
 * Fumadocs' `RootProvider` mounts a second next-themes provider defaulting to
 * "system" under the storage key "theme". It is inert only while fumadocs-ui
 * and apps/web resolve to a single physical copy of next-themes — a nested
 * provider that sees an outer one through the shared context collapses to a
 * pass-through. A version bump that installs a second copy breaks that context
 * match and hands the whole subtree back to the OS preference under a key
 * nothing else reads, with no test failing. `theme={{ enabled: false }}` removes
 * the nested provider outright; this asserts nobody drops it.
 *
 * Reads the live source by regex rather than rendering the layout: it is an
 * async server component behind next-intl, and the assertion is about one
 * declaration, not about rendered output. Same shape as the sibling drift tests.
 */
describe("marketing theme authority", () => {
	it("disables the documentation provider's own theme provider", () => {
		const layout = readFileSync(
			resolve(__dirname, "../app/(marketing)/[locale]/layout.tsx"),
			"utf8",
		);

		expect(layout).toMatch(/theme=\{\{\s*enabled:\s*false\s*,?\s*\}\}/);
	});
});
