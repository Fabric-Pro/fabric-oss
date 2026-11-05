/**
 * The workers for these queues have no workflow bundle (`activitiesOnly` in
 * worker.ts), so a workflow started on one would wait forever with nothing red
 * anywhere. Activities may target them; workflow starts may not.
 *
 * Run with: pnpm --filter @repo/temporal test -- activity-only-task-queues
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCANNED = [
	"packages",
	join("apps", "web", "app"),
	join("apps", "web", "modules"),
];
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"__tests__",
	".next",
]);
const WORKFLOWS_DIRECTORY =
	join("packages", "temporal", "src", "workflows") + sep;
const WORKER_FILE = join("packages", "temporal", "src", "worker.ts");

const QUEUE = String.raw`(?:"project-operations"|"project-document-generation"|PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE|PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE)`;
const TARGETS_QUEUE = new RegExp(String.raw`taskQueue\s*:\s*${QUEUE}`);
const CHILD_START = /\b(?:executeChild|startChild)\s*(?:<[^(]*>)?\(/g;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
		}
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
			? [path]
			: [];
	});
}

/** The text of a call, from the character after its opening parenthesis. */
function callArguments(source: string, start: number): string {
	let depth = 1;
	let end = start;
	while (end < source.length && depth > 0) {
		if (source[end] === "(") {
			depth++;
		} else if (source[end] === ")") {
			depth--;
		}
		end++;
	}
	return source.slice(start, end);
}

describe("activity-only task queues", () => {
	const paths = SCANNED.flatMap((directory) =>
		sourceFiles(join(REPO_ROOT, directory)),
	);
	const files = paths.map((path) => ({
		path: relative(REPO_ROOT, path),
		source: readFileSync(path, "utf8"),
	}));
	const workflowFiles = files.filter(({ path }) =>
		path.startsWith(WORKFLOWS_DIRECTORY),
	);

	it("scans the code that starts workflows", () => {
		expect(files.some(({ path }) => path === WORKER_FILE)).toBe(true);
		expect(workflowFiles.length).toBeGreaterThan(50);
	});

	it("are only named as a task queue by workflows, for their activities", () => {
		const elsewhere = files
			.filter(
				({ path, source }) =>
					TARGETS_QUEUE.test(source) &&
					path !== WORKER_FILE &&
					!path.startsWith(WORKFLOWS_DIRECTORY),
			)
			.map(({ path }) => path);

		expect(elsewhere).toEqual([]);
	});

	it("never receive a child workflow", () => {
		const childStarts: string[] = [];
		for (const { path, source } of workflowFiles) {
			for (const match of source.matchAll(CHILD_START)) {
				const start = match.index + match[0].length;
				if (TARGETS_QUEUE.test(callArguments(source, start))) {
					childStarts.push(path);
				}
			}
		}

		expect(childStarts).toEqual([]);
	});
});
