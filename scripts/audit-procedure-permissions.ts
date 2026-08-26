#!/usr/bin/env tsx
/**
 * Audit every oRPC procedure in `packages/api/modules/**` to find procedures
 * that do NOT declare a permission via `requirePermission` or
 * `requireProjectPermission`.
 *
 * Usage:
 *   pnpm tsx scripts/audit-procedure-permissions.ts
 *
 * Options:
 *   --csv        Output CSV to /tmp/procedure-audit.csv (in addition to stdout)
 *   --quiet      Only print the summary line
 *   --exit-code  Exit 1 if any procedures are missing a permission declaration
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function findProcedureFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) {
			continue;
		}
		if (!entry.name.endsWith(".ts")) {
			continue;
		}
		if (entry.name.endsWith(".test.ts")) {
			continue;
		}
		const parentPath = (entry as unknown as { parentPath?: string })
			.parentPath;
		const dir = parentPath ?? entry.path ?? "";
		if (dir.includes(`${sep}__tests__${sep}`)) {
			continue;
		}
		if (
			!dir.includes(`${sep}procedures${sep}`) &&
			!dir.endsWith("procedures")
		) {
			continue;
		}
		out.push(resolve(dir, entry.name));
	}
	return out;
}

type Row = {
	file: string;
	module: string;
	procedureCount: number;
	hasPermissionDecorator: boolean;
};

const modulesRoot = resolve(repoRoot, "packages/api/modules");
const absoluteFiles = findProcedureFiles(modulesRoot);

const rows: Row[] = [];

for (const absFile of absoluteFiles) {
	const file = relative(repoRoot, absFile);
	const content = readFileSync(absFile, "utf-8");

	// Count .handler( occurrences as a proxy for "number of procedures in this file"
	const handlerMatches = content.match(/\.handler\s*\(/g);
	const procedureCount = handlerMatches?.length ?? 0;
	if (procedureCount === 0) {
		continue;
	}

	// Detect a permission decorator anywhere in the file.
	const hasPermissionDecorator =
		/requirePermission\s*\(|requireProjectPermission\s*\(/.test(content);

	// Best-effort module attribution from the path.
	const relPath = file.replace(/^packages\/api\/modules\//, "");
	const module = relPath.split("/procedures/")[0] ?? relPath;

	rows.push({
		file,
		module,
		procedureCount,
		hasPermissionDecorator,
	});
}

const totalFiles = rows.length;
const totalProcedures = rows.reduce((sum, r) => sum + r.procedureCount, 0);
const filesWithPermission = rows.filter((r) => r.hasPermissionDecorator).length;
const filesMissingPermission = rows.filter((r) => !r.hasPermissionDecorator);
const proceduresMissingPermission = filesMissingPermission.reduce(
	(sum, r) => sum + r.procedureCount,
	0,
);

const quiet = process.argv.includes("--quiet");
const csv = process.argv.includes("--csv");
const exitCode = process.argv.includes("--exit-code");

if (!quiet) {
	// Group missing by module.
	const byModule = new Map<
		string,
		{ files: string[]; procedureCount: number }
	>();
	for (const r of filesMissingPermission) {
		const entry = byModule.get(r.module) ?? {
			files: [],
			procedureCount: 0,
		};
		entry.files.push(r.file);
		entry.procedureCount += r.procedureCount;
		byModule.set(r.module, entry);
	}

	const sortedModules = Array.from(byModule.entries()).sort(
		(a, b) => b[1].procedureCount - a[1].procedureCount,
	);

	if (sortedModules.length > 0) {
		console.log("\nProcedures missing permission checks by module:\n");
		for (const [module, entry] of sortedModules) {
			console.log(
				`  ${module.padEnd(50)} ${entry.procedureCount.toString().padStart(4)} proc  (${entry.files.length} files)`,
			);
		}
	}
}

console.log("\n==========  SUMMARY  ==========");
console.log(`Total procedure files:       ${totalFiles}`);
console.log(`Total procedures:            ${totalProcedures}`);
console.log(`Files WITH permission:       ${filesWithPermission}`);
console.log(`Files MISSING permission:    ${filesMissingPermission.length}`);
console.log(`Procedures MISSING:          ${proceduresMissingPermission}`);
const coverage =
	totalProcedures === 0
		? 100
		: ((totalProcedures - proceduresMissingPermission) / totalProcedures) *
			100;
console.log(`Coverage:                    ${coverage.toFixed(1)}%`);
console.log("================================\n");

if (csv) {
	const csvLines = [
		"file,module,procedure_count,has_permission",
		...rows.map(
			(r) =>
				`${r.file},${r.module},${r.procedureCount},${r.hasPermissionDecorator}`,
		),
	];
	writeFileSync("/tmp/procedure-audit.csv", csvLines.join("\n"));
	console.log("Wrote /tmp/procedure-audit.csv");
}

if (exitCode && proceduresMissingPermission > 0) {
	process.exit(1);
}
