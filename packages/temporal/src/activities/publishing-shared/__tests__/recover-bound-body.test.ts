import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from "@repo/logs";
import { renderTemplate } from "@repo/utils";
import { recoverBoundBody } from "../recover-bound-body";
import { resolvedCallCount } from "./_ast-guards";

const SUBJECT = "publishing-blog-post";
const FALLBACK = "Default body about {{{topic_title}}}.";
const VARIABLES = { topic_title: "Faster incremental builds" };
const RECOVERED_BODY = "Default body about Faster incremental builds.";
const FIRST_LINE =
	"[publishing-blog-post] bound prompt did not render; using the default body";
const SECOND_LINE =
	"[publishing-blog-post] the DEFAULT body did not render either";

function renderBound(template: string, variables = VARIABLES) {
	return renderTemplate({ format: "HANDLEBARS", template, variables });
}

beforeEach(() => {
	vi.mocked(logger.error).mockClear();
});

describe("recoverBoundBody", () => {
	it("keeps a body that rendered, and logs nothing", async () => {
		const rendered = await renderBound("Write about {{{topic_title}}}.");
		const result = await recoverBoundBody({
			subject: SUBJECT,
			rendered,
			format: "HANDLEBARS",
			fallbackTemplate: FALLBACK,
			variables: VARIABLES,
		});
		expect(result).toEqual({
			body: "Write about Faster incremental builds.",
			bodyRecovered: false,
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("keeps a body whose substituted value carries a bare {{", async () => {
		// The context is user prose; a title can contain mustaches. Only `{{{`
		// or `{{#` surviving the render means the body did not render.
		const variables = { topic_title: "Use {{name}} placeholders" };
		const rendered = await renderBound(
			"Write about {{{topic_title}}}.",
			variables,
		);
		expect(rendered.error).toBeUndefined();
		expect(rendered.rendered).toBe(
			"Write about Use {{name}} placeholders.",
		);
		const result = await recoverBoundBody({
			subject: SUBJECT,
			rendered,
			format: "HANDLEBARS",
			fallbackTemplate: FALLBACK,
			variables,
		});
		expect(result.bodyRecovered).toBe(false);
		expect(logger.error).not.toHaveBeenCalled();
	});

	describe("each disjunct recovers on its own", () => {
		it("a render error whose raw text is neither template-shaped nor blank", async () => {
			const rendered = await renderBound(
				"Write about {{topic_title}}. {{/if}}",
			);
			// Precondition: ONLY the error disjunct holds for this fixture.
			expect(rendered.error).toBeTruthy();
			expect(rendered.rendered).not.toMatch(/\{\{[{#]/);
			expect(rendered.rendered).toBe(
				"Write about {{topic_title}}. {{/if}}",
			);
			const result = await recoverBoundBody({
				subject: SUBJECT,
				rendered,
				format: "HANDLEBARS",
				fallbackTemplate: FALLBACK,
				variables: VARIABLES,
			});
			expect(result).toEqual({
				body: RECOVERED_BODY,
				bodyRecovered: true,
			});
			expect(logger.error).toHaveBeenCalledTimes(1);
		});

		it("output still carrying a template construct, with no render error", async () => {
			// The template renders cleanly; the VALUE carries `{{#` through a
			// triple-stash, which is the real-world shape of this disjunct.
			const variables = {
				topic_title: "Faster incremental builds {{#loop}}",
			};
			const rendered = await renderBound(
				"Write about {{{topic_title}}}.",
				variables,
			);
			expect(rendered.error).toBeUndefined();
			expect(rendered.rendered).toMatch(/\{\{[{#]/);
			const result = await recoverBoundBody({
				subject: SUBJECT,
				rendered,
				format: "HANDLEBARS",
				fallbackTemplate: FALLBACK,
				variables,
			});
			expect(result.bodyRecovered).toBe(true);
			// The default body is not re-tested for the construct the same value
			// carries into it, and that is not reported as a second failure.
			expect(result.body).toBe(
				"Default body about Faster incremental builds {{#loop}}.",
			);
			expect(logger.error).toHaveBeenCalledTimes(1);
		});

		it("output that renders to nothing, with no render error", async () => {
			const rendered = await renderBound("{{#unknown}}text{{/unknown}}");
			expect(rendered.error).toBeUndefined();
			expect(rendered.rendered).toBe("");
			const result = await recoverBoundBody({
				subject: SUBJECT,
				rendered,
				format: "HANDLEBARS",
				fallbackTemplate: FALLBACK,
				variables: VARIABLES,
			});
			expect(result).toEqual({
				body: RECOVERED_BODY,
				bodyRecovered: true,
			});
			expect(logger.error).toHaveBeenCalledTimes(1);
		});

		it("output of only zero-width characters counts as nothing", async () => {
			// `trim()` leaves U+200B standing; the model reads it as nothing.
			const rendered = await renderBound("\u200B\u200B");
			expect(rendered.error).toBeUndefined();
			expect(rendered.rendered.trim()).toBe("\u200B\u200B");
			const result = await recoverBoundBody({
				subject: SUBJECT,
				rendered,
				format: "HANDLEBARS",
				fallbackTemplate: FALLBACK,
				variables: VARIABLES,
			});
			expect(result).toEqual({
				body: RECOVERED_BODY,
				bodyRecovered: true,
			});
		});
	});

	it("logs the first failure with the exact line and context operators grep for", async () => {
		const rendered = await renderBound("{{#unknown}}text{{/unknown}}");
		await recoverBoundBody({
			subject: SUBJECT,
			rendered,
			format: "HANDLEBARS",
			fallbackTemplate: FALLBACK,
			variables: VARIABLES,
		});
		expect(vi.mocked(logger.error).mock.calls).toEqual([
			[
				FIRST_LINE,
				{ format: "HANDLEBARS", error: undefined, renderedBlank: true },
			],
		]);
		expect(
			Object.keys(vi.mocked(logger.error).mock.calls[0]?.[1] ?? {}),
		).toEqual(["format", "error", "renderedBlank"]);
	});

	it("logs the caller's format but renders the default body as Handlebars", async () => {
		// Synthetic, and failing TWO checks (error and blank) on purpose, so
		// that deleting any single check does not redden this case too.
		const rendered = { rendered: "", error: "Liquid error: synthetic" };
		const result = await recoverBoundBody({
			subject: SUBJECT,
			rendered,
			format: "LIQUID",
			fallbackTemplate: FALLBACK,
			variables: VARIABLES,
		});
		expect(logger.error).toHaveBeenCalledWith(FIRST_LINE, {
			format: "LIQUID",
			error: "Liquid error: synthetic",
			renderedBlank: true,
		});
		expect(result).toEqual({ body: RECOVERED_BODY, bodyRecovered: true });
	});

	describe("when the default body does not render either", () => {
		it("logs a second error naming the default body and still reports a recovery", async () => {
			// Synthetic and failing two checks, for the same reason as above.
			const rendered = {
				rendered: "",
				error: "Handlebars error: synthetic",
			};
			const brokenFallback = "Default body. {{/if}}";
			const result = await recoverBoundBody({
				subject: SUBJECT,
				rendered,
				format: "HANDLEBARS",
				fallbackTemplate: brokenFallback,
				variables: VARIABLES,
			});
			// `renderHandlebars` hands back the raw template on a compile error.
			expect(result).toEqual({
				body: brokenFallback,
				bodyRecovered: true,
			});
			expect(logger.error).toHaveBeenCalledTimes(2);
			expect(logger.error).toHaveBeenNthCalledWith(2, SECOND_LINE, {
				error: expect.stringContaining("Handlebars error"),
			});
		});
	});
});

/**
 * Modules whose `renderTemplate` / `recoverBoundBody` export counts as THE
 * shared one, not a same-named import or local of a composer's own. The
 * family tripwire below exists specifically to tell those apart.
 */
const RENDERER_MODULES = ["@repo/utils", "@repo/utils/template-renderer"];
const HELPER_MODULES = ["../publishing-shared/recover-bound-body"];

describe("resolvedCallCount counts calls, never text", () => {
	it("follows an alias, a rebinding and a namespace, and ignores prose and strings", () => {
		const dir = mkdtempSync(join(tmpdir(), "resolved-call-count-"));
		try {
			const fixture = join(dir, "fixture.ts");
			writeFileSync(
				fixture,
				[
					'import type { renderTemplate as typeOnly } from "@repo/utils";',
					'import { renderTemplate as render } from "@repo/utils";',
					'import * as utils from "@repo/utils";',
					"// renderTemplate( and recoverBoundBody( in a comment are not calls",
					'const prose = "renderTemplate(";',
					"const again = render;",
					"export async function compose() {",
					"\tawait render({});",
					"\tawait again({});",
					"\tawait utils.renderTemplate({});",
					"\treturn prose;",
					"}",
				].join("\n"),
			);
			expect(
				resolvedCallCount(fixture, "renderTemplate", ["@repo/utils"]),
			).toBe(3);
			expect(
				resolvedCallCount(fixture, "recoverBoundBody", ["@repo/utils"]),
			).toBe(0);
			// Same calls, but the module list names a module none of these
			// imports specify — the export name alone is not enough to match.
			expect(
				resolvedCallCount(fixture, "renderTemplate", ["./elsewhere"]),
			).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not count a same-named local function, or the name from another module or namespace", () => {
		const dir = mkdtempSync(join(tmpdir(), "resolved-call-count-"));
		try {
			const fixture = join(dir, "fixture.ts");
			writeFileSync(
				fixture,
				[
					'import { recoverBoundBody as fromElsewhere } from "./my-own-copy";',
					'import * as other from "./my-own-copy";',
					"async function recoverBoundBody() {",
					"\treturn null;",
					"}",
					"export async function compose() {",
					"\tawait recoverBoundBody();",
					"\tawait fromElsewhere();",
					"\tawait other.recoverBoundBody();",
					"}",
				].join("\n"),
			);
			expect(
				resolvedCallCount(fixture, "recoverBoundBody", HELPER_MODULES),
			).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts the helper aliased or through a namespace of its own module", () => {
		const dir = mkdtempSync(join(tmpdir(), "resolved-call-count-"));
		try {
			const fixture = join(dir, "fixture.ts");
			writeFileSync(
				fixture,
				[
					'import { recoverBoundBody as recover } from "../publishing-shared/recover-bound-body";',
					'import * as shared from "../publishing-shared/recover-bound-body";',
					"export async function compose() {",
					"\tawait recover();",
					"\tawait shared.recoverBoundBody();",
					"}",
				].join("\n"),
			);
			expect(
				resolvedCallCount(fixture, "recoverBoundBody", HELPER_MODULES),
			).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("every publishing composer routes its bound body through recoverBoundBody", () => {
	// Nine composers each carried a copy of this block, none checking the
	// default body's own render; a tenth copied composer would carry it again.
	// AST call counts resolved by MODULE (see `resolvedCallCount` in
	// `_ast-guards.ts`), not source text and not by export name alone: a
	// comment naming either call must not satisfy or fail this (see
	// `firstCallPosition`'s docblock in `_ast-guards.ts`), and neither may a
	// same-named export of some other module, nor a same-named local function
	// in a file that does not import the helper.
	//
	// NOT COVERED: a composer outside a `publishing-*` folder; a composer that
	// renders through a wrapper it imports, or through a renderer that is not
	// `renderTemplate` from `RENDERER_MODULES` — such a file is not discovered
	// at all, so it never reaches either assertion below; and a composer that
	// calls the helper but discards its result — this counts CALLS, not
	// whether the returned `body`/`bodyRecovered` are then used; and a
	// composer that keeps the helper's import but calls a same-named function
	// nested inside its own scope, which shadows the import (no lexical
	// scoping — see `resolvedCallCount`).
	const activitiesDir = join(__dirname, "..", "..");
	const KNOWN = [
		"publishing-blog-post/build-blog-post-prompt.ts",
		"publishing-case-study/build-case-study-prompt.ts",
		"publishing-linkedin-post/build-linkedin-post-prompt.ts",
		"publishing-newsletter-blurb/build-newsletter-blurb-prompt.ts",
		"publishing-planning/build-planning-analysis-prompt.ts",
		"publishing-short-post/build-short-post-prompt.ts",
		"publishing-stakeholder-email/build-stakeholder-email-prompt.ts",
		"publishing-webinar-script/build-webinar-script-prompt.ts",
		"publishing-suggestion/prompt.ts",
	];

	/** Production sources under `publishing-*` (not `publishing-shared`, not `__tests__`) that call `renderTemplate` from `RENDERER_MODULES`. */
	function renderingSources(): string[] {
		const found: string[] = [];
		const walk = (rel: string): void => {
			for (const entry of readdirSync(join(activitiesDir, rel), {
				withFileTypes: true,
			})) {
				const child = `${rel}/${entry.name}`;
				if (entry.isDirectory()) {
					if (entry.name !== "__tests__") {
						walk(child);
					}
				} else if (
					entry.name.endsWith(".ts") &&
					resolvedCallCount(
						join(activitiesDir, child),
						"renderTemplate",
						RENDERER_MODULES,
					) > 0
				) {
					found.push(child);
				}
			}
		};
		for (const dir of readdirSync(activitiesDir)) {
			if (dir.startsWith("publishing-") && dir !== "publishing-shared") {
				walk(dir);
			}
		}
		return found.sort();
	}

	it("discovers at least the nine known composers", () => {
		expect(renderingSources()).toEqual(expect.arrayContaining(KNOWN));
	});

	it.each(KNOWN)(
		"%s renders once and recovers through the shared helper",
		(rel) => {
			const file = join(activitiesDir, rel);
			expect(
				resolvedCallCount(file, "renderTemplate", RENDERER_MODULES),
			).toBe(1);
			expect(
				resolvedCallCount(file, "recoverBoundBody", HELPER_MODULES),
			).toBe(1);
		},
	);

	it("every publishing activity that renders a template routes through the helper", () => {
		for (const rel of renderingSources()) {
			const file = join(activitiesDir, rel);
			expect({
				rel,
				renders: resolvedCallCount(
					file,
					"renderTemplate",
					RENDERER_MODULES,
				),
				recovers: resolvedCallCount(
					file,
					"recoverBoundBody",
					HELPER_MODULES,
				),
			}).toEqual({
				rel,
				renders: 1,
				recovers: 1,
			});
		}
	});
});
