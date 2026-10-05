/**
 * Source guards for the GitLab PM container's instance (see
 * `recordedGitLabPmOrigin`), so a new call site cannot quietly skip it:
 *
 *   - the worker resolves a caller's PM MCP config only through
 *     `resolveProjectPMConfigForUser` (it refuses a personal GitLab config
 *     on another instance than the container), never through
 *     `resolvePMConfigForUser` directly;
 *   - every PM dispatch is bound to the container's instance where the tool
 *     runs: each `executeMcpTool` call in the PM activities and in the
 *     workflows that dispatch PM tools themselves passes `pmTarget`, and each
 *     direct MCP client acquisition there passes `expectedGitLabOrigin`.
 *     Checking the config before the call is not enough: it can move between
 *     the check and the dispatch, and a replayed preflight is never re-run.
 *
 * A call that never carries a GitLab PM container is listed below with the
 * reason, by the function it is in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "__tests__" || name === "node_modules") {
			continue;
		}
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...sourceFiles(path));
		} else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

function codeLines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => !line.startsWith("//") && !line.startsWith("*"));
}

type Call = { file: string; line: number; fn: string; args: string };

/**
 * Each `name({ ... })` call in `source`: its line, the function it is in,
 * and its argument object (braces matched, so nested objects are included).
 */
function callsOf(file: string, name: string): Call[] {
	const source = readFileSync(file, "utf8");
	const calls: Call[] = [];
	const pattern = new RegExp(`\\b${name}\\(\\s*\\{`, "g");
	for (const match of source.matchAll(pattern)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		let depth = 0;
		let end = open;
		for (let i = open; i < source.length; i++) {
			if (source[i] === "{") {
				depth++;
			} else if (source[i] === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		const before = source.slice(0, match.index);
		const fns = [
			...before.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
		];
		calls.push({
			file: relative(SRC, file),
			line: before.split("\n").length,
			fn: fns.at(-1)?.[1] ?? "(module)",
			args: source.slice(open, end + 1),
		});
	}
	return calls;
}

/** PM dispatches that never carry a GitLab PM container. */
const UNBOUND_BY_DESIGN: Record<string, string> = {
	"story-sync.ts#resolveAdoBacklogId": "Azure DevOps backlog lookup",
	"story-sync.ts#fetchAdoStateCategoryMap": "Azure DevOps state categories",
	"fetch-pm-hierarchy.ts#resolveAdoDefaultTeam": "Azure DevOps team lookup",
	"fetch-pm-hierarchy.ts#resolveAtlassianCloudId": "Jira site lookup",
	"fetch-pm-hierarchy.ts#resolveJiraDefaultIssueType": "Jira issue types",
	"fetch-pm-hierarchy.ts#fetchAdoBacklogs": "Azure DevOps backlogs",
	"fetch-pm-hierarchy.ts#enrichAdoWorkItems": "Azure DevOps work items",
	"enumerate-pm-fields.ts#enumeratePmFields":
		"Azure DevOps only (gated before dispatch)",
	"fizzy-account-slug.ts#resolveFizzyAccountSlug": "Fizzy account lookup",
};

const PM_DISPATCH_FILES = [
	...sourceFiles(join(SRC, "activities/pm-integration")),
	join(SRC, "workflows/story-sync-workflow.ts"),
	join(SRC, "workflows/test-case-sync-workflow.ts"),
];

describe("GitLab PM instance guards", () => {
	it("never resolves a PM config with resolvePMConfigForUser directly", () => {
		const files = sourceFiles(SRC);
		expect(files.length).toBeGreaterThan(100);
		const hits = files.filter((file) =>
			codeLines(file).some((line) =>
				/\bresolvePMConfigForUser\s*\(/.test(line),
			),
		);
		expect(hits.map((file) => relative(SRC, file))).toEqual([]);
	});

	it("binds every PM executeMcpTool dispatch to the container's instance (pmTarget)", () => {
		const calls = PM_DISPATCH_FILES.flatMap((file) =>
			callsOf(file, "executeMcpTool"),
		);
		// The story/test-case workflows, story sync, hierarchy sync, ticket
		// and comment reads, field previews... (a floor, not a count).
		expect(calls.length).toBeGreaterThanOrEqual(30);
		const unbound = calls
			.filter((call) => !/\bpmTarget\s*:/.test(call.args))
			.filter(
				(call) =>
					!UNBOUND_BY_DESIGN[`${basename(call.file)}#${call.fn}`],
			)
			.map((call) => `${call.file}:${call.line} (${call.fn})`);
		expect(unbound).toEqual([]);
	});

	it("lists only exemptions that still exist", () => {
		const present = new Set(
			PM_DISPATCH_FILES.flatMap((file) =>
				callsOf(file, "executeMcpTool"),
			).map((call) => `${basename(call.file)}#${call.fn}`),
		);
		expect(
			Object.keys(UNBOUND_BY_DESIGN).filter((key) => !present.has(key)),
		).toEqual([]);
	});

	it("binds every direct MCP client acquisition in the PM activities (expectedGitLabOrigin)", () => {
		const files = sourceFiles(join(SRC, "activities/pm-integration"));
		const unbound: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [name, window] of [
				["getCachedMcpClientForConfig", 8],
				["getMcpClientResult", 6],
				["createMcpClientForConfig", 8],
				["getMcpClient", 6],
			] as const) {
				lines.forEach((line, index) => {
					if (
						!new RegExp(`\\b${name}\\(`).test(line) ||
						/^\s*(\/\/|\*)/.test(line) ||
						/function\s/.test(line)
					) {
						return;
					}
					const call = lines.slice(index, index + window).join("\n");
					if (!/expectedGitLabOrigin/.test(call)) {
						unbound.push(`${relative(SRC, file)}:${index + 1}`);
					}
				});
			}
		}
		expect(unbound).toEqual([]);
	});

	it("runs every PM preflight of a workflow that dispatches PM tools itself with pmTarget", () => {
		const workflows = sourceFiles(join(SRC, "workflows")).filter((file) => {
			const source = readFileSync(file, "utf8");
			return (
				/\bexecuteMcpTool\s*\(/.test(source) &&
				/\bdiscoverPMToolCapabilities\b/.test(source)
			);
		});
		expect(workflows.length).toBeGreaterThanOrEqual(2);
		const unchecked = workflows.flatMap((file) =>
			callsOf(file, "discoverPMToolCapabilities")
				.filter((call) => !/\bpmTarget\b/.test(call.args))
				.map((call) => `${call.file}:${call.line}`),
		);
		expect(unchecked).toEqual([]);
	});
});
