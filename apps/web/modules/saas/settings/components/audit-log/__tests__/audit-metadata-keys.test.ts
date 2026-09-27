/**
 * No audit metadata key may match the sensitive-key denylist by accident.
 *
 * The audit writer redacts any metadata key that CONTAINS a denylisted
 * substring (`keyIsSensitive` in `@repo/utils/sensitive-keys`), so a harmless
 * key that happens to spell one is stored as "[REDACTED]" on every row:
 * `secretWritten` (secret), `previousSnoozedUntil` (ssn, inside
 * "previouSSNoozed"), `pinnedBranches` (pin), `totalTokens` (token),
 * `rootPathChanged` (otp). Nothing leaks, but the trail silently loses the one
 * fact the row exists to record, and no test notices because the redactor is
 * doing exactly its job.
 *
 * Metadata must never carry a real secret (AGENTS.md), so every denylist match
 * at a call site is a mistake: the fix is to rename the key, never to weaken
 * the shared list. That is why there is no allowlist here.
 *
 * The scan reads the TypeScript AST of every source file that writes audit
 * rows, and checks every object literal carrying both `action` and `metadata`,
 * which covers direct writer calls and the builders that return their input.
 * It follows nested literals, spreads, conditionals and same-file `const`s
 * into the metadata. Keys built at runtime (from `Object.entries` and the like)
 * are out of its reach; the redactor still covers those.
 *
 * It lives in `apps/web` because that is the one workspace that depends on
 * every package that writes audit rows, so CI re-runs it when any of them
 * changes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { keyIsSensitive } from "@repo/utils/sensitive-keys";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../../../../../..");
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".next",
	".turbo",
	"generated",
	"zod",
	"__tests__",
	"__mocks__",
]);
const WRITES_AUDIT = /[rR]ecordAudit/;

function sourceFiles(dir: string, out: string[]): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
				sourceFiles(join(dir, entry.name), out);
			}
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!/\.(test|spec)\.tsx?$|\.d\.ts$/.test(entry.name)
		) {
			out.push(join(dir, entry.name));
		}
	}
	return out;
}

function propertyName(name: ts.PropertyName): string | null {
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	if (
		ts.isComputedPropertyName(name) &&
		ts.isStringLiteralLike(name.expression)
	) {
		return name.expression.text;
	}
	return null;
}

function hasProperty(node: ts.ObjectLiteralExpression, key: string): boolean {
	return node.properties.some(
		(p) => p.name !== undefined && propertyName(p.name) === key,
	);
}

interface ScanResult {
	auditLiterals: number;
	filesWithAuditLiterals: Set<string>;
	violations: string[];
}

function scan(): ScanResult {
	const result: ScanResult = {
		auditLiterals: 0,
		filesWithAuditLiterals: new Set(),
		violations: [],
	};
	const files = SCAN_ROOTS.flatMap((root) =>
		sourceFiles(join(REPO_ROOT, root), []),
	);
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		if (!WRITES_AUDIT.test(text)) {
			continue;
		}
		const path = relative(REPO_ROOT, file);
		const sf = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			true,
		);

		const constInitializers = new Map<string, ts.Expression>();
		const collectConsts = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer
			) {
				constInitializers.set(node.name.text, node.initializer);
			}
			ts.forEachChild(node, collectConsts);
		};
		collectConsts(sf);

		const report = (node: ts.Node, key: string): void => {
			const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
			result.violations.push(`${path}:${line + 1} ${key}`);
		};

		const walkValue = (value: ts.Expression, seen: Set<string>): void => {
			if (
				ts.isParenthesizedExpression(value) ||
				ts.isAsExpression(value) ||
				ts.isSatisfiesExpression(value) ||
				ts.isNonNullExpression(value)
			) {
				walkValue(value.expression, seen);
			} else if (ts.isObjectLiteralExpression(value)) {
				for (const p of value.properties) {
					if (ts.isSpreadAssignment(p)) {
						walkValue(p.expression, seen);
						continue;
					}
					const key =
						p.name === undefined ? null : propertyName(p.name);
					if (key !== null && keyIsSensitive(key)) {
						report(p, key);
					}
					if (ts.isPropertyAssignment(p)) {
						walkValue(p.initializer, seen);
					}
					if (ts.isShorthandPropertyAssignment(p)) {
						walkValue(p.name, seen);
					}
				}
			} else if (ts.isArrayLiteralExpression(value)) {
				for (const element of value.elements) {
					walkValue(element, seen);
				}
			} else if (ts.isConditionalExpression(value)) {
				walkValue(value.whenTrue, seen);
				walkValue(value.whenFalse, seen);
			} else if (ts.isBinaryExpression(value)) {
				walkValue(value.left, seen);
				walkValue(value.right, seen);
			} else if (ts.isIdentifier(value) && !seen.has(value.text)) {
				const initializer = constInitializers.get(value.text);
				if (initializer) {
					walkValue(initializer, new Set(seen).add(value.text));
				}
			}
		};

		const visit = (node: ts.Node): void => {
			if (
				ts.isObjectLiteralExpression(node) &&
				hasProperty(node, "action") &&
				hasProperty(node, "metadata")
			) {
				result.auditLiterals++;
				result.filesWithAuditLiterals.add(path);
				for (const p of node.properties) {
					if (
						p.name === undefined ||
						propertyName(p.name) !== "metadata"
					) {
						continue;
					}
					if (ts.isPropertyAssignment(p)) {
						walkValue(p.initializer, new Set());
					}
					if (ts.isShorthandPropertyAssignment(p)) {
						walkValue(p.name, new Set());
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return result;
}

describe("audit metadata keys", () => {
	const result = scan();

	it("scans the audit writers across the repository", () => {
		// A scan that silently found nothing would pass the check below, so pin
		// its reach: a broad count, and call sites from each writing package.
		expect(result.auditLiterals).toBeGreaterThan(200);
		for (const file of [
			"apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts",
			"packages/api/modules/projects/procedures/qa-settings/environment-credentials.ts",
			"packages/api/modules/todos/procedures/unsnooze.ts",
			"packages/atlas/src/service.ts",
			"packages/auth/auth.ts",
			"packages/database/prisma/queries/instructions.ts",
			"packages/temporal/src/activities/project-instructions.ts",
		]) {
			expect(result.filesWithAuditLiterals).toContain(file);
		}
	});

	it("uses no key the audit redactor would blank", () => {
		expect(result.violations).toEqual([]);
	});
});
