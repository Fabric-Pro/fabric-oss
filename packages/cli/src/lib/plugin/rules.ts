/**
 * The project rules of a project's instructions (`rules/**` and
 * `.claude/rules/**`, markdown), and how each coding tool receives them.
 *
 * A plugin has no native slot for rules. Passive copies remain available in
 * the plugin; Claude Code gets automatically loaded files in `.claude/rules/`
 * (`rules-sync.ts`), while Codex gets them appended to the Fabric part of
 * `AGENTS.override.md` (this file). Pure: files in, text out.
 */
import { planPluginFiles } from "@fabricorg/sdk";
import type { InstructionFile } from "./layout.js";

export interface ProjectRule {
	/** Below `rules/`, POSIX: `style.md`, `team/naming.md`. */
	path: string;
	/** The instruction file it came from, for messages. */
	source: string;
	bytes: Uint8Array;
}

/** Most rule files a project receives, and their combined size. */
export const RULES_MAX_FILES = 64;
export const RULES_MAX_BYTES = 256 * 1024;

/** The rules section of `AGENTS.override.md` stops here, in characters. */
export const AGENTS_RULES_LIMIT = 24_000;

const byPath = (a: { path: string }, b: { path: string }) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The rules among the files that were read, by the shared mapping. A rule at
 * both `rules/x.md` and `.claude/rules/x.md` is one rule: the first path in
 * sort order (the `.claude/` one) is kept.
 */
export function selectRules(
	read: {
		files: readonly InstructionFile[];
		listed: Parameters<typeof planPluginFiles>[0];
	},
	tool: "claude-code" | "codex",
): ProjectRule[] {
	const bytesOf = new Map(read.files.map((file) => [file.path, file.bytes]));
	const seen = new Set<string>();
	const rules: ProjectRule[] = [];
	for (const rule of [...planPluginFiles(read.listed, tool).rules].sort(
		byPath,
	)) {
		const bytes = bytesOf.get(rule.path);
		if (bytes === undefined || seen.has(rule.as)) {
			continue;
		}
		seen.add(rule.as);
		rules.push({ path: rule.as, source: rule.path, bytes });
	}
	return rules.sort(byPath);
}

/** The first rules that fit the caps, and how many did not. */
export function capRules(rules: readonly ProjectRule[]): {
	kept: ProjectRule[];
	omitted: number;
} {
	const kept: ProjectRule[] = [];
	let total = 0;
	for (const rule of rules) {
		if (
			kept.length >= RULES_MAX_FILES ||
			total + rule.bytes.byteLength > RULES_MAX_BYTES
		) {
			break;
		}
		kept.push(rule);
		total += rule.bytes.byteLength;
	}
	return { kept, omitted: rules.length - kept.length };
}

const DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Rule tiers (specs/2026-10-21-ai-artifacts-hub §5.8): what a session always
 * carries stays small, everything else is loaded when it applies.
 *
 *   - a rule with `paths:` is delivered as is: Claude Code loads it only when
 *     files it names are touched;
 *   - a rule with neither `paths:` nor `load: on-demand` is always on, while
 *     the always-on rules together fit `ALWAYS_ON_RULES_BUDGET` characters,
 *     in path order;
 *   - every other rule (`load: on-demand`, or past the budget) is not
 *     delivered: the `fabric-rules` skill lists it with its description, and
 *     the agent reads it from the plugin or asks `fabric_rules_for` when the
 *     task calls for it.
 */
export const ALWAYS_ON_RULES_BUDGET = 8_000;

export interface OnDemandRule {
	/** Below `rules/`, POSIX. */
	path: string;
	/** The instruction file it came from: its passive copy is `instructions/source/<source>`. */
	source: string;
	description: string;
	paths: string[];
	reason: "on-demand" | "over-budget";
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** `description:` from the frontmatter, else the first heading or line of the body. */
function describeRule(text: string, body: string): string {
	const fm = FRONTMATTER.exec(text);
	const own = fm ? /^description:\s*(.+)$/m.exec(fm[1] ?? "") : null;
	const line =
		own?.[1] ??
		body
			.split(/\r?\n/)
			.map((l) => l.replace(/^#+\s*/, "").trim())
			.find((l) => l !== "") ??
		"";
	const clean = unquote(line).replace(/\s+/g, " ");
	return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

function loadsOnDemand(text: string): boolean {
	const fm = FRONTMATTER.exec(text);
	return fm !== null && /^load:\s*["']?on-demand["']?\s*$/m.test(fm[1] ?? "");
}

export function tierRules(rules: readonly ProjectRule[]): {
	delivered: ProjectRule[];
	onDemand: OnDemandRule[];
	alwaysOnChars: number;
} {
	const delivered: ProjectRule[] = [];
	const onDemand: OnDemandRule[] = [];
	let alwaysOnChars = 0;
	for (const rule of rules) {
		const text = DECODER.decode(rule.bytes);
		const parsed = parseRule(text);
		const lazy = loadsOnDemand(text);
		if (parsed.paths.length > 0 && !lazy) {
			delivered.push(rule);
			continue;
		}
		if (
			!lazy &&
			alwaysOnChars + parsed.body.length <= ALWAYS_ON_RULES_BUDGET
		) {
			alwaysOnChars += parsed.body.length;
			delivered.push(rule);
			continue;
		}
		onDemand.push({
			path: rule.path,
			source: rule.source,
			description: describeRule(text, parsed.body),
			paths: parsed.paths,
			reason: lazy ? "on-demand" : "over-budget",
		});
	}
	return { delivered, onDemand, alwaysOnChars };
}

interface ParsedRule {
	/** The `paths:` globs the file is scoped to, or none. */
	paths: string[];
	/** The text after the frontmatter. */
	body: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** `paths:` and the body of a rule; a file without frontmatter is all body. */
function parseRule(text: string): ParsedRule {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (match === null) {
		return { paths: [], body: text };
	}
	const paths: string[] = [];
	const lines = (match[1] ?? "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const head = /^paths:\s*(.*)$/.exec(lines[index] ?? "");
		if (head === null) {
			continue;
		}
		const inline = (head[1] ?? "").trim();
		if (inline.startsWith("[")) {
			paths.push(
				...inline
					.replace(/^\[|\]$/g, "")
					.split(",")
					.map(unquote)
					.filter((entry) => entry !== ""),
			);
		} else if (inline !== "") {
			paths.push(unquote(inline));
		} else {
			for (const next of lines.slice(index + 1)) {
				const item = /^\s*-\s+(.*)$/.exec(next);
				if (item === null) {
					break;
				}
				paths.push(unquote(item[1] ?? ""));
			}
		}
		break;
	}
	return { paths, body: text.slice(match[0].length) };
}

/**
 * The rules as a section of `AGENTS.override.md`: one heading per file, the
 * file's own text without its frontmatter, and for a rule scoped by `paths:`
 * a line saying when it applies (Codex has no per-path loading). Cut between
 * files at `AGENTS_RULES_LIMIT`, with a notice that names what was left out.
 */
export function agentsRulesSection(rules: readonly ProjectRule[]): string {
	if (rules.length === 0) {
		return "";
	}
	const head = "## Project rules";
	const parts: string[] = [];
	let used = head.length;
	let included = 0;
	for (const rule of rules) {
		const { paths, body } = parseRule(DECODER.decode(rule.bytes));
		const scope =
			paths.length === 0
				? ""
				: `\n_Applies when working on: ${paths.join(", ")}_\n`;
		const block = `### Rule: ${rule.path}${scope}\n${body.trim()}`;
		if (used + block.length + 2 > AGENTS_RULES_LIMIT) {
			break;
		}
		parts.push(block);
		used += block.length + 2;
		included++;
	}
	const omitted = rules.length - included;
	if (omitted > 0) {
		parts.push(
			`[Fabric: ${omitted} more rule ${omitted === 1 ? "file was" : "files were"} left out to keep this file short: ${rules
				.slice(included)
				.map((rule) => rule.path)
				.join(
					", ",
				)}. Load fabric-instruction-access to find their original source paths and read mapped local copies or available text through the project's Fabric MCP tools.]`,
		);
	}
	return `${head}\n\n${parts.join("\n\n")}`;
}

/**
 * What goes between Fabric's markers in `AGENTS.override.md`: the memory file,
 * then the rules. `null` when there is neither.
 */
export function agentsInstructions(
	memoryText: string | null,
	rules: readonly ProjectRule[],
): string | null {
	const sections = [
		memoryText === null ? "" : memoryText.trimEnd(),
		agentsRulesSection(rules),
	].filter((section) => section !== "");
	return sections.length === 0 ? null : sections.join("\n\n");
}
