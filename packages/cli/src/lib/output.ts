/**
 * Output formatting for @fabricorg/cli
 *
 * Supports: table (default), json, yaml, csv, quiet (IDs only)
 */

import Table from "cli-table3";
import { getOutputFormat } from "./config.js";

type OutputFormat = "table" | "json" | "yaml" | "csv" | "quiet";

export interface OutputOptions {
	format?: OutputFormat;
	/** Column names to include in table/csv output (in order) */
	columns?: string[];
	/** Key to use for --quiet / IDs-only output */
	idKey?: string;
}

/** Print data to stdout in the selected format. */
export function printOutput(data: unknown, opts: OutputOptions = {}): void {
	const format = opts.format ?? (getOutputFormat() as OutputFormat);

	if (format === "json") {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}

	if (format === "yaml") {
		process.stdout.write(`${toYaml(data)}\n`);
		return;
	}

	if (format === "quiet") {
		const rows = Array.isArray(data) ? data : [data];
		const key = opts.idKey ?? "id";
		for (const row of rows) {
			const val = (row as Record<string, unknown>)[key];
			if (val !== undefined) {
				process.stdout.write(`${String(val)}\n`);
			}
		}
		return;
	}

	if (format === "csv") {
		const rows = Array.isArray(data) ? data : [data];
		if (rows.length === 0) {
			return;
		}
		const cols = opts.columns ?? Object.keys(rows[0] as object);
		process.stdout.write(`${cols.map(csvEscape).join(",")}\n`);
		for (const row of rows) {
			process.stdout.write(
				`${cols
					.map((c) =>
						csvEscape(
							String((row as Record<string, unknown>)[c] ?? ""),
						),
					)
					.join(",")}\n`,
			);
		}
		return;
	}

	// Default: table
	const rows = Array.isArray(data) ? data : [data];
	if (rows.length === 0) {
		process.stdout.write("(no results)\n");
		return;
	}
	const cols = opts.columns ?? Object.keys(rows[0] as object);
	const table = new Table({ head: cols, style: { head: ["cyan"] } });
	for (const row of rows) {
		table.push(
			cols.map((c) => formatCell((row as Record<string, unknown>)[c])),
		);
	}
	process.stdout.write(`${table.toString()}\n`);
}

/** Print a single key-value object as aligned pairs */
export function printRecord(
	data: Record<string, unknown>,
	opts: OutputOptions = {},
): void {
	const format = opts.format ?? (getOutputFormat() as OutputFormat);
	if (format === "json") {
		printOutput(data, opts);
		return;
	}
	if (format === "yaml") {
		printOutput(data, opts);
		return;
	}
	const table = new Table({ style: { head: ["cyan"] } });
	for (const [key, val] of Object.entries(data)) {
		table.push({ [key]: formatCell(val) });
	}
	process.stdout.write(`${table.toString()}\n`);
}

/** Print a success message to stdout */
export function printSuccess(message: string): void {
	process.stdout.write(`✓ ${message}\n`);
}

/** Print an error message to stderr and exit with given code */
export function printError(message: string, exitCode = 1): never {
	process.stderr.write(`✗ ${message}\n`);
	process.exit(exitCode);
}

/** Print a warning to stderr (no exit) */
export function printWarning(message: string): void {
	process.stderr.write(`⚠ ${message}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCell(val: unknown): string {
	if (val === null || val === undefined) {
		return "";
	}
	if (typeof val === "boolean") {
		return val ? "yes" : "no";
	}
	if (typeof val === "object") {
		return JSON.stringify(val);
	}
	const s = String(val);
	// Truncate ISO dates to just the date portion for readability in tables
	if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
		return s.slice(0, 10);
	}
	return s;
}

function csvEscape(s: string): string {
	if (s.includes(",") || s.includes('"') || s.includes("\n")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** Minimal YAML serializer (no dependencies) */
function toYaml(val: unknown, indent = 0): string {
	const pad = "  ".repeat(indent);
	if (val === null || val === undefined) {
		return "~";
	}
	if (typeof val === "boolean" || typeof val === "number") {
		return String(val);
	}
	if (typeof val === "string") {
		if (val.includes("\n") || val.includes(":") || val.includes('"')) {
			return `"${val.replace(/"/g, '\\"')}"`;
		}
		return val;
	}
	if (Array.isArray(val)) {
		if (val.length === 0) {
			return "[]";
		}
		return val
			.map((item) => `${pad}- ${toYaml(item, indent + 1)}`)
			.join("\n");
	}
	if (typeof val === "object") {
		const entries = Object.entries(val as Record<string, unknown>);
		if (entries.length === 0) {
			return "{}";
		}
		return entries
			.map(([k, v]) => {
				const valStr = toYaml(v, indent + 1);
				const isMultiline = valStr.includes("\n");
				return isMultiline
					? `${pad}${k}:\n${valStr}`
					: `${pad}${k}: ${valStr}`;
			})
			.join("\n");
	}
	return String(val);
}
