import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
// The latest migration that (re)defines sanitize_event() holds the live allowlists.
const migrationsDir = resolve(__dirname, "../prisma/migrations");
const migration = readdirSync(migrationsDir)
	.sort()
	.map((name) => join(migrationsDir, name, "migration.sql"))
	.filter((path) => {
		try {
			return /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+"?lakehouse_export"?\."?sanitize_event"?\s*\(/i.test(
				readFileSync(path, "utf8"),
			);
		} catch {
			return false;
		}
	})
	.at(-1);
if (!migration) {
	throw new Error("No migration defines lakehouse_export.sanitize_event()");
}
const excluded = new Set([
	"node_modules",
	"dist",
	"build",
	"generated",
	"zod",
	"migrations",
	"__tests__",
	".next",
	".turbo",
]);

function sources(directory: string): Array<{ path: string; text: string }> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (excluded.has(entry.name) || entry.name.startsWith(".")) {
			return [];
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return sources(path);
		}
		return /\.(ts|tsx)$/.test(entry.name) &&
			!/\.(test|spec)\./.test(entry.name)
			? [{ path, text: readFileSync(path, "utf8") }]
			: [];
	});
}

// The callee of a client call to the public rating endpoint.
const RATING_CALL = /\bfeedback\.(rate|clear)$/;

// Follow named outcome-writer wrappers, client calls to the public rating
// endpoint (`feedback.rate` / `feedback.clear`), local constants, and object-map
// values. Values computed at runtime remain unknown and must fall back at the
// SQL boundary; this is not general data-flow analysis.
function collectLiterals(files: Array<{ path: string; text: string }>) {
	const writers = new Set(["recordAiOutcome", "clearAiOutcome"]);
	const parsed = new Map<string, ts.SourceFile>();
	const result = {
		featureKey: new Set<string>(),
		subjectType: new Set<string>(),
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const file of files) {
			if (
				![...writers].some((name) => file.text.includes(name)) &&
				!file.text.includes("feedback.")
			) {
				continue;
			}
			let source = parsed.get(file.path);
			if (!source) {
				source = ts.createSourceFile(
					file.path,
					file.text,
					ts.ScriptTarget.Latest,
					true,
				);
				parsed.set(file.path, source);
			}
			const bindings = new Map<string, ts.Expression>();
			const imports = new Map<string, string>();
			const visitBindings = (node: ts.Node) => {
				if (
					ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) &&
					node.initializer
				) {
					bindings.set(node.name.text, node.initializer);
				}
				if (ts.isImportSpecifier(node)) {
					imports.set(
						node.name.text,
						(node.propertyName ?? node.name).text,
					);
				}
				ts.forEachChild(node, visitBindings);
			};
			visitBindings(source);
			const unwrap = (value: ts.Expression): ts.Expression =>
				ts.isAsExpression(value) ||
				ts.isSatisfiesExpression(value) ||
				ts.isParenthesizedExpression(value)
					? unwrap(value.expression)
					: value;
			const values = (
				expression: ts.Expression,
				seen = new Set<string>(),
			): string[] => {
				const value = unwrap(expression);
				if (ts.isStringLiteralLike(value)) {
					return [value.text];
				}
				if (ts.isIdentifier(value) && !seen.has(value.text)) {
					const bound = bindings.get(value.text);
					return bound
						? values(bound, new Set([...seen, value.text]))
						: [];
				}
				if (ts.isElementAccessExpression(value)) {
					return values(value.expression, seen);
				}
				if (ts.isObjectLiteralExpression(value)) {
					return value.properties.flatMap((prop) =>
						ts.isPropertyAssignment(prop)
							? values(prop.initializer, seen)
							: [],
					);
				}
				if (ts.isConditionalExpression(value)) {
					return [
						...values(value.whenTrue, seen),
						...values(value.whenFalse, seen),
					];
				}
				return [];
			};
			// Properties of an object argument, following identifiers bound to
			// object literals and expanding spreads such as `{ ...subject, outcome }`.
			const properties = (
				expression: ts.Expression | undefined,
				seen = new Set<string>(),
			): ts.ObjectLiteralElementLike[] => {
				let value = expression && unwrap(expression);
				let visited = seen;
				if (value && ts.isIdentifier(value) && !seen.has(value.text)) {
					const bound = bindings.get(value.text);
					visited = new Set([...seen, value.text]);
					value = bound && unwrap(bound);
				}
				if (!value || !ts.isObjectLiteralExpression(value)) {
					return [];
				}
				return value.properties.flatMap((prop) =>
					ts.isSpreadAssignment(prop)
						? properties(prop.expression, visited)
						: [prop],
				);
			};
			const visit = (node: ts.Node) => {
				if (ts.isCallExpression(node)) {
					const name = ts.isIdentifier(node.expression)
						? node.expression.text
						: ts.isPropertyAccessExpression(node.expression)
							? node.expression.name.text
							: "";
					const ratingCall =
						ts.isPropertyAccessExpression(node.expression) &&
						RATING_CALL.test(node.expression.getText());
					if (ratingCall || writers.has(imports.get(name) ?? name)) {
						let parent: ts.Node | undefined = node.parent;
						while (parent && !ts.isFunctionLike(parent)) {
							parent = parent.parent;
						}
						const declaration =
							parent && ts.isFunctionDeclaration(parent)
								? parent
								: parent &&
										ts.isVariableDeclaration(parent.parent)
									? parent.parent
									: undefined;
						const owner =
							declaration?.name &&
							ts.isIdentifier(declaration.name)
								? declaration.name.text
								: undefined;
						if (owner && !writers.has(owner)) {
							writers.add(owner);
							changed = true;
						}
						for (const prop of properties(node.arguments[0])) {
							if (
								!ts.isPropertyAssignment(prop) &&
								!ts.isShorthandPropertyAssignment(prop)
							) {
								continue;
							}
							const key =
								ts.isIdentifier(prop.name) ||
								ts.isStringLiteral(prop.name)
									? prop.name.text
									: "";
							if (key !== "featureKey" && key !== "subjectType") {
								continue;
							}
							for (const literal of values(
								ts.isPropertyAssignment(prop)
									? prop.initializer
									: prop.name,
							)) {
								result[key].add(literal);
							}
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
	}
	return result;
}

function sqlAllowlist(sql: string, column: string) {
	const body =
		sql.match(new RegExp(`NEW\\.${column} IN \\(([^)]+)\\)`))?.[1] ?? "";
	return new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

describe("Decision Replay outcome allowlist drift", () => {
	it("includes literal feature keys and subject types passed through outcome writers", () => {
		const literals = collectLiterals(
			["packages", "apps", "agents"].flatMap((path) =>
				sources(resolve(root, path)),
			),
		);
		expect(literals.featureKey.size).toBeGreaterThanOrEqual(2);
		expect(literals.subjectType.size).toBeGreaterThanOrEqual(10);
		const sql = readFileSync(migration, "utf8");
		for (const [property, column] of [
			["featureKey", "feature_key"],
			["subjectType", "subject_type"],
		] as const) {
			const allowed = sqlAllowlist(sql, column);
			const missing = [...literals[property]].filter(
				(value) => !allowed.has(value),
			);
			expect
				.soft(
					missing,
					`${column} literals missing from the SQL allowlist`,
				)
				.toEqual([]);
		}
	});
	it("includes review and duplicate-resolution capture types", () => {
		const sql = readFileSync(migration, "utf8");
		for (const type of [
			"backlog_proposal_review",
			"backlog_proposal_review_entry",
			"backlog_proposal_duplicate_resolution",
		]) {
			expect(sqlAllowlist(sql, "subject_type").has(type), type).toBe(
				true,
			);
		}
		for (const type of [
			"proposal_reviewed",
			"change_reviewed",
			"change_deduplicated",
		]) {
			expect(sqlAllowlist(sql, "event_type").has(type), type).toBe(true);
		}
	});
});
