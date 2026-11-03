/**
 * `fabric_rules_for` (specs/2026-10-21-ai-artifacts-hub §5.8): the project's
 * rules that apply to a piece of work, in full, for a coding tool whose
 * session does not carry every rule from the start (the plugin's
 * `fabric-rules` skill lists the others).
 *
 * The rules are the project's own instruction files (`rules/**`,
 * `.claude/rules/**`), read through the same list and read tools the agent
 * already has, so every access check, the repository and the uploaded paths,
 * and their limits are theirs. A rule ranks by:
 *
 *   - its `paths:` globs matching one of the files the agent named (strong);
 *   - the words of the task found in its description, title and text.
 *
 * Only rules that match at all are returned, best first.
 */
import { compileGlob } from "@repo/instructions";
import {
	defineFabricTools,
	TOOL_ANNOTATIONS,
} from "@repo/temporal/fabric-tool-definition";
import { sessionMayReachProject } from "./project-binding";
import { errorResult, jsonResult } from "./tool-results";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tools/tool-family";
import type { GatewaySession, ToolCallResult } from "./types";

export interface RulesToolAccess {
	/** The gateway's project read gate: null when the caller may not see the project. */
	resolveGatewayProjectReadAccess(
		projectId: string,
		session: GatewaySession,
	): Promise<{ organizationId: string | null } | null>;
	listInstructions(
		args: Record<string, unknown>,
		session: GatewaySession,
	): Promise<ToolCallResult>;
	getInstruction(
		args: Record<string, unknown>,
		session: GatewaySession,
	): Promise<ToolCallResult>;
}

const MAX_CANDIDATES = 80;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

const RULES_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_rules_for",
		description:
			"The project's rules that apply to the files you will touch or the task, in full.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				files: {
					type: "array",
					items: { type: "string" },
					maxItems: 100,
					description: "Paths you will touch",
				},
				task: {
					type: "string",
					maxLength: 500,
					description: "What you will do",
				},
				limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "projects:read",
	},
]);

function payload(result: ToolCallResult): Record<string, unknown> | null {
	if (result.isError) {
		return null;
	}
	const first = result.content[0] as { type?: string; text?: string };
	try {
		return first?.text
			? (JSON.parse(first.text) as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function isRulePath(path: string): boolean {
	const lower = path.toLowerCase().replace(/\\/g, "/");
	return (
		lower.endsWith(".md") &&
		(lower.startsWith("rules/") ||
			lower.startsWith(".claude/rules/") ||
			lower.includes("/rules/"))
	);
}

export type ParsedRuleText = {
	paths: string[];
	description: string;
	body: string;
};

/** `paths:`, `description:` and the body of a rule file. */
export function parseRuleText(text: string): ParsedRuleText {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	const head = match?.[1] ?? "";
	const body = match ? text.slice(match[0].length) : text;
	const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
	const paths: string[] = [];
	const lines = head.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = /^paths:\s*(.*)$/.exec(lines[i] ?? "");
		if (!m) {
			continue;
		}
		const inline = (m[1] ?? "").trim();
		if (inline.startsWith("[")) {
			paths.push(
				...inline
					.replace(/^\[|\]$/g, "")
					.split(",")
					.map(unquote)
					.filter(Boolean),
			);
		} else if (inline) {
			paths.push(unquote(inline));
		} else {
			for (const next of lines.slice(i + 1)) {
				const item = /^\s*-\s+(.*)$/.exec(next);
				if (!item) {
					break;
				}
				paths.push(unquote(item[1] ?? ""));
			}
		}
		break;
	}
	const own = /^description:\s*(.+)$/m.exec(head)?.[1];
	const first = body
		.split(/\r?\n/)
		.map((l) => l.replace(/^#+\s*/, "").trim())
		.find(Boolean);
	return {
		paths,
		description: unquote(own ?? first ?? ""),
		body,
	};
}

function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 3),
	);
}

/** How well a rule fits the files and the task; 0 is "does not apply". */
export function scoreRule(
	rule: ParsedRuleText & { path: string },
	files: readonly string[],
	task: string,
): number {
	let score = 0;
	if (rule.paths.length > 0 && files.length > 0) {
		const matchers = rule.paths.map(compileGlob);
		if (files.some((f) => matchers.some((m) => m.test(f)))) {
			score += 10;
		}
	}
	const wanted = words(task);
	if (wanted.size > 0) {
		const strong = words(`${rule.description} ${rule.path}`);
		const all = words(rule.body);
		for (const w of wanted) {
			if (strong.has(w)) {
				score += 2;
			} else if (all.has(w)) {
				score += 0.5;
			}
		}
	}
	return score;
}

async function handleRulesFor(
	access: RulesToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = args.projectId;
	if (typeof projectId !== "string" || projectId === "") {
		return errorResult("projectId is required");
	}
	// A project-bound session reaches its own project only, and the caller
	// must see the project; the reads below check instruction access again.
	if (
		!sessionMayReachProject(session, projectId) ||
		(await access.resolveGatewayProjectReadAccess(projectId, session)) ===
			null
	) {
		return errorResult("Project not found or not accessible.");
	}
	const files = Array.isArray(args.files)
		? args.files
				.filter((f): f is string => typeof f === "string")
				.slice(0, 100)
		: [];
	const task = typeof args.task === "string" ? args.task.slice(0, 500) : "";
	if (files.length === 0 && task.trim() === "") {
		return errorResult(
			"Pass the files you will touch, a one-line task, or both.",
		);
	}
	const limit =
		typeof args.limit === "number"
			? Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit)))
			: DEFAULT_LIMIT;

	const listed = await access.listInstructions({ projectId }, session);
	if (listed.isError) {
		return listed;
	}
	const list = payload(listed);
	const paths = ((list?.files as Array<{ path?: unknown }> | undefined) ?? [])
		.map((f) => (typeof f.path === "string" ? f.path : null))
		.filter((p): p is string => p !== null && isRulePath(p))
		.slice(0, MAX_CANDIDATES);

	const scored: Array<{
		path: string;
		description: string;
		appliesTo: string[];
		body: string;
		score: number;
	}> = [];
	for (const path of paths) {
		const read = payload(
			await access.getInstruction({ projectId, path }, session),
		);
		const text = typeof read?.body === "string" ? read.body : null;
		if (text === null) {
			continue;
		}
		const parsed = parseRuleText(text);
		const score = scoreRule({ ...parsed, path }, files, task);
		if (score > 0) {
			scored.push({
				path,
				description: parsed.description,
				appliesTo: parsed.paths,
				body: parsed.body,
				score,
			});
		}
	}
	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const rules = scored
		.slice(0, limit)
		.map(({ score: _score, ...rule }) => rule);
	return jsonResult({
		rules,
		considered: paths.length,
		message:
			rules.length === 0
				? "No rule of this project matches these files or this task beyond the ones already loaded."
				: `Follow these ${rules.length} rule(s) for this work.`,
	});
}

export function createRulesTools(access: RulesToolAccess): ToolFamily {
	return toolFamily(
		RULES_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			["fabric_rules_for", (a, s) => handleRulesFor(access, a, s)],
		]),
	);
}
