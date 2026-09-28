/**
 * Glossy Version Export gate — await regression guard.
 *
 * THE BUG THIS PREVENTS: a call site that references the Glossy feature gate
 * WITHOUT awaiting it. Both `assertGlossyEnabled` and the underlying
 * `isFeatureEnabled` are async, and an un-awaited async call returns a
 * Promise — which is ALWAYS truthy and never throws. So:
 *
 *   `assertGlossyEnabled(projectId);`
 *
 * looks exactly like a gate and enforces nothing: the statement resolves in
 * the background, any rejection becomes an unhandled promise rejection
 * instead of stopping the caller, and the procedure runs as though the
 * feature were always on. Per KTD20 there is no companion kill switch for
 * this feature — `assertGlossyEnabled` and the prepare-time re-read of
 * `GLOSSY_EDITION` ARE the switch — so a missed `await` here does not degrade
 * the gate, it removes it.
 *
 * Modeled on `living-docs-refresh-gate-guard.test.ts`, which records the same
 * defect for a different gate; see that file for the fuller rationale.
 *
 * THE RULE: every reference to `assertGlossyEnabled(` or to
 * `isFeatureEnabled("GLOSSY_EDITION")` anywhere under `packages/api`,
 * `packages/temporal/src`, `packages/database`, `packages/rag`,
 * `packages/mcp`, or `apps/web` is either directly awaited, or a member of an
 * `await Promise.all([...])`.
 *
 * If this fails on your new call site, add the `await` — do not relax the
 * pattern. The gate is a gate only when it is awaited.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..", "..");

// Wider than where the gate lives today, deliberately — a guard that scans
// only today's call sites proves nothing about where the next one lands.
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
 * Every reference to the gate that is a CALL. The identifiers alone would
 * also match the import line and the function's own declaration; requiring
 * the open paren (and, for the registry read, this flag's key) narrows it to
 * invocations of this gate specifically — `isFeatureEnabled` serves every
 * other flag too.
 */
const GATE_CALL_RE =
	/assertGlossyEnabled(?:ForOrganization)?\s*\(|isFeatureEnabled\s*\(\s*["']GLOSSY_EDITION["']/g;

/** The gate's own definition — `export async function assert…(` — is not a call. */
const DECLARATION_BEFORE_RE = /\bfunction\s+$/;

/** Directly awaited: `await assertGlossyEnabled(...)`. */
const DIRECT_AWAIT_RE = /\bawait\s*$/;

/** The other legal shape — a member of an awaited `Promise.all([...])`. */
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
 * Blank out comments so a doc-comment that NAMES the gate (this file's rule
 * is quoted in several of them) is not scanned as a call site. Replaced with
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
			if (
				!raw.includes("GLOSSY_EDITION") &&
				!raw.includes("assertGlossyEnabled")
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

describe("Glossy Version Export gate — await guard", () => {
	it("every server-side reference to the gate is awaited", () => {
		const offenders = collectReferences().filter((r) => !r.awaited);

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} reference(s) to the Glossy gate are not awaited. ` +
					"An un-awaited async gate returns a Promise, which is always truthy — " +
					"the gate reads like a gate and lets everything through:\n\n" +
					offenders
						.map((o) => `  ${o.file}:${o.line}  …${o.snippet}…`)
						.join("\n") +
					"\n\nFix: `await assertGlossyEnabled(...)` / " +
					'`await isFeatureEnabled("GLOSSY_EDITION", ...)`, or place the call ' +
					"inside an `await Promise.all([...])`.",
			);
		}

		expect(offenders.length).toBe(0);
	});

	// AE10: with the gate off every Glossy procedure answers NOT_FOUND. The
	// permission middleware would answer a viewer's write FORBIDDEN first,
	// so the gate middleware must come before it in every procedure chain.
	it("every Glossy and recipient-brand procedure runs the gate before the permission middleware", () => {
		const dirs = [
			"packages/api/modules/projects/procedures/glossy",
			"packages/api/modules/projects/procedures/recipient-brand",
		];
		const problems: string[] = [];
		let procedures = 0;
		for (const dir of dirs) {
			for (const absFile of walkTsFiles(resolve(repoRoot, dir))) {
				const source = stripComments(readFileSync(absFile, "utf-8"));
				if (!source.includes("tenantProtectedProcedure")) {
					continue;
				}
				procedures++;
				const file = relative(repoRoot, absFile).split(sep).join("/");
				const gateAt = source.indexOf(".use(requireGlossyEnabled())");
				const permissionAt = source.indexOf(
					".use(requireProjectPermission(",
				);
				if (gateAt === -1) {
					problems.push(`${file}: no .use(requireGlossyEnabled())`);
				} else if (permissionAt !== -1 && permissionAt < gateAt) {
					problems.push(
						`${file}: requireProjectPermission runs before the gate`,
					);
				}
			}
		}
		expect(problems).toEqual([]);
		// Five Glossy procedures and four recipient-brand ones today.
		expect(procedures).toBeGreaterThanOrEqual(9);
	});

	// The gate helper itself must always resolve — a scan that finds zero
	// references anywhere would also report zero offenders, which proves
	// nothing. Later units wire callers in (the build procedure, the
	// prepare-time re-read); this only pins that the module the guard scans
	// for still exists under the name it expects.
	it("the gate module it protects still exists", () => {
		const source = readFileSync(
			resolve(
				repoRoot,
				"packages/api/modules/projects/lib/glossy-feature.ts",
			),
			"utf-8",
		);
		expect(source).toContain("export async function assertGlossyEnabled(");
	});
});
