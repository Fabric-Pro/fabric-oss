/**
 * Living Documents auto-refresh — gate-await regression guard.
 *
 * THE BUG THIS PREVENTS: a call site that references the auto-refresh feature
 * gate WITHOUT awaiting it. The gate became async in Fizzy #2210 so it could
 * read the registry's override row, and an un-awaited async call returns a
 * Promise — which is ALWAYS truthy and never throws. So:
 *
 *   `if (!isFeatureEnabled("LIVING_DOCS_REFRESH")) return { due: [] };`
 *
 * silently opens the gate forever, and
 *
 *   `assertLivingDocsRefreshEnabled();`
 *
 * silently stops rejecting — while both still read exactly like a gate. The
 * types catch some of this and nothing catches the rest: a bare statement call
 * to an async function is legal TypeScript, and it is precisely the shape the
 * four oRPC procedures use.
 *
 * What makes this worth a guard rather than a review note is the sixth call
 * site. `run-document-refresh.ts` re-reads the flag IMMEDIATELY BEFORE
 * committing an unattended AI rewrite of a customer's specification — it is the
 * last thing standing between an admin's kill switch and an in-flight write
 * (ADR-009 consequence 2). A missed `await` there does not degrade the feature;
 * it removes the switch.
 *
 * THE RULE: every reference to `assertLivingDocsRefreshEnabled(` or to
 * `isFeatureEnabled("LIVING_DOCS_REFRESH")` in `packages/api/modules` or
 * `packages/temporal/src` is either directly awaited, or a member of an
 * `await Promise.all([...])`.
 *
 * If this fails on your new call site, add the `await` — do not relax the
 * pattern. The gate is a gate only when it is awaited.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

/**
 * Both server surfaces that gate on the flag: the oRPC procedures and the
 * Temporal sweep/refresh activities. The client is deliberately absent — after
 * #2210 it has no reader of its own, which is the defect that ticket fixed.
 */
// Wider than the two packages that hold today's six call sites, deliberately.
// A guard that scans only where the gates currently live proves nothing about
// where the next one lands — and `isFeatureEnabled` is already called from
// `packages/rag` and `apps/web` for other flags, so "gates live in api/modules
// and temporal/src" is a convention this repo does not actually follow.
const SCAN_ROOTS = [
	resolve(repoRoot, "packages/api"),
	resolve(repoRoot, "packages/temporal/src"),
	resolve(repoRoot, "packages/database"),
	resolve(repoRoot, "packages/rag"),
	resolve(repoRoot, "packages/mcp"),
	resolve(repoRoot, "apps/web"),
];

const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"coverage",
	"generated",
	"__tests__",
]);

/**
 * Every reference to the gate that is a CALL. The identifiers alone would also
 * match the import lines and the function's own declaration; requiring the open
 * paren (and, for the registry read, this flag's key) narrows it to invocations
 * of this gate specifically — `isFeatureEnabled` serves twenty other flags.
 */
const GATE_CALL_RE =
	/assertLivingDocsRefreshEnabled\s*\(|isFeatureEnabled\s*\(\s*["']LIVING_DOCS_REFRESH(?:_SWEEP)?["']/g;

/** The gate's own definition — `export async function assert…(` — is not a call. */
const DECLARATION_BEFORE_RE = /\bfunction\s+$/;

/** Directly awaited: `await assert…()`, `!(await isFeatureEnabled(…))`. */
const DIRECT_AWAIT_RE = /\bawait\s*$/;

/**
 * The other legal shape — a member of an awaited `Promise.all([...])`, which is
 * how the pre-write re-read batches the flag with the settings row.
 */
const AWAITED_PROMISE_COMBINATOR_RE =
	/\bawait\s+Promise\.(?:all|allSettled)\s*\(\s*\[/g;

function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out; // root may not exist in some checkouts
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) {
				continue;
			}
			out.push(...walkTsFiles(resolve(root, entry.name)));
			continue;
		}
		// `.tsx` too: a server component or a route handler under apps/web can
		// call the gate just as easily as a `.ts` module, and scanning only `.ts`
		// would leave that whole surface invisible to this guard.
		if (
			!entry.isFile() ||
			!(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		) {
			continue;
		}
		if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) {
			continue;
		}
		out.push(resolve(root, entry.name));
	}
	return out;
}

/**
 * Blank out comments so a doc-comment that NAMES the gate (this file's rule is
 * quoted in several of them) is not scanned as a call site. Replaced with
 * spaces rather than deleted so line/offset arithmetic stays honest.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

/**
 * Is this reference inside an `await Promise.all([...])` that has not closed
 * yet? Looks back for the nearest awaited combinator and confirms its array
 * literal is still open at this point.
 */
function insideAwaitedCombinator(before: string): boolean {
	let openAt = -1;
	AWAITED_PROMISE_COMBINATOR_RE.lastIndex = 0;
	let m = AWAITED_PROMISE_COMBINATOR_RE.exec(before);
	while (m !== null) {
		openAt = m.index + m[0].length;
		m = AWAITED_PROMISE_COMBINATOR_RE.exec(before);
	}
	if (openAt === -1) {
		return false;
	}
	// `])` closes the combinator; anything after it is outside the array.
	return !/\]\s*\)/.test(before.slice(openAt));
}

interface Reference {
	file: string;
	line: number;
	awaited: boolean;
	snippet: string;
}

function collectReferences(): Reference[] {
	const refs: Reference[] = [];
	for (const root of SCAN_ROOTS) {
		for (const absFile of walkTsFiles(root)) {
			const raw = readFileSync(absFile, "utf-8");
			// Cheap prefilter. BOTH spellings, because the four oRPC procedures
			// call the wrapper and never name the registry key.
			if (
				!raw.includes("LIVING_DOCS_REFRESH") &&
				!raw.includes("assertLivingDocsRefreshEnabled")
			) {
				continue;
			}
			const source = stripComments(raw);
			const file = relative(repoRoot, absFile).split(sep).join("/");

			GATE_CALL_RE.lastIndex = 0;
			for (const match of source.matchAll(GATE_CALL_RE)) {
				const index = match.index;
				const before = source.slice(0, index);
				const previous = before.slice(-400);
				if (DECLARATION_BEFORE_RE.test(previous)) {
					continue; // the gate's own declaration, not a call
				}
				refs.push({
					file,
					line: lineOf(source, index),
					awaited:
						DIRECT_AWAIT_RE.test(previous) ||
						insideAwaitedCombinator(before),
					snippet: source
						.slice(Math.max(0, index - 40), index + 60)
						.replace(/\s+/g, " ")
						.trim(),
				});
			}
		}
	}
	return refs;
}

describe("Living Docs auto-refresh gate — await guard", () => {
	it("every server-side reference to the gate is awaited", () => {
		const offenders = collectReferences().filter((r) => !r.awaited);

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} reference(s) to the Living Docs auto-refresh gate are not awaited. ` +
					"An un-awaited async gate returns a Promise, which is always truthy — the gate " +
					"reads like a gate and lets everything through:\n\n" +
					offenders
						.map((o) => `  ${o.file}:${o.line}  …${o.snippet}…`)
						.join("\n") +
					"\n\nFix: `await assertLivingDocsRefreshEnabled()` / " +
					'`await isFeatureEnabled("LIVING_DOCS_REFRESH")`, or place the call inside an ' +
					"`await Promise.all([...])`.",
			);
		}

		expect(offenders.length).toBe(0);
	});

	it("still finds the call sites it exists to protect", () => {
		// Without this, a rename would make the guard above pass by scanning
		// nothing — the classic way a source-scanning test goes quietly dead.
		const files = new Set(collectReferences().map((r) => r.file));

		for (const expected of [
			"packages/api/modules/projects/lib/living-docs-refresh-feature.ts",
			"packages/api/modules/projects/procedures/documents/set-auto-refresh.ts",
			"packages/api/modules/projects/procedures/documents/get-auto-refresh.ts",
			"packages/api/modules/projects/procedures/documents/apply-auto-refresh-proposal.ts",
			"packages/api/modules/projects/procedures/documents/discard-auto-refresh-proposal.ts",
			"packages/temporal/src/activities/document-refresh/find-due-documents.ts",
			// The pre-write kill switch. If this one ever drops off the list,
			// an in-flight unattended rewrite has stopped consulting the flag.
			"packages/temporal/src/activities/document-refresh/run-document-refresh.ts",
		]) {
			expect(files).toContain(expected);
		}
	});
});
