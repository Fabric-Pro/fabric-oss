#!/usr/bin/env node
import { writeBlockMessage } from "./lib/block-message.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * @param {string} command
 * @returns {string[]}
 */
function extractSqlPayloads(command) {
	const out = [];
	const reShort = /(?:^|\s)-c\s*("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(reShort)) {
		const sql = m[2] ?? m[3] ?? m[4];
		if (sql !== undefined) {
			out.push(sql);
		}
	}
	const reLong = /--command=("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of command.matchAll(reLong)) {
		const sql = m[2] ?? m[3] ?? m[4];
		if (sql !== undefined) {
			out.push(sql);
		}
	}
	return out;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "host.docker.internal"];
const SHARED_MARKERS = ["neon.tech", "staging", "prod", "production"];

/**
 * Pull host information out of a psql invocation. Looks at the
 * positional URL, `-h <host>` / `--host=<host>`, and inline
 * `PGHOST=...` / `DATABASE_URL=...` env-var prefixes.
 *
 * @param {string} command
 * @returns {string[]}    every host-ish string found, in order
 */
function extractHosts(command) {
	const hosts = [];

	const reShortHost = /(?:^|\s)-h\s+(\S+)/g;
	for (const m of command.matchAll(reShortHost)) {
		hosts.push(m[1]);
	}

	const reLongHost = /--host=(\S+)/g;
	for (const m of command.matchAll(reLongHost)) {
		hosts.push(m[1]);
	}

	const reUrl = /postgres(?:ql)?:\/\/[^"'\s]+/g;
	for (const m of command.matchAll(reUrl)) {
		hosts.push(m[0]);
	}

	const reEnvHost = /(?:^|\s)(?:PGHOST|DATABASE_URL)=([^\s"']+)/g;
	for (const m of command.matchAll(reEnvHost)) {
		hosts.push(m[1]);
	}

	return hosts;
}

/**
 * Classify the connection: `"shared"` when ANY extracted host hits one
 * of `SHARED_MARKERS`; `"local"` when only local markers (or no host)
 * are present. Conservative — only the four shared markers from the
 * spec count as shared; everything else (random remote hosts) is
 * treated as local so we never block by accident.
 *
 * @param {string} command
 * @returns {"shared" | "local"}
 */
function classifyConnection(command) {
	const hosts = extractHosts(command);
	if (hosts.length === 0) {
		return "local";
	}

	for (const host of hosts) {
		const lower = host.toLowerCase();
		if (SHARED_MARKERS.some((m) => lower.includes(m))) {
			return "shared";
		}
	}

	// No shared marker hit. If every host we found is explicitly local,
	// stay local; same default for anything we can't classify.
	for (const host of hosts) {
		const lower = host.toLowerCase();
		if (
			!LOCAL_HOSTS.some((local) => lower.includes(local)) &&
			!/^postgres/.test(lower)
		) {
		}
	}
	return "local";
}

const READ_PREFIXES = ["SELECT", "WITH", "EXPLAIN", "SHOW"];

/**
 * @param {string} sql
 */
function isReadOnly(sql) {
	const trimmed = sql.trim();
	if (trimmed.startsWith("\\")) {
		return true; // psql metacommands: \d, \dt, \l, ...
	}
	const upper = trimmed.toUpperCase();
	return READ_PREFIXES.some((p) => upper.startsWith(p));
}

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-shared-env-sql-writes: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command || !/\bpsql\b/.test(command)) {
		process.exit(0);
	}

	if (classifyConnection(command) !== "shared") {
		process.exit(0);
	}

	const payloads = extractSqlPayloads(command);
	if (payloads.length === 0) {
		process.exit(0); // probably `-f file.sql` or interactive
	}

	for (const sql of payloads) {
		if (isReadOnly(sql)) {
			continue;
		}
		writeBlockMessage({
			command,
			reason: "non-SELECT SQL against a shared environment (neon.tech / staging / prod) is blocked",
			sourceRef: "CLAUDE.md (database safety)",
			proceedHint:
				"run against your local Docker postgres, or open a psql session yourself in a terminal " +
				'(temporarily set "disableAllHooks": true in .claude/settings.local.json if you really need this in Claude Code)',
		});
		process.exit(2);
	}

	process.exit(0);
}

main();
