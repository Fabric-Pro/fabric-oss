/**
 * The plugin's built-in `fabric-knowledge` skill (specs/2026-10-21-ai-artifacts-hub
 * §5.1, §5.5–5.6): the default way an agent keeps what it learns. Whenever the
 * user asks to save something for context, keep notes, remember details,
 * record a decision or hand work over, the agent stores it in the project's
 * knowledge hub in Fabric through the plugin's MCP server, never as loose
 * files in the checkout.
 *
 * The project's type catalog is rendered in, so the agent picks a valid type
 * and fills its template without a round trip.
 */

import type { KnowledgeArtifactTypeInfo, PluginTool } from "@fabricorg/sdk";

export const KNOWLEDGE_SKILL = "fabric-knowledge";

export type KnowledgeTypes =
	| { state: "known"; types: KnowledgeArtifactTypeInfo[] }
	| { state: "unavailable" };

/** Template text shown per type is cut here; the full template is one MCP call away. */
const TEMPLATE_LIMIT = 600;

function typeLines(type: KnowledgeArtifactTypeInfo): string[] {
	const lines = [`### \`${type.key}\` — ${type.name}`, "", type.description];
	if (type.summaryBehavior === "LATEST_WINS") {
		lines.push(
			"",
			"Only the newest entry of this type counts in the topic summary.",
		);
	}
	const required = (type.fieldSchema as { required?: string[] } | null)
		?.required;
	if (required?.length) {
		lines.push(
			"",
			`Required \`fields\`: ${required.map((f) => `\`${f}\``).join(", ")}.`,
		);
	}
	if (type.template?.trim()) {
		const template =
			type.template.length > TEMPLATE_LIMIT
				? `${type.template.slice(0, TEMPLATE_LIMIT)}\n…`
				: type.template;
		lines.push(
			"",
			"Template:",
			"",
			"```markdown",
			template.trimEnd(),
			"```",
		);
	}
	return lines;
}

export function knowledgeSkill(
	knowledge: KnowledgeTypes,
	tool: PluginTool,
	projectId: string,
): string {
	const server =
		tool === "claude-code"
			? "this plugin's Fabric MCP server"
			: "the Fabric MCP server of this plugin";
	const catalog =
		knowledge.state === "known" && knowledge.types.length > 0
			? [
					"## Types",
					"",
					"Pick the type that fits; fill its template.",
					"",
					...knowledge.types.flatMap((type) => [
						...typeLines(type),
						"",
					]),
				]
			: [
					"## Types",
					"",
					"The type list could not be read when this plugin was built. Call `fabric_knowledge_types` first.",
					"",
				];
	return `${[
		"---",
		`name: ${KNOWLEDGE_SKILL}`,
		"description: Default way to keep project knowledge. Use whenever the user asks to save something for context, keep or take notes, remember details, write down findings, record a decision, write a spec or investigation, or hand work over to someone — and when you finish a meaningful step on a work item. Stores it in the project's knowledge hub in Fabric, shared with the whole team, instead of files in the checkout.",
		"---",
		"",
		"# Fabric project knowledge",
		"",
		`Project knowledge lives in Fabric, not in files: notes, specs, investigations, decisions, journals and handoffs are saved through ${server} and shared with every teammate and their AI tools. Project: \`${projectId}\`.`,
		"",
		"## Save",
		"",
		"Call `fabric_knowledge_add` with:",
		"",
		"- `topic`: what it is about. Use the work item when there is one (Fabric id, identifier such as `US-012`, or the external id such as `12345` from the branch name, the task or the user); otherwise a short topic name such as `us-developer-journey`.",
		"- `type`: a key from the list below.",
		"- `title` and `body` (markdown, filling the type's template).",
		"- `role`: your discipline on this work (FE, BE, QA…) when known.",
		"",
		"Entries are append-only: you never overwrite a teammate. To correct your earlier entry, add a new one with `supersedes: <entryId>`. Do not create note files in the repository for this, and do not keep them only in the conversation.",
		"",
		"Save without being asked, too: after a decision, at the end of an investigation, and a `handoff` entry when you stop working on a work item.",
		"",
		"## Documents you write as files",
		"",
		"When you write a document as a file (a spec, a plan, a design, an investigation report), it is knowledge too. Save it with `fabric_knowledge_add`, passing its path as `sourcePath`, at milestones, not after every edit: when the document is done, when the user approves it, or before it is committed. If you edit it later, save it again at the next milestone with the same `sourcePath`: Fabric keeps the versions, and the new one supersedes the old.",
		"",
		"## Find",
		"",
		"- Before starting on a work item, call `fabric_knowledge_topic` with it: read the summary (the living document built from everyone's entries) and the newest entries.",
		"- `fabric_knowledge_search` searches all entries by meaning; filter by `topic`, `types`, `authorUserId` or `since`.",
		"- `fabric_knowledge_topics` lists recently active topics (`mine: true` for yours).",
		"",
		...catalog,
	].join("\n")}\n`;
}

/** The always-on rule, added to the session context of every tool. */
export const KNOWLEDGE_RULE = `Project knowledge: when the user asks to save something for context, keep notes or remember details, or when you record a decision, get test results worth keeping, sum up a discussion the user shares, finish an investigation or hand work over, save it to Fabric with the ${KNOWLEDGE_SKILL} skill (fabric_knowledge_add), not as files in the checkout. Before starting on a work item, read its topic with fabric_knowledge_topic. For a question about the project (how something works, why, where), ask fabric_semantic_search first: it searches the project's context and code index at once; open the code in \`repos/<name>/\` for details or proof.\n`;
