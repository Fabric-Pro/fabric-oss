#!/usr/bin/env npx tsx
/**
 * Migration safety linter — expand/contract enforcement.
 *
 * Rolling deploys run the old and new application version against the SAME
 * schema for the length of the rollout, so a migration has to be safe for both.
 * This linter rejects the statement shapes that break that contract, plus the
 * lock hazards that have actually shipped here:
 *
 *   - a non-CONCURRENT index build on a populated table, which takes a write
 *     lock for the length of the build;
 *   - a set-valued UPDATE/DELETE backfill, which holds row locks across the
 *     whole table inside the migration transaction;
 *   - a validating constraint, which scans every existing row under a lock.
 *
 * Table age is computed from migration history rather than a live database:
 * a table CREATEd in the same migration is empty, so indexing or backfilling it
 * is free. Only tables that existed in an earlier migration are guarded.
 *
 * Usage:
 *   pnpm --filter @repo/database lint:migrations
 *   pnpm --filter @repo/database lint:migrations --write-baseline
 *
 * Escape hatch — put a marker comment anywhere in the migration:
 *   -- migration-lint: allow <rule-id> — <reason>
 * The reason is mandatory and is what a reviewer reads, so make it specific.
 *
 * Exception: `pending-validation` does not honor this marker. Its findings come from
 * `lintAll`, outside the per-migration `lintMigration` scope the marker is consulted
 * in — see the note beside where those findings are built, below. This is deliberate,
 * not a gap: a free-text comment reopening a permanent exemption is exactly what the
 * JSON ledger's deadline in prisma/pending-constraint-validations.json exists to close.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = join(__dirname, "../prisma/migrations");
export const BASELINE_PATH = join(__dirname, "../migration-lint-baseline.json");
export const PENDING_VALIDATIONS_PATH = join(
	__dirname,
	"../prisma/pending-constraint-validations.json",
);

export type RuleId =
	| "blocking-index"
	| "unbatched-backfill"
	| "not-null-without-default"
	| "bare-set-not-null"
	| "rename-in-place"
	| "type-change"
	| "unvalidated-constraint"
	| "destructive-without-marker"
	| "pending-validation";

export interface Finding {
	migration: string;
	rule: RuleId;
	line: number;
	statement: string;
	message: string;
}

export const RULE_HELP: Record<RuleId, string> = {
	"blocking-index":
		"CREATE INDEX on a populated table takes a write lock for the whole build, and a plain DROP INDEX takes ACCESS EXCLUSIVE on the table for the whole drop. Use CONCURRENTLY, in a migration whose only statement it is (Prisma does not wrap a single-statement migration in a transaction, and CONCURRENTLY cannot run inside one).",
	"unbatched-backfill":
		"A set-valued UPDATE/DELETE holds row locks across the table inside the migration transaction. Move the backfill to a batched, resumable job that runs after the schema change lands.",
	"not-null-without-default":
		"ADD COLUMN ... NOT NULL without a DEFAULT fails outright on a non-empty table, and breaks the previous app version, which does not write the column. Add it nullable, backfill out of band, then enforce in a later release.",
	"bare-set-not-null":
		"SET NOT NULL scans the whole table under an exclusive lock and breaks the previous app version. Add a CHECK ... NOT VALID, VALIDATE CONSTRAINT, then set NOT NULL in a later release.",
	"rename-in-place":
		"A rename breaks the previous app version the moment it lands. Add the new name, dual-write, backfill, cut reads over, then drop the old name in a later release.",
	"type-change":
		"Most type changes rewrite the table under an exclusive lock and break the previous app version. Add a new column of the new type, backfill, swap, drop the old one later.",
	"unvalidated-constraint":
		"ADD CONSTRAINT ... FOREIGN KEY/CHECK validates against every existing row while holding a lock. Add it NOT VALID, then VALIDATE CONSTRAINT in a separate migration, which takes a weaker lock. PRIMARY KEY and UNIQUE also build an index and cannot be deferred this way — add them in a later release, or on a table this migration creates.",
	"destructive-without-marker":
		"A DROP is a contract-phase change: it is only safe once no running app version reads the object. Confirm the expand release has fully rolled out, then mark it with `-- migration-lint: allow destructive-without-marker — <reason>`.",
	"pending-validation":
		"ADD CONSTRAINT ... NOT VALID leaves every existing row outside the constraint until a VALIDATE CONSTRAINT lands in a LATER release. Declare it in prisma/pending-constraint-validations.json naming the slice that will validate it, and delete that entry in the PR that adds the VALIDATE.",
};

/**
 * Blank out comments and string literals while preserving line structure, so
 * rule matching never fires on prose and line numbers stay meaningful. Prose is
 * a real source of false positives here: migrations in this repo carry long
 * explanatory headers that routinely contain words like "DROP COLUMN".
 */
export function stripSqlNoise(sql: string): string {
	let out = "";
	let i = 0;
	let state: "code" | "line-comment" | "block-comment" | "string" = "code";

	while (i < sql.length) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (state === "code") {
			if (ch === "-" && next === "-") {
				state = "line-comment";
				out += "  ";
				i += 2;
				continue;
			}
			if (ch === "/" && next === "*") {
				state = "block-comment";
				out += "  ";
				i += 2;
				continue;
			}
			if (ch === "'") {
				state = "string";
				out += " ";
				i += 1;
				continue;
			}
			out += ch;
			i += 1;
			continue;
		}

		if (state === "line-comment") {
			if (ch === "\n") {
				state = "code";
				out += "\n";
			} else {
				out += " ";
			}
			i += 1;
			continue;
		}

		if (state === "block-comment") {
			if (ch === "*" && next === "/") {
				state = "code";
				out += "  ";
				i += 2;
				continue;
			}
			out += ch === "\n" ? "\n" : " ";
			i += 1;
			continue;
		}

		// string
		if (ch === "'" && next === "'") {
			out += "  ";
			i += 2;
			continue;
		}
		if (ch === "'") {
			state = "code";
			out += " ";
			i += 1;
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
		i += 1;
	}

	return out;
}

interface Statement {
	text: string;
	line: number;
}

/**
 * Split on top-level `;`, carrying the 1-based line each statement starts on.
 *
 * Dollar-quoted bodies (`DO $$ ... $$`, `$tag$ ... $tag$`) are held together as
 * one statement. This is load-bearing rather than pedantic: migrations here wrap
 * risky DDL in `DO $$ BEGIN ... EXCEPTION ... END $$`, and the block body ends
 * its inner statements with semicolons. Splitting on those produced fragments
 * beginning with `DO`, which no rule matched — so a `SET NOT NULL` inside a DO
 * block passed the linter silently.
 */
export function splitStatements(strippedSql: string): Statement[] {
	const statements: Statement[] = [];
	let buffer = "";
	let line = 1;
	let startLine = 1;
	let depth = 0;
	let dollarTag: string | null = null;

	for (let i = 0; i < strippedSql.length; i++) {
		const ch = strippedSql[i];

		if (ch === "\n") {
			line += 1;
		}

		// Enter or leave a dollar-quoted body. While inside one, nothing else is
		// interpreted — not parens, not semicolons.
		const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
			strippedSql.slice(i),
		);
		if (dollar) {
			const tag = dollar[1] ?? "";
			if (dollarTag === null) {
				dollarTag = tag;
			} else if (dollarTag === tag) {
				dollarTag = null;
			}
			buffer += dollar[0];
			i += dollar[0].length - 1;
			continue;
		}

		if (dollarTag !== null) {
			buffer += ch;
			continue;
		}

		if (ch === "(") {
			depth += 1;
		}
		if (ch === ")") {
			depth = Math.max(0, depth - 1);
		}

		if (ch === ";" && depth === 0) {
			if (buffer.trim()) {
				statements.push({ text: buffer.trim(), line: startLine });
			}
			buffer = "";
			startLine = line;
			continue;
		}

		if (!buffer.trim() && (ch === "\n" || ch === " " || ch === "\t")) {
			// Skip leading whitespace so startLine points at real SQL.
			if (ch === "\n") {
				startLine = line;
			}
			continue;
		}
		buffer += ch;
	}

	if (buffer.trim()) {
		statements.push({ text: buffer.trim(), line: startLine });
	}
	return statements;
}

/**
 * A table reference, capturing the table name and tolerating an optional schema
 * qualifier. Without the qualifier branch, `public."user"` captured `public`,
 * which is never a known table — so every schema-qualified destructive statement
 * read as touching an unknown table and was silently cleared.
 */
const IDENT = `(?:"?[A-Za-z_][A-Za-z0-9_]*"?\\s*\\.\\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?`;

function normalize(statement: string): string {
	return statement.replace(/\s+/g, " ").trim();
}

/**
 * Tables a migration creates are empty for its whole duration.
 *
 * `lintAll` accumulates this across migrations, so a table this misses is missed
 * permanently — every later migration touching it reads as touching a table that
 * never existed, and is cleared. Hence the tolerance for the modifiers Postgres
 * allows between CREATE and TABLE.
 */
export function tablesCreatedIn(strippedSql: string): Set<string> {
	const created = new Set<string>();
	const re = new RegExp(
		`CREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`,
		"gi",
	);
	for (const match of strippedSql.matchAll(re)) {
		created.add(match[1]);
	}
	return created;
}

/**
 * Index names this migration creates, so dropping one it just built is not a
 * contract-phase change and takes no lock anybody else can see. Mirrors
 * `tablesCreatedIn`.
 *
 * Only the NAMED form is tracked. `CREATE INDEX ON t (...)` lets Postgres
 * generate the name, and an index whose name the file does not know cannot be
 * the target of a `DROP INDEX` later in the same file.
 */
export function indexesCreatedIn(strippedSql: string): Set<string> {
	const created = new Set<string>();
	const re =
		/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\b/gi;
	for (const match of strippedSql.matchAll(re)) {
		created.add(match[1]);
	}
	return created;
}

/**
 * `-- migration-lint: allow <rule> — <reason>` suppressions.
 *
 * The whitespace before the separator is load-bearing: without it the rule-id
 * group backtracks and `allow blocking-index` (no reason at all) parses as rule
 * `blocking` with `-index` read as the separator and reason — which would let
 * the escape hatch be used silently, the one thing it must not allow.
 *
 * An unrecognised rule id is dropped rather than trusted, so a typo suppresses
 * nothing instead of appearing to work.
 */
export function parseAllowMarkers(rawSql: string): Set<RuleId> {
	const allowed = new Set<RuleId>();
	const re = /migration-lint:\s*allow\s+([a-z-]+)\s+[-—:]+\s*\S/gi;
	for (const match of rawSql.matchAll(re)) {
		const rule = match[1] as RuleId;
		if (rule in RULE_HELP) {
			allowed.add(rule);
		}
	}
	return allowed;
}

export type CommandKind =
	| "alter-table"
	| "create-index"
	| "drop-index"
	| "update"
	| "delete"
	| "insert"
	| "drop-table"
	| "truncate";

export interface Command {
	kind: CommandKind;
	/**
	 * Every table this command targets. Usually one, but `DROP TABLE a, b;` and
	 * `TRUNCATE a, b;` are valid Postgres and name several — and reading only the
	 * first silently cleared a destructive statement whose dangerous target
	 * happened not to be written first.
	 *
	 * `drop-index` is the exception: it names an INDEX, and that name lands in
	 * `tables[0]`. `DROP INDEX` does not mention its table at all, which is
	 * precisely why the pre-existing-table gate in `lintMigration` cannot judge
	 * it and it is handled before that gate.
	 */
	tables: string[];
	/** This command's own text, ending where the next command begins. */
	text: string;
}

/** Tables named after the first in a comma-separated target list. */
function trailingTables(commandText: string, firstTableEnd: number): string[] {
	const rest = commandText.slice(firstTableEnd);
	const list =
		/^(\s*,\s*(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?[A-Za-z_][A-Za-z0-9_]*"?)+/.exec(
			rest,
		);
	if (!list) {
		return [];
	}
	return [...list[0].matchAll(new RegExp(`,\\s*${IDENT}`, "g"))].map(
		(match) => match[1],
	);
}

const COMMAND_PATTERNS: ReadonlyArray<[CommandKind, string]> = [
	["alter-table", `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${IDENT}`],
	[
		"create-index",
		`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?[A-Za-z_][A-Za-z0-9_]*"?\\s+)?ON\\s+(?:ONLY\\s+)?${IDENT}`,
	],
	[
		"drop-index",
		`DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`,
	],
	["update", `UPDATE\\s+(?:ONLY\\s+)?${IDENT}`],
	["delete", `DELETE\\s+FROM\\s+(?:ONLY\\s+)?${IDENT}`],
	["insert", `INSERT\\s+INTO\\s+${IDENT}`],
	["drop-table", `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`],
	["truncate", `TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?${IDENT}`],
];

/**
 * Every command in a statement, each bounded by where the next one starts.
 *
 * A statement is not always one command. A `DO $$ ... $$` body carries several,
 * and so does a chain of ALTERs the splitter kept together. Bounding each command
 * matters for more than tidiness: rules that ask "does this have a WHERE clause?"
 * used to scan to the end of the whole statement, so an unqualified
 * `UPDATE ... ;` was cleared by a *different* command's WHERE further down, and a
 * plain literal INSERT was flagged because an unrelated SELECT appeared later.
 */
export function splitCommands(normalizedSql: string): Command[] {
	const found: Array<{ kind: CommandKind; tables: string[]; index: number }> =
		[];

	for (const [kind, pattern] of COMMAND_PATTERNS) {
		for (const match of normalizedSql.matchAll(new RegExp(pattern, "gi"))) {
			const index = match.index ?? 0;
			// TRUNCATE, DROP TABLE and DROP INDEX take a target list. A comma
			// after any other command begins a column or expression, not another
			// target. (`DROP INDEX a, b;` is valid Postgres — CONCURRENTLY is
			// what restricts a drop to a single index, not the statement.)
			const tables =
				kind === "truncate" ||
				kind === "drop-table" ||
				kind === "drop-index"
					? [
							match[1],
							...trailingTables(
								normalizedSql,
								index + match[0].length,
							),
						]
					: [match[1]];
			found.push({ kind, tables, index });
		}
	}

	found.sort((a, b) => a.index - b.index);

	return found.map((command, i) => {
		// A command ends at whichever comes first: the next command, or its own
		// terminating `;`. The semicolon matters inside a DO block, where the body
		// holds several statements and a trailing clause that starts with no
		// keyword this function recognises — `PERFORM 1 FROM (SELECT 1)` — would
		// otherwise be read as part of the command before it.
		const nextCommand = found[i + 1]?.index ?? normalizedSql.length;
		const semicolon = normalizedSql.indexOf(";", command.index);
		const end =
			semicolon === -1 ? nextCommand : Math.min(nextCommand, semicolon);

		return {
			kind: command.kind,
			tables: command.tables,
			text: normalizedSql.slice(command.index, end),
		};
	});
}

export interface LintInput {
	migration: string;
	sql: string;
	/** Tables that existed before this migration ran. */
	preExistingTables: ReadonlySet<string>;
}

export function lintMigration({
	migration,
	sql,
	preExistingTables,
}: LintInput): Finding[] {
	const stripped = stripSqlNoise(sql);
	const allowed = parseAllowMarkers(sql);
	const createdHere = tablesCreatedIn(stripped);
	const indexesCreatedHere = indexesCreatedIn(stripped);
	const findings: Finding[] = [];

	const isPreExisting = (table: string | undefined): boolean =>
		table !== undefined &&
		!createdHere.has(table) &&
		preExistingTables.has(table);

	for (const statement of splitStatements(stripped)) {
		// One finding per rule per statement — a DO block that alters the same
		// table twice is one thing to fix, not two.
		const seen = new Set<RuleId>();
		const reportOnce = (rule: RuleId) => {
			if (allowed.has(rule) || seen.has(rule)) {
				return;
			}
			seen.add(rule);
			findings.push({
				migration,
				rule,
				line: statement.line,
				statement: normalize(statement.text).slice(0, 160),
				message: RULE_HELP[rule],
			});
		};

		for (const command of splitCommands(normalize(statement.text))) {
			// Handled BEFORE the gate below, not inside the switch: that gate
			// asks whether the command names a pre-existing TABLE, and a
			// `DROP INDEX` names no table at all. It fell straight through,
			// which is why this rule was missing until now.
			if (command.kind === "drop-index") {
				// `some`, not `[0]`: the statement is contract-phase if ANY of
				// its targets outlived this migration. Reading only the first
				// name clears `DROP INDEX "built_here", "old_one";`.
				const dropsSomethingOlder = command.tables.some(
					(name) => !indexesCreatedHere.has(name),
				);
				if (dropsSomethingOlder) {
					// Same hazard as a blocking build: without CONCURRENTLY the
					// drop takes ACCESS EXCLUSIVE on the table for its duration.
					if (!/\bCONCURRENTLY\b/i.test(command.text)) {
						reportOnce("blocking-index");
					}
					// CONCURRENTLY does not answer this one. The object is gone
					// either way; whether that is safe depends on the rollout.
					reportOnce("destructive-without-marker");
				}
				continue;
			}
			if (!command.tables.some(isPreExisting)) {
				continue;
			}
			const body = command.text;

			switch (command.kind) {
				case "create-index":
					if (!/\bCONCURRENTLY\b/i.test(body)) {
						reportOnce("blocking-index");
					}
					break;

				case "update":
				case "delete": {
					// Set-valued: no WHERE at all, an UPDATE ... FROM, or a
					// subquery-driven predicate. A single-row write keyed by a
					// literal is bounded and stays clean.
					const hasWhere = /\bWHERE\b/i.test(body);
					if (
						!hasWhere ||
						/\bFROM\s*\(/i.test(body) ||
						/\bWHERE\b[\s\S]*\bSELECT\b/i.test(body)
					) {
						reportOnce("unbatched-backfill");
					}
					break;
				}

				case "insert":
					// INSERT ... SELECT copies a whole result set; INSERT ... VALUES
					// is bounded by what is written out.
					if (/\bSELECT\b/i.test(body)) {
						reportOnce("unbatched-backfill");
					}
					break;

				case "truncate":
				case "drop-table":
					reportOnce("destructive-without-marker");
					break;

				case "alter-table": {
					// DEFAULT is checked per added column, not once for the whole
					// clause: `ADD COLUMN a NOT NULL, ADD COLUMN b NOT NULL DEFAULT x`
					// would otherwise clear column `a` on the strength of `b`.
					for (const added of body.matchAll(
						/\bADD\s+COLUMN\b(.*?)(?=,\s*(?:ADD|ALTER|DROP|RENAME)\b|$)/gi,
					)) {
						const definition = added[1];
						if (
							/\bNOT\s+NULL\b/i.test(definition) &&
							!/\bDEFAULT\b/i.test(definition)
						) {
							reportOnce("not-null-without-default");
						}
					}
					if (
						/\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i.test(
							body,
						)
					) {
						reportOnce("bare-set-not-null");
					}
					if (/\bRENAME\b/i.test(body)) {
						reportOnce("rename-in-place");
					}
					if (/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i.test(body)) {
						reportOnce("type-change");
					}
					if (/\bDROP\s+COLUMN\b/i.test(body)) {
						reportOnce("destructive-without-marker");
					}
					// A validating constraint scans the whole existing table under a
					// lock. PRIMARY KEY and UNIQUE additionally build an index, and
					// neither accepts NOT VALID, so they are always contract-phase.
					for (const constraint of body.matchAll(
						/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(FOREIGN\s+KEY|CHECK|PRIMARY\s+KEY|UNIQUE)\b(.*?)(?=,\s*(?:ADD|ALTER|DROP|RENAME)\b|$)/gi,
					)) {
						const kind = constraint[1];
						const rest = constraint[2];
						// `USING INDEX` adopts an index that already exists — it
						// neither builds nor scans. Otherwise only FOREIGN KEY and
						// CHECK can be deferred with NOT VALID; PRIMARY KEY and
						// UNIQUE build an index and never can.
						const buildsAnIndex =
							/\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(kind);
						const isSafe =
							/\bUSING\s+INDEX\b/i.test(rest) ||
							(!buildsAnIndex && /\bNOT\s+VALID\b/i.test(rest));
						if (!isSafe) {
							reportOnce("unvalidated-constraint");
						}
					}
					break;
				}

				default: {
					// A new CommandKind must decide what it means for safety.
					const exhaustive: never = command.kind;
					throw new Error(
						`unhandled command kind: ${String(exhaustive)}`,
					);
				}
			}
		}
	}

	return findings;
}

/** Where a constraint name shows up: a `NOT VALID` addition or a `VALIDATE CONSTRAINT`. */
export type ConstraintSite = { constraint: string; migration: string };

/**
 * Bounded the same way as the `not-null-without-default` and
 * `unvalidated-constraint` clauses of `lintMigration`'s `alter-table` case: the
 * lookahead stops at the next ALTER-TABLE-level clause, or the end of the
 * command. (Named rather than cited by line — the numbers that used to be here
 * were already wrong when they landed, and a line number is stale the next time
 * anyone edits above it.) This used to be
 * `\bADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?[\s\S]*?\bNOT\s+VALID\b`, scanned
 * over a whole migration file — which let an earlier, unrelated `ADD
 * CONSTRAINT` claim a *later* statement's `NOT VALID`, and never captured the
 * real site because it fell inside that first match's span. Same bug class,
 * same fix: bound the match to the command it belongs to.
 */
const ADD_CONSTRAINT_RE =
	/\bADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\b(.*?)(?=,\s*(?:ADD|ALTER|DROP|RENAME)\b|$)/gi;
const VALIDATE_RE = /\bVALIDATE\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?/gi;

/**
 * Every `ADD CONSTRAINT <name> ... NOT VALID` in a migration's stripped SQL.
 *
 * Scanned per ALTER TABLE command, not over the whole file's text — the same
 * reason every rule in `lintMigration` scans per command rather than per
 * statement or per file: a match that reads forward past its own command's
 * end reads a *different* command's clauses as its own.
 */
export function findNotValidConstraints(strippedSql: string): string[] {
	const names: string[] = [];
	for (const statement of splitStatements(strippedSql)) {
		for (const command of splitCommands(normalize(statement.text))) {
			if (command.kind !== "alter-table") {
				continue;
			}
			for (const match of command.text.matchAll(ADD_CONSTRAINT_RE)) {
				if (/\bNOT\s+VALID\b/i.test(match[2])) {
					names.push(match[1]);
				}
			}
		}
	}
	return names;
}

/** Every `VALIDATE CONSTRAINT <name>` in a migration's stripped SQL. */
export function findValidatedConstraints(strippedSql: string): string[] {
	return [...strippedSql.matchAll(VALIDATE_RE)].map((match) => match[1]);
}

/**
 * A pure core over already-parsed sites, so this is testable without touching the
 * filesystem or a real migrations directory.
 *
 * A `NOT VALID` constraint with no later `VALIDATE CONSTRAINT` is only safe when it
 * is declared in the checked-in exceptions ledger with a deadline that has not yet
 * passed — an entry with no deadline, or one that never expires, is a permanent
 * exemption, which is the exact failure this rule exists to prevent.
 */
export function findPendingValidationViolations(input: {
	notValid: ConstraintSite[];
	validated: ConstraintSite[];
	declared: { constraint: string; validateBy: string }[];
	today: string; // ISO date, injected so the rule is deterministic under test
}): string[] {
	const { notValid, validated, declared, today } = input;
	const declaredByName = new Map(declared.map((d) => [d.constraint, d]));
	const declaredNames = new Set(declaredByName.keys());
	const validatedByName = new Map(validated.map((v) => [v.constraint, v]));
	const violations: string[] = [];

	for (const site of notValid) {
		const done = validatedByName.get(site.constraint);
		if (done) {
			// A VALIDATE that sorts BEFORE its own NOT VALID validates nothing: the
			// constraint did not exist yet when it ran.
			if (done.migration <= site.migration) {
				violations.push(
					`${site.constraint}: VALIDATE CONSTRAINT in ${done.migration} runs before the NOT VALID in ${site.migration}`,
				);
				continue;
			}
			if (declaredNames.has(site.constraint)) {
				violations.push(
					`${site.constraint}: already validated in ${done.migration}, but still declared pending — delete the entry`,
				);
			}
			continue;
		}
		if (!declaredNames.has(site.constraint)) {
			violations.push(
				`${site.constraint}: added NOT VALID in ${site.migration} with no VALIDATE and no entry in prisma/pending-constraint-validations.json`,
			);
			continue;
		}
		// The deadline is what turns a declaration into an obligation. Without it, an entry is a
		// permanent exemption and historical rows stay outside the constraint forever — so an
		// absent, empty or malformed value is a violation in its own right, not a reason to skip
		// the check. A rule that silently ignores what it cannot parse is the exemption it was
		// written to remove.
		//
		// The round-trip is not belt-and-braces: a shape check alone accepts 2026-02-29, which
		// Date.parse silently normalizes to March 1 — an impossible date that would pass and quietly
		// buy an extra day. Requiring the parse to reproduce the input rejects every non-calendar
		// date without a month-length table.
		const deadline = declaredByName.get(site.constraint)?.validateBy ?? "";
		const roundTrip = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
			? new Date(`${deadline}T00:00:00Z`)
			: null;
		if (
			roundTrip === null ||
			Number.isNaN(roundTrip.getTime()) ||
			roundTrip.toISOString().slice(0, 10) !== deadline
		) {
			violations.push(
				`${site.constraint}: declared pending with an unusable validateBy (${JSON.stringify(deadline)}) — use a canonical YYYY-MM-DD date`,
			);
			continue;
		}
		if (deadline < today) {
			violations.push(
				`${site.constraint}: declared pending until ${deadline}, which has passed — add a migration with VALIDATE CONSTRAINT "${site.constraint}" and delete the entry`,
			);
		}
	}

	return violations;
}

export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

/**
 * Lint every migration not in `baseline`, accumulating table history across the
 * full ordered set so a new migration knows which tables predate it.
 */
export function lintAll(
	dir: string = MIGRATIONS_DIR,
	baseline: ReadonlySet<string> = new Set(),
	pendingValidations: PendingValidationEntry[] = readPendingValidations(),
): Finding[] {
	const findings: Finding[] = [];
	const seenTables = new Set<string>();
	// Collected across EVERY migration, baselined or not: a `NOT VALID`
	// constraint owes a `VALIDATE` (or a declared, undischarged exception)
	// regardless of whether it predates this linter.
	const notValidSites: ConstraintSite[] = [];
	const validatedSites: ConstraintSite[] = [];

	for (const migration of listMigrations(dir)) {
		let sql: string;
		try {
			sql = readFileSync(join(dir, migration, "migration.sql"), "utf-8");
		} catch {
			continue;
		}

		if (!baseline.has(migration)) {
			findings.push(
				...lintMigration({
					migration,
					sql,
					preExistingTables: seenTables,
				}),
			);
		}

		const stripped = stripSqlNoise(sql);

		for (const constraint of findNotValidConstraints(stripped)) {
			notValidSites.push({ constraint, migration });
		}
		for (const constraint of findValidatedConstraints(stripped)) {
			validatedSites.push({ constraint, migration });
		}

		for (const table of tablesCreatedIn(stripped)) {
			seenTables.add(table);
		}
	}

	// Unlike every other rule, this one is never checked against `parseAllowMarkers`'s
	// `allowed` set — that set is per-migration and scoped to `lintMigration`, while a
	// pending-validation violation can span migrations (the NOT VALID and its declaration
	// are read from two different files) and is computed here instead. A migration carrying
	// `-- migration-lint: allow pending-validation — <reason>` parses as a recognised marker
	// (it is in RULE_HELP) but has no effect on this loop. That is intentional: honoring a
	// free-text comment here would let it stand in for the JSON ledger's deadline, i.e.
	// reopen the permanent-exemption hole that ledger exists to close. The only way to
	// silence this rule is a dated entry in prisma/pending-constraint-validations.json.
	const today = new Date().toISOString().slice(0, 10);
	for (const violation of findPendingValidationViolations({
		notValid: notValidSites,
		validated: validatedSites,
		declared: pendingValidations,
		today,
	})) {
		// Every violation message is generated as `${site.constraint}: ...`, so the
		// constraint name up to the first colon recovers which NOT VALID site it is
		// about, and with it the migration to attribute the finding to.
		const constraintName = violation.slice(0, violation.indexOf(":"));
		const site = notValidSites.find((s) => s.constraint === constraintName);
		findings.push({
			migration:
				site?.migration ?? "prisma/pending-constraint-validations.json",
			rule: "pending-validation",
			line: 0,
			statement: violation,
			message: RULE_HELP["pending-validation"],
		});
	}

	return findings;
}

export function readBaseline(path: string = BASELINE_PATH): Set<string> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			migrations?: string[];
		};
		return new Set(parsed.migrations ?? []);
	} catch {
		return new Set();
	}
}

export interface PendingValidationEntry {
	constraint: string;
	validateBy: string;
}

/** The declared ledger of `NOT VALID` constraints awaiting a later `VALIDATE`. */
export function readPendingValidations(
	path: string = PENDING_VALIDATIONS_PATH,
): PendingValidationEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			pending?: PendingValidationEntry[];
		};
		return parsed.pending ?? [];
	} catch {
		return [];
	}
}

function main(): void {
	const writeBaseline = process.argv.includes("--write-baseline");

	if (writeBaseline) {
		const migrations = listMigrations();
		writeFileSync(
			BASELINE_PATH,
			`${JSON.stringify(
				{
					note: "Migrations that predate the expand/contract linter. Never add to this list — new migrations must pass the rules or carry an explicit `-- migration-lint: allow <rule> — <reason>` marker.",
					migrations,
				},
				null,
				"\t",
			)}\n`,
		);
		console.log(
			`Baseline written: ${migrations.length} migrations grandfathered.`,
		);
		return;
	}

	const baseline = readBaseline();
	const findings = lintAll(MIGRATIONS_DIR, baseline);

	if (findings.length === 0) {
		const linted = listMigrations().filter((m) => !baseline.has(m)).length;
		console.log(
			`Migration lint passed — ${linted} migration(s) checked, ${baseline.size} grandfathered.`,
		);
		return;
	}

	console.error(`\nMigration lint failed — ${findings.length} finding(s):\n`);
	for (const finding of findings) {
		console.error(
			`  ${finding.migration}/migration.sql:${finding.line}  [${finding.rule}]`,
		);
		console.error(`    ${finding.statement}`);
		console.error(`    ${finding.message}\n`);
	}
	console.error(
		"If a finding is genuinely safe, add `-- migration-lint: allow <rule-id> — <reason>` to the migration.\n",
	);
	process.exit(1);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
