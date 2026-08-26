import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";

/**
 * Locale parity for the QA surface.
 *
 * User-facing strings in `apps/web/.../test-cases/**` come from the project QA
 * and feature QA namespaces. A namespace typo renders as a raw key path at
 * runtime even when the intended key exists elsewhere, so every literal
 * namespace used by these components must resolve in the source locale.
 *
 * The contextual-tooltip copy is the one deliberate exception: destructive
 * tooltip text lives in the top-level `tooltips.testCases` bucket, which is
 * English-only by design (see `frontend/tooltips.md`).
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Structural shape of an object: keys only, values collapsed to `true`. */
function keyTree(node: Json): unknown {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return true;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(node).sort()) {
		out[key] = keyTree((node as Record<string, Json>)[key]);
	}
	return out;
}

/** Flatten a nested string map to `path -> value`, skipping non-strings. */
function flattenStrings(
	node: Json,
	prefix: string,
	out: Record<string, string>,
): void {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return;
	}
	for (const [key, child] of Object.entries(node)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof child === "string") {
			out[path] = child;
		} else {
			flattenStrings(child as Json, path, out);
		}
	}
}

function findTsxFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...findTsxFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".tsx")) {
			files.push(path);
		}
	}
	return files;
}

function resolveNamespace(root: Json, namespace: string): Json | undefined {
	let node: Json | undefined = root;
	for (const segment of namespace.split(".")) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) {
			return undefined;
		}
		node = (node as Record<string, Json>)[segment];
	}
	return node;
}

const enTestCases = (en as Record<string, Json>).projects as Record<
	string,
	Json
>;
const deTestCases = (de as Record<string, Json>).projects as Record<
	string,
	Json
>;

describe("projects.testCases i18n parity", () => {
	it("resolves every QA component translation namespace in the source locale", () => {
		const componentRoot = resolve(
			process.cwd(),
			"modules/saas/projects/components/test-cases",
		);
		const offenders = findTsxFiles(componentRoot).flatMap((file) => {
			const source = readFileSync(file, "utf8");
			const namespaces = [
				...source.matchAll(/useTranslations\(\s*["']([^"']+)["']/g),
			].map((match) => match[1]);

			return namespaces.flatMap((namespace) => {
				return resolveNamespace(en as Json, namespace) === undefined
					? [`${file.slice(componentRoot.length + 1)}: ${namespace}`]
					: [];
			});
		});

		expect(offenders).toEqual([]);
	});

	it("en and de expose identical key trees", () => {
		expect(keyTree(enTestCases.testCases)).toEqual(
			keyTree(deTestCases.testCases),
		);
	});

	it("every en key resolves to a non-empty string", () => {
		const flat: Record<string, string> = {};
		flattenStrings(enTestCases.testCases, "projects.testCases", flat);
		for (const [path, value] of Object.entries(flat)) {
			expect(value.trim().length, path).toBeGreaterThan(0);
		}
	});

	it("every de key resolves to a non-empty string", () => {
		const flat: Record<string, string> = {};
		flattenStrings(deTestCases.testCases, "projects.testCases", flat);
		for (const [path, value] of Object.entries(flat)) {
			expect(value.trim().length, path).toBeGreaterThan(0);
		}
	});

	it("carries the plural + interpolation keys the components depend on", () => {
		const tc = enTestCases.testCases as Record<string, Json>;
		// A representative sampling that would break the UI if renamed away.
		expect(tc.caseCount).toContain("plural");
		expect(tc.stepCount).toContain("plural");
		expect((tc.confirm as Record<string, string>).deleteMessage).toContain(
			"{identifier}",
		);
		expect((tc.filters as Record<string, string>).showingOfTotal).toContain(
			"{total}",
		);
	});

	it("offers every segment the tab renders", () => {
		// `runs` joined Cases/Plans/Features when the QA pipeline-results surface
		// was brought to this tab (it also renders inside the feature editor's QA
		// tab, from the same component); `reviews` followed with the pull requests
		// Fabric has read. A segment without a label renders its raw
		// key in the tab bar, so this list must track `SEGMENTS`.
		const segments = (enTestCases.testCases as Record<string, Json>)
			.segments as Record<string, string>;
		expect(Object.keys(segments).sort()).toEqual([
			"cases",
			"features",
			"plans",
			"questions",
			"reviews",
			"runs",
		]);
	});

	it("explains every segment it renders a tab for", () => {
		// `SegmentAbout` builds both lookups as template keys (`${segment}.title`),
		// so a segment with no About copy renders a raw key path instead of
		// failing — invisible to a type-check and to the namespace guard above.
		// Binding the two buckets together makes a new segment fail HERE, in both
		// locales, until someone writes the copy.
		const tc = enTestCases.testCases as Record<string, Json>;
		const about = tc.about as Record<string, Json>;
		const segments = Object.keys(
			tc.segments as Record<string, string>,
		).sort();

		expect(
			Object.keys(about)
				.filter((key) => key !== "trigger")
				.sort(),
		).toEqual(segments);
		for (const segment of segments) {
			const copy = about[segment] as Record<string, string>;
			expect(
				copy.title?.trim().length,
				`en about.${segment}.title`,
			).toBeGreaterThan(0);
			expect(
				copy.body?.trim().length,
				`en about.${segment}.body`,
			).toBeGreaterThan(0);
		}
		// The trigger is the screen-reader label and interpolates the segment title.
		expect(about.trigger).toContain("{segment}");
	});

	it("carries the interpolations the coverage + run surfaces depend on", () => {
		const tc = enTestCases.testCases as Record<string, Json>;
		const features = tc.features as Record<string, string>;
		const run = tc.run as Record<string, string>;
		const planDetail = tc.planDetail as Record<string, string>;
		const filters = tc.filters as Record<string, string>;

		expect(features.featureCount).toContain("plural");
		// The AC figure is a TALLY of referenced criteria, never an "X of N"
		// ratio — N is not computable from free-text acceptance criteria.
		expect(features.acRefCount).toContain("plural");
		expect(features.viewCasesAria).toContain("{identifier}");

		expect(run.title).toContain("{plan}");
		expect(run.progress).toContain("{current}");
		expect(run.progress).toContain("{total}");
		expect(run.progressAria).toContain("{marked}");
		expect(run.summary).toContain("{marked}");

		expect(planDetail.openCaseAria).toContain("{identifier}");
		// Both toolbar chips name what they remove — they are icon-only controls.
		expect(filters.planRemoveAria).toContain("{identifier}");
		expect(filters.featureRemoveAria).toContain("{identifier}");
	});
});

describe("tooltips.testCases (English-only source locale)", () => {
	it("exposes the destructive delete bucket in en with a Warning-prefixed warning", () => {
		const bucket = (en as Record<string, Json>).tooltips as Record<
			string,
			Json
		>;
		const testCases = bucket.testCases as Record<string, Json>;
		const del = testCases.delete as { label: string; warning: string };
		expect(typeof del.label).toBe("string");
		expect(del.label.length).toBeGreaterThan(0);
		expect(del.warning.startsWith("Warning: ")).toBe(true);
	});

	it("is intentionally absent from de", () => {
		const bucket = (de as Record<string, Json>).tooltips as
			| Record<string, Json>
			| undefined;
		expect(bucket?.testCases).toBeUndefined();
	});
});
