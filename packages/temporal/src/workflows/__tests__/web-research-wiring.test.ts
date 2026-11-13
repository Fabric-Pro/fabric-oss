/**
 * Web research is a per-action consent: a person ticks it when they create or
 * regenerate one document, and only that `true` may reach the AI token
 * (`webResearch`) and the generation run (`allowWebResearch`).
 *
 * The paths pinned here start generation, or call a model, with nobody at the
 * keyboard to consent: batch generation, project setup, project context
 * processing, the scheduled document refresh and `update-with-context`. None of
 * them carries the permission today, and none may start to. Nothing here can be
 * caught by a type error: the workflows are started by string name with untyped
 * args, and the field is optional at every layer. A behavioral test of each
 * path would only prove what that test happened to pass in. So these are
 * source-level guards, in the style of the "outside callers" block of
 * `supplied-context-wiring.test.ts`: read the file, drop its comments, and
 * refuse any mention of the field.
 *
 * The guards cannot pass vacuously: every guarded file must exist and keep
 * code after its comments are dropped, and the two generation workflows that
 * do carry the permission must still name it after the same treatment.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `packages/` — the API package sits beside this one. */
const PACKAGES = join(__dirname, "../../../..");
const WORKFLOWS = join(__dirname, "..");
const REFRESH_ACTIVITIES = join(__dirname, "../../activities/document-refresh");
const UPDATE_WITH_CONTEXT = join(
	PACKAGES,
	"api/modules/projects/procedures/documents/update-with-context.ts",
);

/**
 * Any spelling of the field: `allowWebResearch` on run inputs, `webResearch`
 * on token options, and any identifier built on either.
 */
const NAMES_THE_FIELD = /webresearch/i;

/** The two ways a run gets a token an agent would honor. */
const ISSUES_A_TOKEN = /\b(?:issueAIToken|issueGenerationToken)\b/;

/**
 * Line and block comments dropped, string and template literals kept. One
 * left-to-right pass, so a `//` inside a URL string, or a `/*` inside a line
 * comment, cannot swallow the code after it.
 */
const COMMENT_OR_STRING =
	/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function stripComments(source: string): string {
	return source.replace(
		COMMENT_OR_STRING,
		(_match, literal: string | undefined) => literal ?? "",
	);
}

/** The file's code without its comments; fails if nothing would be guarded. */
function codeOf(path: string): string {
	const code = stripComments(readFileSync(path, "utf8"));
	expect(code.trim().length, `${path} has no code to guard`).toBeGreaterThan(
		0,
	);
	return code;
}

describe("the comment stripper the guards rely on", () => {
	it("drops mentions in comments and keeps them in code", () => {
		const code = stripComments(
			[
				"// allowWebResearch is not wired here",
				"/* webResearch: true */",
				'const url = "https://example.com"; const allowWebResearch = true;',
				"// see docs/*.md",
				"const webResearch = false; /* trailing */",
			].join("\n"),
		);

		expect(code).not.toContain("is not wired here");
		expect(code).not.toContain("webResearch: true");
		expect(code).toContain('"https://example.com"');
		expect(code).toContain("const allowWebResearch = true;");
		expect(code).toContain("const webResearch = false;");
	});
});

describe("the generation workflows still name the permission (positive control)", () => {
	it.each(["project-document-generation.ts", "document-generation-child.ts"])(
		"%s names both spellings in code",
		(file) => {
			const code = codeOf(join(WORKFLOWS, file));
			expect(code).toMatch(/\ballowWebResearch\b/);
			expect(code).toMatch(/\bwebResearch\b/);
		},
	);
});

describe("generation starters with no consent never carry the permission", () => {
	// The workflows, not the same-named files under `src/activities/`. Some
	// of them issue their own generation token; that token must stay
	// unauthorized, which the field check covers.
	it.each([
		"batch-document-generation.ts",
		"existing-project-setup.ts",
		"code-based-project-setup.ts",
		"project-context-processing.ts",
	])("workflows/%s never names the field", (file) => {
		expect(codeOf(join(WORKFLOWS, file))).not.toMatch(NAMES_THE_FIELD);
	});
});

describe("update-with-context and the scheduled refresh never research", () => {
	const refreshSources = (
		readdirSync(REFRESH_ACTIVITIES, { recursive: true }) as string[]
	)
		.filter(
			(file) =>
				file.endsWith(".ts") &&
				!file.endsWith(".test.ts") &&
				!file.split(/[\\/]/).includes("__tests__"),
		)
		.sort();

	it("finds the refresh activities it guards", () => {
		expect(refreshSources).toEqual(
			expect.arrayContaining([
				"dispatch-document-refresh.ts",
				"run-document-refresh.ts",
			]),
		);
	});

	it("update-with-context neither names the field nor issues a token", () => {
		const code = codeOf(UPDATE_WITH_CONTEXT);
		expect(code).not.toMatch(NAMES_THE_FIELD);
		expect(code).not.toMatch(ISSUES_A_TOKEN);
	});

	it.each(refreshSources)(
		"document-refresh/%s neither names the field nor issues a token",
		(file) => {
			const code = codeOf(join(REFRESH_ACTIVITIES, file));
			expect(code).not.toMatch(NAMES_THE_FIELD);
			expect(code).not.toMatch(ISSUES_A_TOKEN);
		},
	);

	// The model call the refresh actually makes, and the workflows that
	// schedule it: the same rule holds one level out.
	it.each([
		join(__dirname, "../../lib/update-with-context-core.ts"),
		join(WORKFLOWS, "document-refresh.ts"),
		join(WORKFLOWS, "document-refresh-dispatcher.ts"),
	])("%s neither names the field nor issues a token", (path) => {
		const code = codeOf(path);
		expect(code.trim().length).toBeGreaterThan(0);
		expect(code).not.toMatch(NAMES_THE_FIELD);
		expect(code).not.toMatch(ISSUES_A_TOKEN);
	});
});
