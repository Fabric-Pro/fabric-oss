/**
 * CI gate: fail builds that introduce Prisma queries against tenant-scoped
 * tables using `organizationId: <expr>` without `?? null` or `resolveOrgIdForQuery`.
 *
 * Scope: packages/api and apps/web TypeScript files.
 * Pattern blocked: `organizationId: state.organizationId` without `?? null` suffix.
 * Pattern allowed: `organizationId: state.organizationId ?? null`,
 *                  `organizationId: resolveOrgIdForQuery(state)`,
 *                  `organizationId: orgIdForQuery`.
 *
 * Implementation: pure Node.js fs walk — no shell-out, no injection risk,
 * fully portable across macOS (BSD grep) and Linux (GNU grep).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_PATHS = ["packages/api", "apps/web"];

/**
 * Matches `organizationId: state.organizationId` NOT followed by whitespace + `??`
 * and not followed by a comment marker (tenant-isolation:allow).
 *
 * Allowed patterns (explicit coercion):
 *   organizationId: state.organizationId ?? null    — Prisma XOR pattern
 *   organizationId: state.organizationId ?? undefined — optional non-Prisma arg
 *
 * To allow a pre-existing violation in non-Prisma code, append a comment:
 *   organizationId: state.organizationId, // tenant-isolation:allow
 *
 * Uses a JS negative lookahead so it's portable across all platforms.
 */
const BAD_PATTERN = /organizationId:\s*state\.organizationId(?!\s*\?\?)/;

interface Finding {
	file: string;
	line: number;
	text: string;
}

function walkDir(dir: string, ext: string[], out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (
			entry === "node_modules" ||
			entry === "dist" ||
			entry.startsWith(".")
		) {
			continue;
		}
		const full = join(dir, entry);
		let st: ReturnType<typeof statSync> | undefined;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkDir(full, ext, out);
		} else if (ext.some((e) => full.endsWith(e))) {
			out.push(full);
		}
	}
}

const ALLOW_COMMENT = /tenant-isolation:allow/;

function scanFile(file: string): Finding[] {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const findings: Finding[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (BAD_PATTERN.test(lines[i]) && !ALLOW_COMMENT.test(lines[i])) {
			findings.push({ file, line: i + 1, text: lines[i].trim() });
		}
	}
	return findings;
}

const allFindings: Finding[] = [];
for (const scanPath of SCAN_PATHS) {
	const files: string[] = [];
	walkDir(scanPath, [".ts", ".tsx"], files);
	for (const file of files) {
		allFindings.push(...scanFile(file));
	}
}

if (allFindings.length > 0) {
	console.error(
		"[tenant-isolation:check] FAIL — raw organizationId coercion without `?? null`:",
	);
	for (const f of allFindings) {
		console.error(`  ${f.file}:${f.line}: ${f.text}`);
	}
	console.error(
		"\nFix: use `?? null` (e.g. state.organizationId ?? null) or resolveOrgIdForQuery(state).",
	);
	process.exit(1);
}
console.log("[tenant-isolation:check] PASS");
