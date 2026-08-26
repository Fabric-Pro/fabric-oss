/**
 * i18n parity for the Job Hub's job-kind labels.
 *
 * WHY THIS EXISTS. `PUBLISHING_TOPIC_GENERATION` was added to the enum and to
 * `en`, and `de` was missed — so a German-locale reader got a raw enum key in
 * the panel's most prominent line. Nothing failed, because the only thing
 * pinning these labels was that someone had written them.
 *
 * The enum is read from `schema.prisma` rather than imported from
 * `@repo/database`, deliberately. Importing the generated client would drag
 * Prisma into a jsdom suite for the sake of eight string constants, and a
 * hand-copied list here would be a fourth place to forget — which is the defect
 * itself, one layer up. Parsing the schema means a kind cannot exist without
 * this test seeing it.
 *
 * Sibling of `i18n-audit-actions.test.ts`, which does the same job for the
 * audit-log taxonomy.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import de from "../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../packages/i18n/translations/en.json";

const SCHEMA_PATH = resolve(
	__dirname,
	"../../../../../../packages/database/prisma/schema.prisma",
);

/**
 * The enum's members, comments and blank lines removed.
 *
 * Anchored on the closing brace rather than on a fixed line count: the enum
 * carries doc comments today and will carry more.
 */
function backgroundJobKinds(): string[] {
	const schema = readFileSync(SCHEMA_PATH, "utf8");
	const block = schema.match(/enum BackgroundJobKind \{([^}]*)\}/);
	if (!block) {
		throw new Error(
			"enum BackgroundJobKind not found in schema.prisma — this test's premise is gone, not its assertion",
		);
	}
	return block[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"));
}

function kindLabels(source: typeof en | typeof de): Record<string, string> {
	const kinds = (
		source as unknown as {
			app?: { jobs?: { kinds?: Record<string, string> } };
		}
	).app?.jobs?.kinds;
	if (!kinds) {
		throw new Error("app.jobs.kinds is missing from a translation file");
	}
	return kinds;
}

describe("Job Hub job-kind labels", () => {
	// Guards the parser, not the translations. A regex that silently matched
	// nothing would make every assertion below vacuously true, and the suite
	// would stay green while the labels rotted — the exact shape of failure this
	// file was written to end.
	it("reads a non-trivial set of kinds out of the schema", () => {
		const kinds = backgroundJobKinds();
		expect(kinds.length).toBeGreaterThan(1);
		expect(kinds).toContain("PUBLISHING_TOPIC_GENERATION");
		expect(kinds.every((k) => /^[A-Z][A-Z0-9_]*$/.test(k))).toBe(true);
	});

	it.each(["en", "de"])("labels every job kind in %s", (locale) => {
		const labels = kindLabels(locale === "en" ? en : de);
		for (const kind of backgroundJobKinds()) {
			expect(
				labels[kind],
				`${locale} is missing a label for ${kind}`,
			).toBeTypeOf("string");
			expect(labels[kind]?.trim().length).toBeGreaterThan(0);
		}
	});

	it("carries no label for a kind the enum no longer has", () => {
		// The reverse direction. A removed kind leaves a label nothing renders,
		// and the next reader cannot tell it from one that is merely unused
		// today — so the two lists are pinned as equal sets, not as one subset.
		const kinds = new Set(backgroundJobKinds());
		for (const locale of ["en", "de"] as const) {
			for (const key of Object.keys(
				kindLabels(locale === "en" ? en : de),
			)) {
				expect(
					kinds.has(key),
					`${locale} labels unknown kind ${key}`,
				).toBe(true);
			}
		}
	});
});
