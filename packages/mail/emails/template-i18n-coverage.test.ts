/**
 * Guard: no mail template may ship an unresolved i18n key as visible copy.
 *
 * `use-intl` does not throw on a missing key — `defaultGetMessageFallback`
 * returns the joined key path and `defaultOnError` only `console.error`s. So a
 * template asking for a key nobody added renders the literal string
 * "mail.aiUsageLimitReached.subjectWithName" as the subject line and sends it.
 * That is not hypothetical: it reached production users on 2026-07-02, because
 * the two AI-usage templates were written to one key convention and `en.json`
 * to another, and nothing in CI ever rendered them.
 *
 * The same fallback catches ICU argument errors, which is the subtler half of
 * that bug — a key that *exists* but interpolates `{limitName}` while the
 * template calls it with no values degrades to the same key-path string.
 *
 * Type-checking cannot cover this: `BaseMailProps.translations` is `any`, and
 * the repo's `IntlMessages` global augmentation is the next-intl v3 pattern
 * while the runtime is v4 (which wants `declare module "use-intl"` /
 * `AppConfig`). Both nets are dead, so rendering is the only real check.
 *
 * Scope — deliberately i18n only. The same 2026-07-02 email also shipped a
 * relative `href`, and it is tempting to assert here that every rendered href
 * is absolute. Don't: these tests drive templates through their `PreviewProps`,
 * and 11 of the 16 use `url: "#"` as a preview placeholder, so such an
 * assertion grades fixtures rather than code. It could not catch the real bug
 * anyway — the href is built at the *call site*, and this template's own
 * PreviewProps hardcode an absolute URL, which is exactly what let the broken
 * link look fine in the react-email preview. That invariant is guarded where it
 * is actually decided, in notification-service's own tests.
 */

import { describe, expect, it } from "vitest";
import { mailTemplates } from "../emails";
import { getTemplate, type TemplateId } from "../src/util/templates";
import { defaultLocale } from "../src/util/translations";

/**
 * Matches a `mail.<template>.<key>` path that leaked into rendered output.
 *
 * The `\b` is load-bearing: without it this also matches ordinary copy like
 * `jane@webmail.co.example` or `https://email.fabric.pro/x`, so the first fixture
 * with a two-label domain or a sending subdomain would fail the guard on
 * correct code. A real leak is always preceded by `>` or whitespace, both
 * non-word characters, so the boundary costs no coverage.
 */
const RAW_I18N_KEY = /\bmail\.[A-Za-z0-9_]+\.[A-Za-z0-9_.]+/;

async function renderWith(templateId: TemplateId, context: object) {
	return getTemplate({
		templateId,
		context: context as never,
		locale: defaultLocale,
	});
}

function expectNoRawKeys(
	{ subject, html, text }: { subject: string; html: string; text: string },
	label: string,
) {
	expect(subject, `${label}: subject leaked an i18n key`).not.toMatch(
		RAW_I18N_KEY,
	);
	expect(html, `${label}: body leaked an i18n key`).not.toMatch(RAW_I18N_KEY);
	expect(text, `${label}: plaintext leaked an i18n key`).not.toMatch(
		RAW_I18N_KEY,
	);
}

const templateIds = Object.keys(mailTemplates) as TemplateId[];

describe("every mail template resolves its i18n keys", () => {
	it("covers the whole registry", () => {
		// Fails loudly if a template ships without PreviewProps rather than
		// letting the suite below silently skip it.
		expect(templateIds.length).toBeGreaterThan(0);
		for (const id of templateIds) {
			expect(
				(mailTemplates[id] as { PreviewProps?: unknown }).PreviewProps,
				`${id} must expose PreviewProps so it can be render-tested`,
			).toBeDefined();
		}
	});

	for (const templateId of templateIds) {
		it(`${templateId} renders no raw key`, async () => {
			const previewProps = (
				mailTemplates[templateId] as { PreviewProps: object }
			).PreviewProps;

			expectNoRawKeys(
				await renderWith(templateId, previewProps),
				templateId,
			);
		});
	}
});

/**
 * The registry sweep above is necessary but NOT sufficient for the AI-usage
 * templates, and this is the whole point of this block: their `PreviewProps`
 * pin `dimension: "SPEND_USD"`, `enforcement: "HARD"`, `window: "MONTHLY"` and
 * a non-null `limitName`. The email that actually reached users was TOKENS +
 * SOFT — so a sweep over PreviewProps alone renders green while `bodySoft` and
 * `usageLineTokens`, the exact keys in the bug report's screenshot, stay
 * broken. Every branch has to be walked.
 */
describe("AI usage templates resolve every branch", () => {
	const aiTemplates = [
		"aiUsageLimitReached",
		"aiUsageLimitWarning",
	] as const satisfies readonly TemplateId[];
	const dimensions = ["TOKENS", "SPEND_USD"] as const;
	const windows = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as const;
	const enforcements = ["HARD", "SOFT"] as const;
	// `null` exercises the no-name branch of `resolveSubject`, where a subject
	// string carrying {limitName} would blow up with nothing to interpolate.
	const limitNames = ["Production OpenAI cap", null];

	for (const templateId of aiTemplates) {
		for (const dimension of dimensions) {
			for (const window of windows) {
				for (const enforcement of enforcements) {
					for (const limitName of limitNames) {
						const label = `${templateId} ${dimension}/${window}/${enforcement}/${limitName ? "named" : "unnamed"}`;

						it(label, async () => {
							const rendered = await renderWith(templateId, {
								limitName,
								dimension,
								window,
								enforcement,
								used:
									dimension === "SPEND_USD"
										? "$42.18"
										: "8,200",
								max:
									dimension === "SPEND_USD"
										? "$50.00"
										: "10,000",
								manageLimitsUrl:
									"https://fabric.pro/app/acme/settings/usage?limitId=lim_1",
							});

							expectNoRawKeys(rendered, label);
							// The window must read as a localized phrase, never
							// the raw enum leaking through `{window}`.
							expect(rendered.html).not.toContain(window);
						});
					}
				}
			}
		}
	}
});

it("publishingTopicsReady renders both plural branches", async () => {
	// PreviewProps only exercises the `other` branch, so the singular one needs its own case.
	//
	// ASSERT THE RENDERED TEXT, NOT THE ABSENCE OF A RAW KEY. A dropped `one` clause does NOT
	// leak `mail.publishingTopicsReady.headline`: ICU plural falls back SILENTLY to `other`, so
	// the output is "1 topics are ready to write" — grammatically wrong and perfectly
	// well-formed. `expectNoRawKeys` passes, and so does any assertion about the project name.
	// Verified against the real use-intl translator rather than assumed.
	//
	// So the only assertion that can fail here is one that reads the pluralized words.
	const singular = await renderWith("publishingTopicsReady", {
		projectName: "Example project",
		topicCount: 1,
		url: "https://example.com/app/projects/example-project-id/publishing",
	});
	expectNoRawKeys(singular, "publishingTopicsReady topicCount=1");
	expect(singular.html).toContain("1 topic is ready to write");
	expect(singular.subject).toContain("1 publishing topic ready");

	const plural = await renderWith("publishingTopicsReady", {
		projectName: "Example project",
		topicCount: 3,
		url: "https://example.com/app/projects/example-project-id/publishing",
	});
	expectNoRawKeys(plural, "publishingTopicsReady topicCount=3");
	expect(plural.html).toContain("3 topics are ready to write");
	expect(plural.subject).toContain("3 publishing topics ready");
});
