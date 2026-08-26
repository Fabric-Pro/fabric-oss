#!/usr/bin/env node
import { writeBlockMessage } from "./lib/block-message.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * Pull out every `-c "<SQL>"` (or `--command=...`) payload from a psql
 * invocation. Returns the raw SQL strings; quote characters at the
 * boundaries are stripped.
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractSqlPayloads(command) {
	const out = [];
	// -c "..." / -c '...'  (also handles `psql -c"..."` with no space)
	const reShort = /(?:^|\s)-c\s*("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(reShort)) {
		const sql = m[2] ?? m[3] ?? m[4];
		if (sql !== undefined) {
			out.push(sql);
		}
	}
	// --command="..." / --command='...' / --command=...
	const reLong = /--command=("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(reLong)) {
		const sql = m[2] ?? m[3] ?? m[4];
		if (sql !== undefined) {
			out.push(sql);
		}
	}
	return out;
}

/**
 * Inspects a single SQL statement string (already extracted from `-c`).
 * Returns a short reason when the statement is destructive enough to
 * block regardless of environment.
 *
 * @param {string} sql
 * @returns {string | null}
 */
function classify(sql) {
	const normalized = sql.replace(/\s+/g, " ").trim();
	const upper = normalized.toUpperCase();
	if (/\bDROP\s+DATABASE\b/.test(upper)) {
		return "DROP DATABASE is irreversible";
	}
	if (/\bDROP\s+TABLE\b/.test(upper)) {
		return "DROP TABLE is irreversible";
	}
	if (/\bTRUNCATE\b/.test(upper)) {
		return "TRUNCATE empties the table without a WHERE filter";
	}
	if (/\bDELETE\s+FROM\b/.test(upper) && !/\bWHERE\b/.test(upper)) {
		return "`DELETE FROM ... ` without a WHERE clause deletes every row";
	}
	if (/\bUPDATE\b[\s\S]*\bSET\b/.test(upper) && !/\bWHERE\b/.test(upper)) {
		return "`UPDATE ... SET ...` without a WHERE clause rewrites every row";
	}
	return null;
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-destructive-sql: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command) {
		process.exit(0);
	}
	if (!/\bpsql\b/.test(command)) {
		process.exit(0);
	}

	const payloads = extractSqlPayloads(command);
	if (payloads.length === 0) {
		process.exit(0);
	}

	for (const sql of payloads) {
		const reason = classify(sql);
		if (!reason) {
			continue;
		}
		writeBlockMessage({
			command,
			reason: `${reason} — confirmed always-on, including local Docker postgres`,
			sourceRef: "CLAUDE.md (database safety)",
			proceedHint:
				"add an explicit WHERE clause, or run interactively in your own psql session " +
				"(this hook intentionally has no in-band bypass — `disableAllHooks: true` in .claude/settings.local.json for the session)",
		});
		process.exit(2);
	}

	process.exit(0);
}

main();
