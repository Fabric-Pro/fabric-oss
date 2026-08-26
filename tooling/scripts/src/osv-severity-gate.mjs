#!/usr/bin/env node
// Fails CI when osv-scanner reports a high or critical advisory.
//
// osv-scanner exits non-zero on any finding and has no severity threshold, so
// the severity decision lives here. Gating on high+ matches the intent of the
// `pnpm audit --audit-level=high` step this replaced, and Dependabot's own
// severity split for this repo.
//
// Advisories we have dismissed rather than fixed are excluded upstream by
// osv-scanner.toml, so anything reaching this gate is undismissed.
//
// Deliberately dependency-free: the Security workflow runs this with bare
// `node` on a fresh checkout, with no `pnpm install` before it. Keep it that
// way — importing anything from the workspace would mean installing the whole
// monorepo to decide whether a lockfile has a high advisory in it.
//
// `evaluate` is exported and unit-tested (osv-severity-gate.test.mjs); the CLI
// below is the thin shell around it. This gate exists because the check it
// replaced could not fail, so "is it actually able to fail?" is a property
// worth testing rather than assuming.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GATED = new Set(["HIGH", "CRITICAL"]);

/**
 * Reduce an osv-scanner JSON report to a gate decision.
 *
 * @param {unknown} report Parsed osv-scanner `--format=json` output.
 * @returns {{findings: Array, counts: Record<string, number>, gated: Array, lines: string[], shouldFail: boolean}}
 */
export function evaluate(report) {
	const findings = [];
	for (const result of report?.results ?? []) {
		for (const pkg of result?.packages ?? []) {
			for (const vuln of pkg?.vulnerabilities ?? []) {
				findings.push({
					severity: String(
						vuln.database_specific?.severity ?? "UNKNOWN",
					).toUpperCase(),
					name: pkg.package?.name ?? "unknown",
					version: pkg.package?.version ?? "unknown",
					id: vuln.id ?? "unknown",
				});
			}
		}
	}

	const counts = {};
	for (const f of findings) {
		counts[f.severity] = (counts[f.severity] ?? 0) + 1;
	}

	const gated = findings.filter((f) => GATED.has(f.severity));
	const summary = gated.length
		? `${gated.length} undismissed high+ ${gated.length === 1 ? "advisory" : "advisories"}`
		: "No undismissed high+ advisories";

	const lines = [
		`### Dependency audit — ${summary}`,
		"",
		`Findings by severity: ${JSON.stringify(counts)}`,
	];
	for (const f of gated) {
		lines.push(`- **${f.severity}** ${f.name}@${f.version} — ${f.id}`);
	}

	// Below-high findings are reported but do not gate; they are triaged in
	// Dependabot.
	return { findings, counts, gated, lines, shouldFail: gated.length > 0 };
}

/**
 * Read the report and fail the build on any undismissed high+ advisory.
 *
 * Fails closed: a missing or unparseable report throws rather than passing.
 * The scan step is `continue-on-error`, so no report means the scan produced
 * no verdict — which must not read as "clean".
 *
 * @param {string} reportPath
 * @returns {number} Process exit code.
 */
export function run(reportPath) {
	const { lines, shouldFail } = evaluate(
		JSON.parse(readFileSync(reportPath, "utf8")),
	);
	const text = lines.join("\n");

	console.log(text);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
	}
	return shouldFail ? 1 : 0;
}

// Only run as a CLI, so the test can import this module without exiting.
// pathToFileURL rather than string-concatenating `file://`, which does not
// round-trip a Windows path (`C:\...`) and would silently never match there.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exit(run(process.argv[2]));
}
