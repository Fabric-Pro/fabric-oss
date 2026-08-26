#!/usr/bin/env node
/**
 * Identifier guard.
 *
 * Keeps real organization, deployment and person names out of everything that
 * becomes public on push: file content, commit messages, branch names, PR
 * titles and PR bodies. Use placeholder values instead — see CONTRIBUTING.md
 * § Placeholder Data.
 *
 * The term list is supplied at runtime and is not part of this repository:
 *   - `FABRIC_BLOCKED_TERMS` (CI: a repository secret), or
 *   - `.blocked-terms` at the repo root (local: gitignored)
 * With neither present this exits 0 and does nothing, so a fresh clone and
 * every fork PR keep working unchanged.
 *
 * Matched terms are NEVER printed. A finding reports the rule index and the
 * location only; echoing the text in a public PR annotation would publish the
 * very thing being guarded.
 *
 * Term list format — one per line, `#` comments ignored:
 *   AcmeCorp        block (exit 1)
 *   ~Ambiguous      warn only (exit 0) — for terms that collide with real words
 *
 * Usage:
 *   check.mjs --files <path>...        scan file contents
 *   check.mjs --text <label> <string>  scan a single string (branch, PR title, ...)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TERMS_FILE = resolve(process.cwd(), ".blocked-terms");

/**
 * @typedef {{ index: number, regex: RegExp, warnOnly: boolean }} Rule
 */

/** @returns {Rule[]} */
function loadRules() {
	let raw = process.env.FABRIC_BLOCKED_TERMS ?? "";
	if (!raw && existsSync(TERMS_FILE)) {
		raw = readFileSync(TERMS_FILE, "utf8");
	}
	if (!raw.trim()) {
		return [];
	}

	// Strip comments per LINE before splitting on commas. Doing both at once
	// would split a comment containing a comma and treat everything after it as
	// a term — "# local only, never commit" silently becomes a rule matching
	// the words "never commit".
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.flatMap((line) => line.split(","))
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry, i) => {
			const warnOnly = entry.startsWith("~");
			const term = warnOnly ? entry.slice(1).trim() : entry;
			return { index: i + 1, regex: buildRegex(term), warnOnly };
		});
}

/**
 * Match a term tolerantly. The term is split into its natural word parts — on
 * explicit separators AND on camel-case boundaries — and rejoined so any
 * separator (or none) matches between them. `AcmeCorp`, `Acme Corp`,
 * `acme-corp` and `acme_corp` are therefore all caught by a single entry,
 * whichever form the list happens to use.
 *
 * Splitting on case boundaries matters because a branch name is where a term
 * most often turns up in a different shape than it was written in the list.
 *
 * @param {string} term
 * @returns {RegExp}
 */
function buildRegex(term) {
	const escaped = term
		.split(/[\s\-_]+/)
		.flatMap((chunk) => chunk.split(/(?<=[a-z0-9])(?=[A-Z])/))
		.filter(Boolean)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\-_]*");
	return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

/**
 * @param {string} content
 * @param {Rule[]} rules
 * @returns {{ rule: Rule, line: number }[]}
 */
function scan(content, rules) {
	const findings = [];
	const lines = content.split("\n");
	for (const rule of rules) {
		for (let i = 0; i < lines.length; i++) {
			if (rule.regex.test(lines[i])) {
				findings.push({ rule, line: i + 1 });
				break; // one finding per rule per target is enough to act on
			}
		}
	}
	return findings;
}

function main() {
	const rules = loadRules();
	if (rules.length === 0) {
		process.exit(0);
	}

	const [mode, ...rest] = process.argv.slice(2);
	/** @type {{ where: string, rule: Rule, line: number }[]} */
	const findings = [];

	if (mode === "--files") {
		for (const path of rest) {
			if (!existsSync(path)) {
				continue;
			}
			let content;
			try {
				content = readFileSync(path, "utf8");
			} catch {
				continue; // unreadable or binary — nothing to scan
			}
			if (content.includes("\0")) {
				continue;
			}
			for (const f of scan(content, rules)) {
				findings.push({ where: `${path}:${f.line}`, ...f });
			}
		}
	} else if (mode === "--text") {
		const [label, ...text] = rest;
		for (const f of scan(text.join(" "), rules)) {
			findings.push({ where: label, ...f });
		}
	} else {
		console.error(
			"usage: check.mjs --files <path>... | --text <label> <string>",
		);
		process.exit(2);
	}

	if (findings.length === 0) {
		process.exit(0);
	}

	const blocking = findings.filter((f) => !f.rule.warnOnly);

	console.error("");
	console.error(
		blocking.length > 0
			? "BLOCKED: a blocked term was found."
			: "WARNING: a possible blocked term was found.",
	);
	console.error(
		"The term is not printed here on purpose — this output can end up on a public PR.",
	);
	console.error("");
	for (const f of findings) {
		const kind = f.rule.warnOnly ? "warn" : "block";
		console.error(`  ${f.where} — matched rule #${f.rule.index} (${kind})`);
	}
	console.error("");
	console.error(
		"Describe the capability, not the account. Reference the ticket by number only.",
	);
	console.error("See CONTRIBUTING.md § Client identifiers.");
	console.error("");

	process.exit(blocking.length > 0 ? 1 : 0);
}

main();
