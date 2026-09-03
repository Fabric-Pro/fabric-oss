/**
 * Every site that inserts a prompt row at SYSTEM scope takes the guarded path
 * (Fizzy #2328 — R9, KTD5).
 *
 * The behavioural suites can only prove things about the creation paths that
 * exist today: `createPrompt` and the two seed loops. The failure this file
 * exists for is the FOURTH one — a new seed, a new backfill script, a new
 * "restore the catalogue" helper — landing with its own `db.prompt.create` and
 * quietly undoing every deletion the platform has recorded. Nothing about that
 * change would fail a test written against the three paths it did not touch.
 *
 * So this reads the source instead of running it, in the style of
 * `feature-placeholder.test.ts` and the migration-shape tests: it sweeps the
 * workspace for prompt-row inserts, pins the files allowed to hold one, and
 * checks each one either goes through `insertSystemPromptUnlessRetired` or is
 * structurally incapable of writing a SYSTEM row.
 *
 * A source-reading test is a weaker instrument than a behavioural one and is
 * used here deliberately: it cannot be satisfied by a comment, but it can be
 * satisfied by an insert that spells its scope in a way this file does not
 * recognize. That is why the pinned file list is the primary assertion — a new
 * creation path in a new file fails before its payload is ever parsed.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/seed-prompts/system-prompt-creation-guarded.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const DATABASE_ROOT = join(HERE, "..", "..");

/** Workspaces that can reach the Prisma client at all. */
const ROOTS = ["packages", "apps", "agents"];

const SKIP_DIRS = new Set([
	"node_modules",
	"generated",
	"dist",
	".next",
	".turbo",
	"zod",
	"migrations",
	"__tests__",
]);

/**
 * The ONLY files allowed to insert a prompt row. Adding one here is a
 * deliberate act: route the insert through `insertSystemPromptUnlessRetired`
 * first, and say in the review why a fourth creation path is needed.
 */
const PINNED_INSERT_SITES = [
	"packages/database/prisma/queries/prompts.ts",
	"packages/database/prisma/seed-prompts-only.ts",
	"packages/database/prisma/seed.ts",
].sort();

/** `prompt.create(` / `.createMany(` / `.upsert(` on the Prisma delegate. The
 *  `promptVersion` and `promptBinding` delegates do not match — they are
 *  different words — and neither writes a prompt row. */
const INSERT_CALL = /\bprompt\.(?:create|createMany|upsert)\(/g;

const GUARD = "insertSystemPromptUnlessRetired";

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				walk(join(dir, entry.name), out);
			}
			continue;
		}
		if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
			out.push(join(dir, entry.name));
		}
	}
}

function sourceFiles(): string[] {
	const found: string[] = [];
	for (const root of ROOTS) {
		walk(join(REPO_ROOT, root), found);
	}
	return found;
}

/** Repo-relative, forward-slashed, so the pinned list reads the same on every
 *  platform. */
const asRepoPath = (absolute: string) =>
	relative(REPO_ROOT, absolute).split(sep).join("/");

type InsertSite = {
	file: string;
	index: number;
	/** The call's argument text, balanced-paren extracted. */
	payload: string;
	/** What comes before the call — enough to see the guard wrapping it. */
	before: string;
	/** The client the call was made on: `db`, `tx`, `client`, … */
	receiver: string;
	/** The nearest preceding function declaration. */
	enclosingFunction: string;
};

/** Everything from the opening paren to its match, so a nested object literal
 *  does not truncate the payload. */
function extractCall(src: string, openParen: number): string {
	let depth = 0;
	for (let i = openParen; i < src.length; i++) {
		if (src[i] === "(") {
			depth++;
		} else if (src[i] === ")") {
			depth--;
			if (depth === 0) {
				return src.slice(openParen, i + 1);
			}
		}
	}
	return src.slice(openParen);
}

function insertSitesIn(file: string): InsertSite[] {
	const src = readFileSync(file, "utf8");
	const sites: InsertSite[] = [];

	for (const match of src.matchAll(INSERT_CALL)) {
		const index = match.index ?? 0;
		const openParen = index + match[0].length - 1;
		const before = src.slice(Math.max(0, index - 800), index);
		const receiver = /([A-Za-z_$][\w$]*)\.$/.exec(
			src.slice(Math.max(0, index - 40), index),
		);
		const functions = [
			...src.slice(0, index).matchAll(/function\s+([A-Za-z_$][\w$]*)/g),
		];

		sites.push({
			file: asRepoPath(file),
			index,
			payload: extractCall(src, openParen),
			before,
			receiver: receiver?.[1] ?? "unknown",
			enclosingFunction: functions.at(-1)?.[1] ?? "unknown",
		});
	}

	return sites;
}

const ALL_SITES = sourceFiles().flatMap(insertSitesIn);

const readDatabaseSource = (relativePath: string) =>
	readFileSync(join(DATABASE_ROOT, relativePath), "utf8");

/** The body of one top-level function, from its declaration to the next one. */
function functionBody(src: string, name: string): string {
	const start = src.indexOf(`function ${name}(`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	const next = src.indexOf("\nexport ", start + 1);
	return src.slice(start, next === -1 ? src.length : next);
}

describe("prompt-row inserts across the workspace", () => {
	it("live only in the files pinned here", () => {
		const files = [...new Set(ALL_SITES.map((site) => site.file))].sort();

		// If this fails on a file you added: route the insert through
		// `insertSystemPromptUnlessRetired` (packages/database/prisma/queries/
		// prompts.ts) so a retired key cannot be recreated, then add the file
		// to PINNED_INSERT_SITES.
		expect(files).toEqual(PINNED_INSERT_SITES);
	});

	it("are found at all — the sweep is not silently matching nothing", () => {
		// Negative-assertion proof: without this, a broken regex or a wrong
		// root would make every other case in this file pass vacuously.
		expect(ALL_SITES.length).toBeGreaterThanOrEqual(4);
	});

	it("take the guard whenever the payload says SYSTEM", () => {
		const systemInserts = ALL_SITES.filter((site) =>
			/scope:\s*"SYSTEM"/.test(site.payload),
		);

		expect(systemInserts.length).toBeGreaterThan(0);

		for (const site of systemInserts) {
			expect(
				site.before.includes(GUARD),
				`${site.file} inserts a SYSTEM prompt without ${GUARD}`,
			).toBe(true);
		}
	});
});

describe("the two catalogue seeds", () => {
	it.each(["prisma/seed-prompts-only.ts", "prisma/seed.ts"])(
		"insert through the transaction client only (%s)",
		(file) => {
			const sites = ALL_SITES.filter(
				(site) => site.file === `packages/database/${file}`,
			);

			expect(sites.length).toBeGreaterThan(0);
			for (const site of sites) {
				// A `db.` insert is one made OUTSIDE the guarded transaction, which
				// is the shape both loops had before this change.
				expect(
					site.receiver,
					`${file}: ${site.enclosingFunction}`,
				).not.toBe("db");
				expect(site.before).toContain(GUARD);
			}
		},
	);
});

describe("packages/database/prisma/queries/prompts.ts", () => {
	const src = readDatabaseSource("prisma/queries/prompts.ts");

	it("routes createPrompt's SYSTEM branch through the guard, and only its tail inserts directly", () => {
		const body = functionBody(src, "createPrompt");

		expect(body).toContain('scope === "SYSTEM"');
		expect(body).toContain(GUARD);
		// The guarded branch returns before the plain insert is reached, so the
		// direct `db.prompt.create` below it can only ever run for ORG or USER.
		expect(body.indexOf(GUARD)).toBeLessThan(
			body.indexOf("db.prompt.create"),
		);
	});

	// forkPrompt is the one insert site that is exempt, and this is why: its
	// type makes a SYSTEM row unrepresentable, and the row it writes carries a
	// rewritten key that can never collide with a retired one. Widening that
	// union fails here, which is the point.
	it("keeps forkPrompt structurally incapable of writing a SYSTEM row", () => {
		const body = functionBody(src, "forkPrompt");

		expect(body).toContain('targetScope: "USER" | "ORG"');
		expect(body).toContain("scope: targetScope as any");
		expect(body).not.toContain('scope: "SYSTEM"');
	});

	it("has exactly the two unguarded inserts those two functions account for", () => {
		const unguarded = ALL_SITES.filter(
			(site) =>
				site.file === "packages/database/prisma/queries/prompts.ts" &&
				site.receiver === "db",
		);

		expect(unguarded.map((site) => site.enclosingFunction).sort()).toEqual([
			"createPrompt",
			"forkPrompt",
		]);
	});
});
