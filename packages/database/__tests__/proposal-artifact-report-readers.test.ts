/**
 * Ratchet (Fizzy #2946): the analysis report has one reader and one writer.
 *
 * A Proposal analysis run stores its report in `report` and `reportText`. The
 * report must reach a member only through the Analysis tab's read, so only
 * `getAnalysisReport` (the report module) reads the columns and only the
 * run's completion (`completeAnalysisRun`) writes them. Every other reader of
 * the run table selects its columns explicitly, which is what keeps the
 * report out of the settled-decisions block, a re-run's prompt, the activity
 * result, SSE payloads, audit metadata and logs. A `find*` without a `select`
 * returns every column, and so does reaching a run through a relation, so
 * this test guards those too.
 *
 * Every TypeScript source under `packages/`, `apps/` and `agents/` is
 * scanned (tests, dependencies, generated clients and build output
 * excluded): the agents import `@repo/database` too. Files are read with
 * TypeScript's own parser, so a comment, a type annotation or an unrelated
 * local variable never counts. The rules, and the heuristics behind them:
 *
 * 1. Report columns. A property named `report` or `reportText` counts as
 *    naming a column inside (a) the arguments of a call on a
 *    `projectDocumentAnalysis` delegate (`db.`, `tx.`, `client.` alike), (b)
 *    an object literal typed (`satisfies`, `as` or an annotation) with a
 *    `ProjectDocumentAnalysis*` Prisma type, such as a shared select
 *    constant, or (c) the value of a relation that reaches the run table.
 *    (d) A select held untyped in a variable, in this file or another, is
 *    known by its shape: `reportText: true` counts anywhere (no other model
 *    has the column), and so does `report: true` beside another `true` key
 *    that only the run table has (`proseHash`, `kind`, `sourceRunId` and the
 *    like, read from the schema). A key the run shares with another model
 *    that has a `report` column (`id`, `status`, `errorCode`: a Glossy
 *    build's select) does not count, so `{ id: true, report: true }` alone is
 *    not caught. Nor is a key holding a value rather than `true`: that is a
 *    write payload or a view (the completion's own input normaliser builds
 *    `{ report, reportText }`), caught only when spelled out in a run call.
 *    (e) Raw SQL: in a file that names the `project_document_analysis`
 *    table, any string or template literal holding a quoted `"report"` or
 *    `"reportText"`; and, in any file, a string or template literal that
 *    itself names the table and holds `report` or `reportText` as a bare
 *    word, in any case (Postgres folds an unquoted name to lower case), read
 *    from a template's literal parts only, never its interpolations. A bare
 *    word in a SQL fragment that does not name the table is not caught; one
 *    in a SQL comment of a string that does is, though it reads no column.
 *    Only `getAnalysisReport` in the report module and `completeAnalysisRun`
 *    in the runs module may name the columns; the rest of those two modules
 *    may not. A call that hands `completeAnalysisRun` a `report` is not a
 *    column access and is not caught.
 * 2. Every row-returning call on the run delegate (`find*`, `create`,
 *    `update`, `upsert`, `delete`, `*AndReturn`) passes an inline object
 *    literal with a `select`.
 * 3. The relations that reach the run table are read from `schema.prisma`
 *    (every field typed `ProjectDocumentAnalysis`). None of them is selected
 *    or included outside the `proposal-artifact*` query modules. A relation
 *    name that another model also uses for something else (`analysis`, which
 *    Atlas models use for their own analyses) counts only in a file that
 *    names the model owning the run relation (`projectDocumentFinding`).
 * 4. The run delegate is only ever called: `x.projectDocumentAnalysis` is
 *    read only as the callee's object in `x.projectDocumentAnalysis.method(
 *    ...)`. Assigning, passing, returning or wrapping it, referencing one of
 *    its methods without calling it, reading it by element access
 *    (`x["projectDocumentAnalysis"]`) or destructuring it (`{
 *    projectDocumentAnalysis } = db`) counts, in every file including the
 *    query modules above, since rules 1 and 2 recognise a run call only by
 *    that shape: an alias called with a select held in a variable would pass
 *    them unseen. A type (`typeof db.projectDocumentAnalysis`, `Pick<typeof
 *    db, "projectDocumentAnalysis">`) is not a value and does not count.
 *
 * A violation is a deliberate act: route the read through `getAnalysisReport`
 * or add an explicit `select` without the report columns.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../..");
const SCAN_ROOTS = ["packages", "apps", "agents"];
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	"generated",
	"__tests__",
	"__mocks__",
]);

const REPORT_MODULE =
	"packages/database/prisma/queries/projects/proposal-artifact-report.ts";
const COMPLETION_MODULE =
	"packages/database/prisma/queries/projects/proposal-artifact-runs.ts";
/** The one function in each owning module that may name the columns. */
const REPORT_COLUMN_OWNERS = new Map([
	[REPORT_MODULE, "getAnalysisReport"],
	[COMPLETION_MODULE, "completeAnalysisRun"],
]);
const PROPOSAL_QUERY_MODULE =
	/^packages\/database\/prisma\/queries\/projects\/proposal-artifact[^/]*\.ts$/;

const RUN_MODEL = "ProjectDocumentAnalysis";
const RUN_DELEGATE = "projectDocumentAnalysis";
const RUN_TABLE = "project_document_analysis";
const REPORT_COLUMNS = new Set(["report", "reportText"]);
/** A quoted report column in raw SQL. */
const RAW_REPORT_COLUMN = /"report(Text)?"/;
/** A report column in raw SQL, quoted or not, in any case. */
const RAW_REPORT_WORD = /\breport(text)?\b/i;
/** A select-shaped report key, for {@link mayMatter}. */
const REPORT_SELECT_KEY = /\breport(Text)?["']?\s*:\s*true\b/;
const ROW_RETURNING_METHODS = new Set([
	"findFirst",
	"findFirstOrThrow",
	"findUnique",
	"findUniqueOrThrow",
	"findMany",
	"create",
	"createManyAndReturn",
	"update",
	"updateManyAndReturn",
	"upsert",
	"delete",
]);

// ---------------------------------------------------------------------------
// The relations that reach the run table, and its own columns, from the schema
// ---------------------------------------------------------------------------

interface SchemaField {
	/** The model the field is declared on. */
	owner: string;
	name: string;
	type: string;
}

interface RunRelation {
	name: string;
	/** The model the relation field is declared on. */
	owner: string;
	/** Another model uses the same field name for something else. */
	ambiguous: boolean;
}

function schemaFields(schema: string): SchemaField[] {
	const fields: SchemaField[] = [];
	for (const model of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
		const [, owner = "", body = ""] = model;
		for (const line of body.split("\n")) {
			const field = line.match(/^\s+(\w+)\s+(\w+)/);
			if (field?.[1] && field[2] && !line.trim().startsWith("@@")) {
				fields.push({ owner, name: field[1], type: field[2] });
			}
		}
	}
	return fields;
}

function runRelations(fields: readonly SchemaField[]): RunRelation[] {
	return fields
		.filter((field) => field.type === RUN_MODEL)
		.map((field) => ({
			name: field.name,
			owner: field.owner,
			ambiguous: fields.some(
				(other) =>
					other.name === field.name && other.type !== RUN_MODEL,
			),
		}));
}

/**
 * The run table's fields that no other model with a `report` field has:
 * beside `report: true`, one of them marks a select as the run's.
 */
function runOnlyColumns(fields: readonly SchemaField[]): Set<string> {
	const reportModels = new Set(
		fields
			.filter(
				(field) => field.name === "report" && field.owner !== RUN_MODEL,
			)
			.map((field) => field.owner),
	);
	const shared = new Set(
		fields
			.filter((field) => reportModels.has(field.owner))
			.map((field) => field.name),
	);
	return new Set(
		fields
			.filter(
				(field) =>
					field.owner === RUN_MODEL &&
					!shared.has(field.name) &&
					!REPORT_COLUMNS.has(field.name),
			)
			.map((field) => field.name),
	);
}

const SCHEMA_FIELDS = schemaFields(
	readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8"),
);
const RELATIONS = runRelations(SCHEMA_FIELDS);
const RUN_ONLY_COLUMNS = runOnlyColumns(SCHEMA_FIELDS);

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

interface Violation {
	file: string;
	line: number;
	rule: "report column" | "no select" | "run relation" | "aliased delegate";
	text: string;
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNoSubstitutionTemplateLiteral(name)
	) {
		return name.text;
	}
	return undefined;
}

/** `select` / `include` key of the property assignment holding `object`. */
function holderKey(object: ts.ObjectLiteralExpression): string | undefined {
	const holder = object.parent;
	return holder && ts.isPropertyAssignment(holder)
		? propertyName(holder.name)
		: undefined;
}

/** The delegate method of `x.projectDocumentAnalysis.method(...)`, if any. */
function runDelegateMethod(call: ts.CallExpression): string | undefined {
	const callee = call.expression;
	if (
		ts.isPropertyAccessExpression(callee) &&
		ts.isPropertyAccessExpression(callee.expression) &&
		callee.expression.name.text === RUN_DELEGATE
	) {
		return callee.name.text;
	}
	return undefined;
}

/**
 * Whether `access` (`x.projectDocumentAnalysis`) is the object of a method
 * that is called right there: `x.projectDocumentAnalysis.method(...)`, the
 * only shape {@link runDelegateMethod} recognises.
 */
function isCalledDelegate(access: ts.PropertyAccessExpression): boolean {
	const method = access.parent;
	return (
		ts.isPropertyAccessExpression(method) &&
		method.expression === access &&
		ts.isCallExpression(method.parent) &&
		method.parent.expression === method
	);
}

/** The literal text of a string-keyed element access or binding name. */
function literalKey(node: ts.Node | undefined): string | undefined {
	if (node === undefined) {
		return undefined;
	}
	if (ts.isComputedPropertyName(node)) {
		return literalKey(node.expression);
	}
	if (
		ts.isIdentifier(node) ||
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node)
	) {
		return node.text;
	}
	return undefined;
}

function namesRunType(type: ts.TypeNode | undefined, file: ts.SourceFile) {
	return type?.getText(file).includes(RUN_MODEL) === true;
}

/** A select-shaped property: `key: true`. */
function selectsTrue(
	property: ts.ObjectLiteralElementLike,
): property is ts.PropertyAssignment {
	return (
		ts.isPropertyAssignment(property) &&
		property.initializer.kind === ts.SyntaxKind.TrueKeyword
	);
}

/**
 * Whether `property` is a report column of a run select by its shape alone,
 * wherever the select is held: `reportText: true`, or `report: true` beside
 * a `true` key only the run table has.
 */
function isRunSelectShaped(property: ts.ObjectLiteralElementLike): boolean {
	if (!selectsTrue(property)) {
		return false;
	}
	const name = propertyName(property.name);
	return (
		name === "reportText" ||
		(name === "report" &&
			ts.isObjectLiteralExpression(property.parent) &&
			property.parent.properties.some(
				(sibling) =>
					selectsTrue(sibling) &&
					RUN_ONLY_COLUMNS.has(propertyName(sibling.name) ?? ""),
			))
	);
}

/**
 * Whether a string or template literal is raw SQL naming a report column:
 * quoted, in a file that names the run table; or a bare word, in a literal
 * that names the run table itself. A template's bare words are read from its
 * literal parts only, never its interpolations.
 */
function namesRawReportColumn(
	node:
		| ts.StringLiteral
		| ts.NoSubstitutionTemplateLiteral
		| ts.TemplateExpression,
	file: ts.SourceFile,
	fileNamesRunTable: boolean,
): boolean {
	if (
		fileNamesRunTable &&
		// The SQL text itself: a quoted identifier, not a JS string's quotes.
		RAW_REPORT_COLUMN.test(
			ts.isTemplateExpression(node) ? node.getText(file) : node.text,
		)
	) {
		return true;
	}
	const sql = ts.isTemplateExpression(node)
		? [
				node.head.text,
				...node.templateSpans.map((span) => span.literal.text),
			].join(" ")
		: node.text;
	return sql.includes(RUN_TABLE) && RAW_REPORT_WORD.test(sql);
}

function scanSource(
	path: string,
	text: string,
	options: { allowlists: boolean } = { allowlists: true },
): Violation[] {
	const file = ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		true,
		path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const columnOwner = options.allowlists
		? REPORT_COLUMN_OWNERS.get(path)
		: undefined;
	/** Inside the function of this module allowed to name the columns. */
	const ownsColumns = (node: ts.Node): boolean => {
		if (columnOwner === undefined) {
			return false;
		}
		for (let at: ts.Node | undefined = node; at; at = at.parent) {
			if (ts.isFunctionDeclaration(at) && at.name?.text === columnOwner) {
				return true;
			}
		}
		return false;
	};
	const ownsRelations =
		options.allowlists && PROPOSAL_QUERY_MODULE.test(path);
	const namesRunTable = text.includes(RUN_TABLE);
	const lowerText = text.toLowerCase();
	const relations = new Map(
		RELATIONS.filter(
			(relation) =>
				!relation.ambiguous ||
				lowerText.includes(relation.owner.toLowerCase()),
		).map((relation) => [relation.name, relation]),
	);
	const violations: Violation[] = [];
	const report = (node: ts.Node, rule: Violation["rule"]) => {
		violations.push({
			file: path,
			line:
				file.getLineAndCharacterOfPosition(node.getStart(file)).line +
				1,
			rule,
			text: node.getText(file).slice(0, 120),
		});
	};

	const visit = (node: ts.Node, runContext: boolean): void => {
		let inner = runContext;

		if (ts.isCallExpression(node)) {
			const method = runDelegateMethod(node);
			if (method !== undefined) {
				inner = true;
				if (ROW_RETURNING_METHODS.has(method)) {
					const [args] = node.arguments;
					const hasSelect =
						args !== undefined &&
						ts.isObjectLiteralExpression(args) &&
						args.properties.some(
							(property) =>
								property.name !== undefined &&
								propertyName(property.name) === "select",
						);
					if (!hasSelect) {
						report(node, "no select");
					}
				}
			}
		} else if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === RUN_DELEGATE
		) {
			if (!isCalledDelegate(node)) {
				report(node, "aliased delegate");
			}
		} else if (
			(ts.isElementAccessExpression(node) &&
				literalKey(node.argumentExpression) === RUN_DELEGATE) ||
			(ts.isBindingElement(node) &&
				literalKey(node.propertyName ?? node.name) === RUN_DELEGATE)
		) {
			report(node, "aliased delegate");
		} else if (
			(ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) &&
			namesRunType(node.type, file)
		) {
			inner = true;
		} else if (
			ts.isVariableDeclaration(node) &&
			namesRunType(node.type, file)
		) {
			inner = true;
		} else if (
			ts.isPropertyAssignment(node) ||
			ts.isShorthandPropertyAssignment(node)
		) {
			const name = propertyName(node.name);
			if (
				name !== undefined &&
				REPORT_COLUMNS.has(name) &&
				(runContext || isRunSelectShaped(node)) &&
				!ownsColumns(node)
			) {
				report(node, "report column");
			}
			const parent = node.parent;
			const key = ts.isObjectLiteralExpression(parent)
				? holderKey(parent)
				: undefined;
			if (
				name !== undefined &&
				relations.has(name) &&
				(key === "select" || key === "include")
			) {
				inner = true;
				if (!ownsRelations) {
					report(node, "run relation");
				}
			}
		} else if (
			(ts.isStringLiteral(node) ||
				ts.isNoSubstitutionTemplateLiteral(node) ||
				ts.isTemplateExpression(node)) &&
			namesRawReportColumn(node, file, namesRunTable) &&
			!ownsColumns(node)
		) {
			report(node, "report column");
		}

		ts.forEachChild(node, (child) => visit(child, inner));
	};
	visit(file, false);
	return violations;
}

/** Cheap text test: could this file break any rule at all? */
function mayMatter(text: string): boolean {
	return (
		text.includes(RUN_DELEGATE) ||
		text.includes(RUN_MODEL) ||
		text.includes(RUN_TABLE) ||
		REPORT_SELECT_KEY.test(text) ||
		RELATIONS.some((relation) => text.includes(relation.name))
	);
}

function sourceFiles(directory: string, out: string[] = []): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
			continue;
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			sourceFiles(path, out);
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!/\.d\.ts$/.test(entry.name) &&
			!/\.(test|spec)\.tsx?$/.test(entry.name)
		) {
			out.push(path);
		}
	}
	return out;
}

function repoPath(path: string): string {
	return relative(REPO_ROOT, path).split(sep).join("/");
}

function scanRepository(): {
	scanned: number;
	/** The scan roots at least one scanned file came from. */
	roots: Set<string>;
	violations: Violation[];
} {
	const files = SCAN_ROOTS.flatMap((root) =>
		sourceFiles(join(REPO_ROOT, root)),
	).filter(
		(path) => !repoPath(path).startsWith("packages/database/prisma/zod/"),
	);
	const roots = new Set<string>();
	const violations: Violation[] = [];
	for (const path of files) {
		roots.add(repoPath(path).split("/")[0] ?? "");
		const text = readFileSync(path, "utf8");
		if (mayMatter(text)) {
			violations.push(...scanSource(repoPath(path), text));
		}
	}
	return { scanned: files.length, roots, violations };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the analysis report has one reader and one writer", () => {
	it("the schema still has the run relations this guard checks", () => {
		const names = RELATIONS.map((relation) => relation.name);
		for (const name of ["analyses", "analysis", "sourceRun", "reruns"]) {
			expect(names).toContain(name);
		}
		expect(RELATIONS.find((r) => r.name === "analysis")).toMatchObject({
			owner: "ProjectDocumentFinding",
			ambiguous: true,
		});
		expect(RELATIONS.find((r) => r.name === "analyses")?.ambiguous).toBe(
			false,
		);
		// The columns that mark a `report: true` select as the run's.
		for (const name of ["proseHash", "kind", "sourceRunId", "model"]) {
			expect(RUN_ONLY_COLUMNS).toContain(name);
		}
		for (const name of [
			"id",
			"status",
			"errorCode",
			"report",
			"reportText",
		]) {
			expect(RUN_ONLY_COLUMNS).not.toContain(name);
		}
	});

	describe("the detector", () => {
		const scan = (code: string, path = "packages/api/example.ts") =>
			scanSource(path, code).map((violation) => violation.rule);

		it("sees the report columns in a run read, a run write, a typed select and raw SQL", () => {
			expect(
				scan(
					"db.projectDocumentAnalysis.findFirst({ where: { id }, select: { id: true, report: true } });",
				),
			).toEqual(["report column"]);
			expect(
				scan(
					'tx.projectDocumentAnalysis.updateMany({ where: { id }, data: { "reportText": text } });',
				),
			).toEqual(["report column"]);
			expect(
				scan(
					"const SELECT = { id: true, reportText: true } as const satisfies Prisma.ProjectDocumentAnalysisSelect;",
				),
			).toEqual(["report column"]);
			expect(
				scan(
					`db.$queryRaw\`SELECT "reportText" FROM "project_document_analysis" WHERE "id" = \${id}\`;`,
				),
			).toEqual(["report column"]);
		});

		it("sees a report column in raw SQL on the run table, quoted or not", () => {
			for (const code of [
				// Quoted.
				`db.$executeRaw\`UPDATE "project_document_analysis" SET "report" = NULL WHERE "id" = \${id}\`;`,
				"db.$queryRawUnsafe('SELECT \"reportText\" FROM project_document_analysis');",
				// Unquoted, in any case, in a string or a template.
				`db.$queryRaw\`SELECT "id", report FROM project_document_analysis WHERE "id" = \${id}\`;`,
				'db.$executeRawUnsafe("UPDATE project_document_analysis SET reportText = NULL");',
				"db.$queryRawUnsafe(`SELECT REPORT FROM public.project_document_analysis`);",
				'const sql = "SELECT a.reporttext FROM project_document_analysis a";',
			]) {
				expect(scan(code)).toEqual(["report column"]);
			}
		});

		it("ignores the word report in SQL on another table, an interpolation and a name that only starts with it", () => {
			expect(
				scan(
					[
						`db.$queryRaw\`SELECT "id" FROM "project_document_analysis" WHERE "id" = \${id}\`;`,
						`db.$queryRaw\`SELECT report FROM "glossy_build" WHERE "id" = \${id}\`;`,
						'db.$executeRawUnsafe("UPDATE glossy_build SET report = NULL");',
					].join("\n"),
				),
			).toEqual([]);
			expect(
				scan(
					"db.$queryRaw`SELECT report FROM glossy_build`;\nconst label = 'Analysis report';",
				),
			).toEqual([]);
			expect(
				scan(
					[
						`db.$executeRaw\`UPDATE "project_document_analysis" SET "status" = \${report} WHERE "id" = \${id}\`;`,
						"db.$queryRaw`SELECT report_id, reporting FROM project_document_analysis`;",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("sees a run select held untyped in a variable or another file by its shape", () => {
			// The select in an `as const` variable, handed to a run read.
			expect(
				scan(
					[
						"const RUN_SELECT = { id: true, status: true, reportText: true } as const;",
						"await db.projectDocumentAnalysis.findFirst({ where: { id }, select: RUN_SELECT });",
					].join("\n"),
				),
			).toEqual(["report column"]);
			expect(
				scan(
					[
						"const RUN_SELECT = { id: true, proseHash: true, report: true } as const;",
						"await db.projectDocumentAnalysis.findMany({ where: { documentId }, select: RUN_SELECT });",
					].join("\n"),
				),
			).toEqual(["report column"]);
			// Exported for another file's run read, which names it only.
			expect(
				scan(
					"export const RUN_VIEW = { kind: true, report: true, reportText: true } as const;",
				),
			).toEqual(["report column", "report column"]);
			expect(
				mayMatter(
					"export const RUN_VIEW = { contentHash: true, report: true } as const;",
				),
			).toBe(true);
			expect(
				mayMatter('export const RUN_VIEW = { "reportText": true };'),
			).toBe(true);
		});

		it("does not take another model's select, a write payload or a view for a run select", () => {
			for (const code of [
				// A Glossy build has a report column, and every key here too.
				"db.glossyBuild.findFirst({ where: { id }, select: { id: true, status: true, errorCode: true, report: true } });",
				"const BUILD_SELECT = { id: true, sectionsDone: true, report: true } as const;",
				// A key the run shares with that model is not the run's alone.
				"const SELECT = { id: true, report: true } as const;",
				// The completion's input normaliser, and a log line.
				"function normalize() { return { report: { v: 1, sources: [] }, reportText: text || null }; }",
				'log.info("completed", { report: "stored", reportChars: 0, kind: true });',
				// Not selected.
				"const SELECT = { kind: true, report: false, reportText: false } as const;",
			]) {
				expect(scan(code)).toEqual([]);
			}
		});

		it("sees a run read without a select, including one whose arguments are a variable", () => {
			expect(
				scan(
					"client.projectDocumentAnalysis.findMany({ where: { id } });",
				),
			).toEqual(["no select"]);
			expect(
				scan("db.projectDocumentAnalysis.findUnique(args);"),
			).toEqual(["no select"]);
			expect(
				scan(
					"tx.projectDocumentAnalysis.create({ data: { id }, include: { findings: true } });",
				),
			).toEqual(["no select"]);
		});

		it("sees a run reached through a relation, and the report columns under it", () => {
			expect(
				scan(
					"db.projectDocument.findFirst({ where: { id }, include: { analyses: true } });",
				),
			).toEqual(["run relation"]);
			expect(
				scan(
					"db.projectDocument.findFirst({ select: { analyses: { select: { reportText: true } } } });",
				),
			).toEqual(["run relation", "report column"]);
			expect(
				scan(
					"db.projectDocumentFinding.findMany({ where: { id }, include: { analysis: true } });",
				),
			).toEqual(["run relation"]);
			expect(
				scan(
					"db.projectDocumentAnalysis.findFirst({ where: { id }, select: { sourceRun: { select: { id: true } } } });",
				),
			).toEqual(["run relation"]);
		});

		it("lets the proposal artifact query modules use the relations, and only the two owning functions name the columns", () => {
			const queries =
				"packages/database/prisma/queries/projects/proposal-artifact-rerun.ts";
			expect(
				scan(
					"db.projectDocumentAnalysis.findFirst({ where: { id }, select: { sourceRun: { select: { id: true } } } });",
					queries,
				),
			).toEqual([]);
			expect(
				scan(
					"db.projectDocumentAnalysis.findFirst({ where: { id }, select: { report: true } });",
					queries,
				),
			).toEqual(["report column"]);
			expect(
				scan(
					"export async function getAnalysisReport() { return db.projectDocumentAnalysis.findFirst({ where: { id }, select: { report: true, reportText: true } }); }",
					REPORT_MODULE,
				),
			).toEqual([]);
			expect(
				scan(
					"export async function completeAnalysisRun() { await tx.projectDocumentAnalysis.updateMany({ where: { id }, data: { status: 'COMPLETE', report, reportText } }); }",
					COMPLETION_MODULE,
				),
			).toEqual([]);
			// The owning module, outside its owning function: a shared select.
			expect(
				scan(
					"const ANALYSIS_VIEW_SELECT = { id: true, report: true } as const satisfies Prisma.ProjectDocumentAnalysisSelect;",
					COMPLETION_MODULE,
				),
			).toEqual(["report column"]);
			expect(
				scan(
					"export async function getAnalysisRunInput() { return db.projectDocumentAnalysis.findUnique({ where: { id }, select: { reportText: true } }); }",
					COMPLETION_MODULE,
				),
			).toEqual(["report column"]);
			expect(
				scan(
					"export default function () { return db.projectDocumentAnalysis.findFirst({ where: { id }, select: { report: true } }); }",
					REPORT_MODULE,
				),
			).toEqual(["report column"]);
		});

		it("sees the run delegate aliased instead of called, in any file", () => {
			for (const code of [
				"const runs = db.projectDocumentAnalysis;",
				"await loadRuns(tx.projectDocumentAnalysis);",
				"function delegates() { return { runs: client.projectDocumentAnalysis }; }",
				"const { projectDocumentAnalysis } = db;",
				"const { projectDocumentAnalysis: runs } = tx;",
				"function load({ projectDocumentAnalysis }: ProposalClient) {}",
				"const find = db.projectDocumentAnalysis.findFirst;",
				"const find = db.projectDocumentAnalysis.findFirst.bind(db);",
				"(db.projectDocumentAnalysis as Delegate).findFirst({ where: { id } });",
				'db["projectDocumentAnalysis"].findFirst({ where: { id } });',
				'db.projectDocumentAnalysis["findFirst"]({ where: { id } });',
			]) {
				expect(scan(code)).toEqual(["aliased delegate"]);
			}
			// The bypass this closes: the alias's call, its select held in a
			// variable and shaped like any model's, is seen by no other rule.
			expect(
				scan(
					[
						"const runs = db.projectDocumentAnalysis;",
						"const select = { id: true, report: true };",
						"await runs.findFirst({ where: { id }, select });",
					].join("\n"),
				),
			).toEqual(["aliased delegate"]);
			// The proposal artifact query modules, the owners included, get no
			// exemption: rules 1 and 2 hold there too.
			for (const path of [
				REPORT_MODULE,
				COMPLETION_MODULE,
				"packages/database/prisma/queries/projects/proposal-artifact-rerun.ts",
			]) {
				expect(
					scan(
						"export async function getAnalysisReport() { const runs = db.projectDocumentAnalysis; return runs.findFirst({ where: { id } }); }",
						path,
					),
				).toEqual(["aliased delegate"]);
			}
		});

		it("lets the run delegate be called, and named in a type or a string", () => {
			for (const code of [
				"db.projectDocumentAnalysis.findFirst({ where: { id }, select: { id: true } });",
				"await tx.projectDocumentAnalysis.count({ where: { id } });",
				"client?.projectDocumentAnalysis.updateMany({ where: { id }, data: { status } });",
				"db.projectDocumentAnalysis\n\t.findMany({ where: { id }, select: { id: true } })\n\t.then(rows => rows);",
				"db.projectDocumentAnalysis.findMany<Args>({ where: { id }, select: { id: true } });",
				'export type ProposalClient = Pick<typeof db, "projectDocumentAnalysis">;',
				"type Runs = typeof db.projectDocumentAnalysis;",
				'const model = "projectDocumentAnalysis";',
				"const { projectDocument } = db;",
			]) {
				expect(scan(code)).toEqual([]);
			}
		});

		it("ignores what is not a column access", () => {
			// An Atlas analysis relation, in a file that never names a finding.
			expect(
				scan(
					"db.atlasRepositoryMap.findMany({ include: { analysis: true } });",
				),
			).toEqual([]);
			// A type annotation with the same names.
			expect(
				scan(
					"function show(analysis: { report: string; reportText: string }) {}",
				),
			).toEqual([]);
			// Handing the completion a report, beside a selecting run read.
			expect(
				scan(
					[
						"const owned = await db.projectDocumentAnalysis.findFirst({ where: { id }, select: { id: true } });",
						"const reportText = answer.text;",
						"const report = { text: reportText };",
						"await completeAnalysisRun({ analysisId, findings, report });",
						'log.info("report stored", { report: "stored" });',
					].join("\n"),
				),
			).toEqual([]);
			// A comment, and a plain string even beside raw SQL.
			expect(
				scan(
					'// select: { reportText: true } on projectDocumentAnalysis\nconst label = "reportText";',
				),
			).toEqual([]);
			expect(
				scan(
					'db.$queryRaw`SELECT "id" FROM "project_document_analysis"`;\nconst label = "reportText";',
				),
			).toEqual([]);
		});
	});

	it("both owners exist and the detector sees their column uses", () => {
		for (const owner of REPORT_COLUMN_OWNERS.keys()) {
			const text = readFileSync(join(REPO_ROOT, owner), "utf8");
			expect(
				scanSource(owner, text, { allowlists: false }).filter(
					(violation) => violation.rule === "report column",
				).length,
			).toBeGreaterThan(0);
		}
	});

	it("no other source names the report columns, reads a run without a select, reaches a run through a relation, or aliases the run delegate", () => {
		const { scanned, roots, violations } = scanRepository();
		expect(scanned).toBeGreaterThan(1000);
		// A root moved or renamed would otherwise be skipped in silence.
		expect([...roots].sort()).toEqual([...SCAN_ROOTS].sort());
		expect(
			violations.map(
				(violation) =>
					`${violation.file}:${violation.line} ${violation.rule}: ${violation.text}`,
			),
		).toEqual([]);
	});
});
