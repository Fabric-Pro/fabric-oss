#!/usr/bin/env node
/**
 * Pull-request review checks.
 *
 * Reviews a pull request from two perspectives and writes a comment. Every rule
 * here is DECIDABLE — it is answered by reading the changed files, never by
 * asking a model. That is the same constraint the product's own architecture
 * review lens works under, and for the same reason: a review that is
 * confidently wrong costs somebody an afternoon proving there is no problem,
 * and a reviewer that cries wolf gets switched off in a week.
 *
 * It is deliberately ADVISORY. It exits 0 whatever it finds, it is not a
 * required check, and an unresolved comment never blocks a merge. A rule only
 * earns a place here if a false positive is close to impossible; anything
 * needing judgement belongs to a human or to the product's model-backed lens.
 *
 * Rules are chosen to not duplicate gates the repository already has. An oRPC
 * handler missing its permission gate is NOT checked here, because
 * `packages/api/__tests__/permission-coverage.test.ts` already fails the build
 * for it — a second opinion on a settled question is noise.
 *
 * Usage:
 *   check.mjs [--diff <file>] --files <path>...
 *
 * `--diff` takes `git diff -U0` output and limits findings to lines the change
 * introduced. Without it every finding in the named files is reported, which is
 * what you want locally and not what you want on a pull request.
 */

import { readFileSync } from "node:fs";

/** Workflow code Temporal replays; anything ambient here breaks determinism. */
const WORKFLOW_DIR = "packages/temporal/src/workflows/";

/**
 * The two replay rules this repository states in `packages/temporal/README.md`
 * and enforces nowhere.
 *
 * `Date.now()`, `new Date()` and `Math.random()` are deliberately NOT here. An
 * earlier draft flagged them and was wrong: the Temporal TypeScript SDK gives
 * workflow code deterministic versions of all three, this repository's own
 * guidance says "never use `unsafe.now()` (use `Date.now()` only)", and 72
 * workflow files use them correctly. Running that draft over the real workflow
 * directory produced 28 findings, every one of them idiomatic code. Do not
 * reintroduce it — that is the rule that would have taught people to ignore
 * this comment.
 */
const REPLAY_RULES = [
	{
		pattern: /\bunsafe\.now\s*\(/,
		name: "unsafe.now()",
		why: "bypasses the deterministic clock, so a replay takes a different branch. Use Date.now(), which the SDK makes replay-safe.",
	},
	{
		pattern: /\brecordAudit\w*\s*\(/,
		name: "recordAudit()",
		why: "writes from workflow code, which replays. The write happens again on every replay. Move it into an activity.",
	},
];

/** Model calls that must state an output budget. */
const MODEL_CALLS = ["generateObject", "generateText"];

/** A path that is a test rather than production source. */
export function isTestPath(path) {
	return (
		path.includes("__tests__/") ||
		path.includes("/__mocks__/") ||
		/\.(test|spec)\.[mc]?[jt]sx?$/.test(path)
	);
}

/** A path this tool has an opinion about at all. */
export function isReviewableSource(path) {
	return (
		/^(packages|apps)\//.test(path) &&
		/\.[mc]?[jt]sx?$/.test(path) &&
		!isTestPath(path)
	);
}

/**
 * Strip line comments and string bodies so a rule cannot match prose.
 *
 * Deliberately crude: it blanks the CONTENTS of quoted spans rather than
 * removing them, so every byte offset in the result still lines up with the
 * original. A finding's line number has to point at the real line.
 */
export function blankNonCode(source) {
	// Built as an array and joined once. Appending to a string in this loop is
	// quadratic, which is invisible on a fixture and times out on a real file.
	const out = new Array(source.length);
	let i = 0;
	let quote = null;
	const put = (from, to, ch) => {
		for (let k = from; k < to; k++) {
			out[k] = ch === null ? (source[k] === "\n" ? "\n" : " ") : ch;
		}
	};
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (quote) {
			if (ch === "\\") {
				put(i, Math.min(i + 2, source.length), " ");
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
				out[i] = ch;
				i += 1;
				continue;
			}
			// Keep newlines so line numbers survive.
			out[i] = ch === "\n" ? "\n" : " ";
			i += 1;
			continue;
		}
		if (ch === "/" && next === "/") {
			const start = i;
			while (i < source.length && source[i] !== "\n") {
				i += 1;
			}
			put(start, i, " ");
			continue;
		}
		if (ch === "/" && next === "*") {
			const start = i;
			while (
				i < source.length &&
				!(source[i] === "*" && source[i + 1] === "/")
			) {
				i += 1;
			}
			put(start, i, null);
			put(i, Math.min(i + 2, source.length), " ");
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out[i] = ch;
			i += 1;
			continue;
		}
		out[i] = ch;
		i += 1;
	}
	for (let k = 0; k < out.length; k++) {
		if (out[k] === undefined) {
			out[k] = " ";
		}
	}
	return out.join("");
}

/**
 * 1-based line lookup for a file, built once.
 *
 * Counting newlines from zero for every finding is quadratic across a file with
 * many matches — the same shape of mistake as string-appending above, and it
 * showed up the first time this ran over the real workflow directory.
 */
export function makeLineLookup(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") {
			starts.push(i + 1);
		}
	}
	return (index) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= index) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return lo + 1;
	};
}

/**
 * The two calls this repository forbids in workflow code.
 *
 * Workflow code runs again from the top on every replay. The SDK makes the
 * ambient things (clock, randomness, timers) answer identically each time; what
 * it cannot make safe is a call that reaches past it, or one that writes.
 */
export function findWorkflowReplayBreaks(path, source) {
	if (!path.startsWith(WORKFLOW_DIR)) {
		return [];
	}
	const code = blankNonCode(source);
	const lineOf = makeLineLookup(code);
	const findings = [];
	for (const { pattern, name, why } of REPLAY_RULES) {
		const global = new RegExp(pattern.source, "g");
		let match = global.exec(code);
		while (match !== null) {
			findings.push({
				rule: "workflow-replay",
				path,
				line: lineOf(match.index),
				detail: `${name} in workflow code — ${why}`,
			});
			match = global.exec(code);
		}
	}
	return findings;
}

/**
 * A schema change that does not touch tenant registration.
 *
 * A new tenant-scoped table has to be registered in `tenant-db.ts` in BOTH
 * places or it silently escapes the application-level filter. That has happened
 * here before and a review caught it; nothing catches it automatically. Fires
 * only when the schema moved and the registration did not, so it stays quiet on
 * every change that is not a schema change at all.
 */
export function checkTenantRegistration(paths) {
	const schemaChanged = paths.some((p) =>
		p.endsWith("packages/database/prisma/schema.prisma"),
	);
	const tenantDbChanged = paths.some((p) => p.includes("tenant-db.ts"));
	if (!schemaChanged || tenantDbChanged) {
		return null;
	}
	return {
		rule: "tenant-registration",
		detail: "The Prisma schema changed and `tenant-db.ts` did not. If this adds a tenant-scoped table it has to be registered there in both places, or it escapes the application-level tenant filter. Ignore this if the change adds no tenant table.",
	};
}

/**
 * Walk from an opening parenthesis to its match, returning the span between.
 * Returns null when the call is unterminated in this file.
 */
function callArguments(code, openParenIndex) {
	let depth = 0;
	for (let i = openParenIndex; i < code.length; i++) {
		if (code[i] === "(") {
			depth += 1;
		} else if (code[i] === ")") {
			depth -= 1;
			if (depth === 0) {
				return code.slice(openParenIndex + 1, i);
			}
		}
	}
	return null;
}

/**
 * A model call with no output budget.
 *
 * An unbounded generation is the failure mode this repository has already paid
 * for more than once: the call runs long, returns nothing usable, and the
 * feature looks broken rather than slow. Checked per CALL rather than per file,
 * so a file where one of three calls forgot it is still caught.
 */
export function findUnboundedModelCalls(path, source) {
	if (!isReviewableSource(path)) {
		return [];
	}
	const code = blankNonCode(source);
	const lineOf = makeLineLookup(code);
	const findings = [];
	for (const fn of MODEL_CALLS) {
		const global = new RegExp(`\\b${fn}\\s*\\(`, "g");
		let match = global.exec(code);
		while (match !== null) {
			const open = code.indexOf("(", match.index);
			const args = callArguments(code, open);
			if (args !== null && !args.includes("maxOutputTokens")) {
				findings.push({
					rule: "unbounded-model-call",
					path,
					line: lineOf(match.index),
					detail: `${fn}() with no maxOutputTokens. An unbounded generation fails as a hang rather than an error, which reads as a broken feature rather than a slow one.`,
				});
			}
			match = global.exec(code);
		}
	}
	return findings;
}

/**
 * The QA perspective, stated as one fact rather than a list.
 *
 * Reported only when a change touches production source and NO test file at
 * all. Naming individual files would fire on every refactor and teach people to
 * skim past the comment; "eleven source files and no tests" is a question worth
 * one reader's attention.
 */
export function summariseTestCoverage(paths) {
	const source = paths.filter(isReviewableSource);
	const tests = paths.filter(isTestPath);
	if (source.length === 0 || tests.length > 0) {
		return null;
	}
	return {
		rule: "no-tests-touched",
		count: source.length,
		examples: source.slice(0, 5),
	};
}

const RULE_HEADINGS = {
	"workflow-replay": "**Workflow replay**",
	"unbounded-model-call": "**Model output budget**",
};

/** Render the comment. Returns null when there is nothing worth saying. */
export function renderReport(findings, coverage, tenant = null) {
	if (findings.length === 0 && coverage === null && tenant === null) {
		return null;
	}
	const lines = [];
	if (findings.length > 0) {
		const byRule = new Map();
		for (const f of findings) {
			byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
		}
		for (const [rule, items] of byRule) {
			lines.push(RULE_HEADINGS[rule] ?? `**${rule}**`);
			lines.push("");
			for (const f of items) {
				lines.push(`- \`${f.path}:${f.line}\` — ${f.detail}`);
			}
			lines.push("");
		}
	}
	if (tenant !== null) {
		lines.push("**Tenant isolation**");
		lines.push("");
		lines.push(`- ${tenant.detail}`);
		lines.push("");
	}
	if (coverage !== null) {
		lines.push("**Tests**");
		lines.push("");
		lines.push(
			`- This change touches ${coverage.count} source file${coverage.count === 1 ? "" : "s"} and no test file. That is sometimes right; it is worth a sentence in the description saying which.`,
		);
		lines.push("");
		for (const p of coverage.examples) {
			lines.push(`  - \`${p}\``);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/**
 * Which lines a pull request actually touched, from `git diff -U0` output.
 *
 * Without this the tool reports every pre-existing problem in any file the
 * change happens to open, which is how a review bot teaches people to mute it.
 * A finding earns its place only if the author put that line there.
 */
export function parseChangedLines(diff) {
	const byPath = new Map();
	let path = null;
	for (const line of diff.split("\n")) {
		const file = /^\+\+\+ b\/(.+)$/.exec(line);
		if (file) {
			path = file[1];
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk && path) {
			const start = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			const set = byPath.get(path) ?? new Set();
			for (let i = 0; i < count; i++) {
				set.add(start + i);
			}
			byPath.set(path, set);
		}
	}
	return byPath;
}

/** Keep only findings on lines this pull request introduced. */
export function limitToChanged(findings, changed) {
	if (changed === null) {
		return findings;
	}
	return findings.filter((f) => changed.get(f.path)?.has(f.line) === true);
}

function main() {
	const argv = process.argv.slice(2);
	let changed = null;
	const diffFlag = argv.indexOf("--diff");
	if (diffFlag !== -1) {
		try {
			changed = parseChangedLines(
				readFileSync(argv[diffFlag + 1], "utf8"),
			);
		} catch {
			// No diff available: report everything rather than nothing, and let the
			// reader see that the run was unfiltered.
			changed = null;
		}
		argv.splice(diffFlag, 2);
	}
	if (argv[0] !== "--files") {
		console.error("usage: check.mjs [--diff <file>] --files <path>...");
		process.exit(2);
	}
	const paths = argv.slice(1);
	const findings = [];
	for (const path of paths) {
		let source;
		try {
			source = readFileSync(path, "utf8");
		} catch {
			// Deleted in this pull request. Nothing to read and nothing to say.
			continue;
		}
		findings.push(...findWorkflowReplayBreaks(path, source));
		findings.push(...findUnboundedModelCalls(path, source));
	}
	const report = renderReport(
		limitToChanged(findings, changed),
		summariseTestCoverage(paths),
		checkTenantRegistration(paths),
	);
	if (report !== null) {
		process.stdout.write(report);
	}
	// Always 0. This is advisory; a merge is never blocked by what it found.
	process.exit(0);
}

if (process.argv[1]?.endsWith("check.mjs")) {
	main();
}
