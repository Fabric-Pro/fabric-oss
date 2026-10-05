/**
 * Every procedure resolves the caller's PM MCP config through
 * `resolveProjectPmConfig` / `resolveProjectPMConfigForUser` (or
 * `resolvePmTarget`, which uses the latter): they refuse a personal GitLab
 * config on another instance than the project's selected container. A
 * direct `resolvePMConfigForUser(...)` call would skip that check on the MCP
 * branch, so none may appear in this package's source.
 *
 * That check runs before the call; the config can move before the dispatch.
 * So every MCP dispatch a project procedure makes itself is also bound to
 * the container's instance where the client is acquired: `executeMcpTool`
 * with `pmTarget`, a direct client with `expectedGitLabOrigin`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(__dirname, "../../../..");

/** Forward-slashed on every OS, so it compares with the literal paths below. */
function posixRelative(root: string, file: string): string {
	return relative(root, file).split(sep).join("/");
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "__tests__") {
			continue;
		}
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...sourceFiles(path));
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

/** `file:line` of each call, comment lines excluded. */
function directCalls(files: string[], root: string): string[] {
	const hits: string[] = [];
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			const code = line.trim();
			if (code.startsWith("//") || code.startsWith("*")) {
				return;
			}
			if (/\bresolvePMConfigForUser\s*\(/.test(code)) {
				hits.push(`${posixRelative(root, file)}:${index + 1}`);
			}
		});
	}
	return hits;
}

describe("PM config resolution", () => {
	it("never calls resolvePMConfigForUser directly", () => {
		const files = sourceFiles(join(PACKAGE_ROOT, "modules"));
		expect(files.length).toBeGreaterThan(100);
		expect(directCalls(files, PACKAGE_ROOT)).toEqual([]);
	});
});

/** Project procedures that acquire an MCP client for something else. */
const UNBOUND_BY_DESIGN = new Set([
	// GitHub repository picker: a GitHub MCP server, no PM container.
	"modules/projects/procedures/github/list-repos.ts",
]);

/** Each `name({ ...` call's text (the next `window` lines), by file:line. */
function callSites(
	files: string[],
	name: string,
	window: number,
): Array<{ at: string; file: string; text: string }> {
	const sites: Array<{ at: string; file: string; text: string }> = [];
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			if (
				new RegExp(`\\b${name}\\(\\{`).test(line) ||
				(new RegExp(`\\b${name}\\($`).test(line.trim()) &&
					!/function\s/.test(line))
			) {
				const rel = posixRelative(PACKAGE_ROOT, file);
				sites.push({
					at: `${rel}:${index + 1}`,
					file: rel,
					text: lines.slice(index, index + window).join("\n"),
				});
			}
		});
	}
	return sites;
}

describe("PM dispatch from project procedures", () => {
	const files = sourceFiles(join(PACKAGE_ROOT, "modules/projects"));

	it("binds every executeMcpTool call to the container's instance (pmTarget)", () => {
		const sites = callSites(files, "executeMcpTool", 14);
		// import-from-pm, list-project-teams, test-pm-sync (a floor).
		expect(sites.length).toBeGreaterThanOrEqual(3);
		expect(
			sites
				.filter((site) => !/\bpmTarget\s*:/.test(site.text))
				.map((site) => site.at),
		).toEqual([]);
	});

	it("binds every direct MCP client to the container's instance (expectedGitLabOrigin)", () => {
		const sites = [
			...callSites(files, "getCachedMcpClientForConfig", 10),
			...callSites(files, "createMcpClientForConfig", 10),
		].filter((site) => !UNBOUND_BY_DESIGN.has(site.file));
		expect(sites.length).toBeGreaterThanOrEqual(1);
		expect(
			sites
				.filter((site) => !/expectedGitLabOrigin/.test(site.text))
				.map((site) => site.at),
		).toEqual([]);
	});
});
