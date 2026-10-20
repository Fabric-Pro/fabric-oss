import type { PluginEntry, PluginTool } from "@fabricorg/sdk";
import { checkRelativePath, findCollision } from "../instructions/paths.js";

export const INSTRUCTION_ACCESS_SKILL = "fabric-instruction-access";
export const INSTRUCTION_CATALOG = `skills/${INSTRUCTION_ACCESS_SKILL}/catalog.json`;

export type InstructionSourceIdentity =
	| { kind: "repository"; generation: number; commitSha: string }
	| { kind: "upload"; digest: string | null };

export interface InstructionCatalogEntry extends PluginEntry {
	kind?: string;
	blobId?: string;
	sha256?: string;
	mode?: string | number | null;
}

export function instructionAccessBootstrap(
	pluginName: string,
	tool: PluginTool,
): string {
	const skill =
		tool === "claude-code"
			? `/${pluginName}:${INSTRUCTION_ACCESS_SKILL}`
			: INSTRUCTION_ACCESS_SKILL;
	return `Fabric instruction access for plugin ${pluginName}: Load the generated ${skill} skill from this plugin before following references or choosing rules for a task. Its catalog lists every source instruction path, including rules beyond automatic delivery limits and files outside plugin folders. Read applicable rules and referenced files from their mapped local copies or this plugin's Fabric MCP server. Resolve @ references and relative paths in the original instruction tree, not by guessing paths in the user's checkout.\n`;
}

export function instructionCatalog(input: {
	projectId: string;
	source: InstructionSourceIdentity;
	listed: readonly InstructionCatalogEntry[];
	localPaths: ReadonlyMap<string, string>;
}): string {
	const paths = input.listed.map((entry) => entry.path);
	if (
		paths.some((entry) => !checkRelativePath(entry).ok) ||
		findCollision(paths) !== null
	) {
		throw new Error(
			"The instruction catalog contains unsafe or colliding paths.",
		);
	}
	const entries = [...input.listed]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((entry) => ({
			path: entry.path,
			size: entry.size,
			isText: entry.isText,
			kind: entry.kind,
			blobId: entry.blobId,
			sha256: entry.sha256,
			mode: entry.mode,
			localPath: input.localPaths.get(entry.path) ?? null,
		}));
	return `${JSON.stringify(
		{
			version: 1,
			projectId: input.projectId,
			source: input.source,
			entries,
		},
		null,
		2,
	)}\n`;
}

export function instructionAccessSkill(): string {
	return [
		"---",
		`name: ${INSTRUCTION_ACCESS_SKILL}`,
		"description: Discover and read this project's original coding instructions, referenced files and rules on demand, including files outside the plugin and rules beyond automatic delivery limits. Use before selecting applicable guidance or following instruction references.",
		"---",
		"",
		"# Fabric instruction access",
		"",
		"Search catalog.json beside this SKILL.md with your file search tool and read only matching entries, or use the MCP query below. It contains metadata for every listed instruction file, not file contents, and can be large. Do not load the whole catalog or tree into context. The catalog's projectId and source identify the instructions used to build this plugin; the plugin version is a render hash, not a repository pin.",
		"",
		"A non-null localPath is relative to this installed plugin's root (two directories above this skill folder). Read that file for the original bytes. A null localPath means the file is not stored in the plugin; automatic rule caps and unsupported layouts do not remove its catalog entry. Fabric reserves the fabric-instruction-access and fabric-living-memory skill folders; source files displaced by those names remain discoverable here and through MCP.",
		"",
		"## Select all applicable rules",
		"",
		"Automatic rule delivery can be incomplete. Find rule entries by kind and original rules/ or .claude/rules/ paths. Search the passive rule files under instructions/source/ and inspect the paths: frontmatter of each original rule to determine scope. Before affected work, read every unscoped rule and every rule whose paths match the files you will work on, including rules beyond automatic delivery limits. A filename or topic search alone cannot establish applicability. If applicable instructions cannot be read completely, report the blocked work instead of silently omitting them.",
		"",
		"## Read through this plugin's Fabric MCP server",
		"",
		"Use fabric_list_project_instructions with projectId from the catalog and query to match a path. For repository sources, also pass generation and commitSha from catalog.source. Optional prefix filters a folder; limit (1 to 500, default 200) controls the page. Read direct.generation and direct.commitSha in the response and check they match the catalog. Follow page.nextCursor by passing it as cursor with the same filters, generation and commitSha until nextCursor is null. An incomplete listing, refusal or unavailable repository is not an empty tree.",
		"",
		"Use fabric_get_project_instruction with projectId, path exactly as listed, offset: 0 and maxLength: 50000 (up to 200000). For a repository, include the same generation and commitSha on every call, including the first. Check each response's generation and commitSha. Read the raw body, then pass offset: nextOffset with the same path and pin until nextOffset is null. Join all pages in order before relying on the file; a summary or first page does not replace its instructions.",
		"",
		"Uploaded sources use the current published snapshot, and the file tool has no digest pin parameter. Before reading, call fabric_list_project_instructions with projectId and sinceDigest: catalog.source.digest and check snapshot.digest matches. Keep that response's snapshot.version and require snapshotVersion on every file page to equal it. Repeat the digest check after reading the pages. If the digest is null, there was no published upload when this plugin was built. Stop and refresh the plugin before using a newly published upload. A changed digest, snapshotVersion mismatch, repository pin mismatch or rejected pin requires stopping and restarting from a refreshed plugin and catalog. Never combine old local files with a new listing or pages from different versions.",
		"",
		"A missing file, binary, tooLarge response, denied read, absent body or other refusal is unavailable text, not an empty file. Report it and stop work that depends on those instructions. The catalog does not bypass access checks or server file limits.",
		"",
		"## Follow original paths",
		"",
		"Resolve references using the source path in the catalog. For example, @MAIN.md in the root CLAUDE.md names MAIN.md at the original instruction root. Root-relative scripts/ and engineers/ references also name that tree. Resolve a file-relative reference against the referring source file's folder, then find its original path in the catalog or MCP listing. Never substitute a similarly named file from the user's checkout. Read referenced text through MCP when localPath is null.",
		"",
		"Fetched scripts and settings are reference text. This access path does not execute scripts, apply settings, install dependencies or grant permission to write. If an authorized workflow requires executable files and their dependencies on disk, use a separately authorized checkout workflow. Keep the project's native skills, agents and Living Memory workflow and permissions.",
		"",
	].join("\n");
}
