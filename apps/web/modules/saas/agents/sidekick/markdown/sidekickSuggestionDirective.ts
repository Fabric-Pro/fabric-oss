/**
 * Remark plugin that transforms `:agent_suggestion[]{sId=xxx kind=tools}` text directives
 * into custom HTML elements that the SidekickSuggestionHost component can render as cards.
 *
 * Tolerates malformed directives where the LLM outputs `::agent_suggestion[]{...}` with
 * a stray prefix — these are detected via regex and cleaned up.
 *
 * Because suggestion cards are block-level React components (<div>), this plugin
 * also lifts them out of any wrapping <p> to avoid React hydration errors
 * (`<div> cannot be a descendant of <p>`).
 */
import { visit } from "unist-util-visit";

// Regex to extract sId and kind from malformed directive text
// Matches patterns like: ::agent_suggestion[]{sId=abc123 kind=tools}
const MALFORMED_DIRECTIVE_REGEX =
	/:+agent_suggestion\[\]\{sId=(\S+)\s+kind=(\S+)\}/g;

/** Mark a node as a block-level agent-suggestion element. */
function tagAsSuggestion(node: any, sId: string, kind: string) {
	node.data = node.data || {};
	node.data.hName = "agent-suggestion";
	node.data.hProperties = { sid: sId, kind };
}

export function sidekickSuggestionDirective() {
	return (tree: any) => {
		// Pass 1: Tag properly parsed directives
		visit(tree, (node: any) => {
			if (
				(node.type === "textDirective" ||
					node.type === "leafDirective") &&
				node.name === "agent_suggestion"
			) {
				const sId = node.attributes?.sId;
				const kind = node.attributes?.kind;
				if (!sId || !kind) {
					return;
				}
				tagAsSuggestion(node, sId, kind);
			}
		});

		// Pass 2: Expand malformed directives in plain text
		visit(
			tree,
			"text",
			(node: any, index: number | undefined, parent: any) => {
				if (!parent || index === undefined) {
					return;
				}

				const text = node.value as string;
				if (!text.includes("agent_suggestion")) {
					return;
				}

				const parts: any[] = [];
				let lastIndex = 0;

				for (const match of text.matchAll(MALFORMED_DIRECTIVE_REGEX)) {
					const [fullMatch, sId, kind] = match;
					const matchIndex = match.index!;

					if (matchIndex > lastIndex) {
						parts.push({
							type: "text",
							value: text.slice(lastIndex, matchIndex),
						});
					}

					const directive: any = {
						type: "leafDirective",
						name: "agent_suggestion",
						attributes: { sId, kind },
						children: [],
						data: {
							hName: "agent-suggestion",
							hProperties: { sid: sId, kind },
						},
					};
					parts.push(directive);

					lastIndex = matchIndex + fullMatch.length;
				}

				if (parts.length > 0) {
					if (lastIndex < text.length) {
						parts.push({
							type: "text",
							value: text.slice(lastIndex),
						});
					}
					parent.children.splice(index, 1, ...parts);
				}
			},
		);

		// Pass 3: Lift suggestion nodes out of paragraphs.
		// Walk the tree bottom-up looking for paragraphs that contain
		// agent-suggestion nodes. Split such paragraphs so the suggestion
		// becomes a sibling instead of a child, avoiding <div>-inside-<p>.
		visit(
			tree,
			"paragraph",
			(node: any, index: number | undefined, parent: any) => {
				if (!parent || index === undefined) {
					return;
				}

				const hasSuggestion = node.children?.some(
					(c: any) => c.data?.hName === "agent-suggestion",
				);
				if (!hasSuggestion) {
					return;
				}

				// Split children into groups: runs of non-suggestion nodes
				// become paragraphs, suggestion nodes become standalone siblings.
				const replacements: any[] = [];
				let currentRun: any[] = [];

				for (const child of node.children) {
					if (child.data?.hName === "agent-suggestion") {
						if (currentRun.length > 0) {
							replacements.push({
								...node,
								children: currentRun,
							});
							currentRun = [];
						}
						replacements.push(child);
					} else {
						currentRun.push(child);
					}
				}
				if (currentRun.length > 0) {
					replacements.push({ ...node, children: currentRun });
				}

				parent.children.splice(index, 1, ...replacements);
			},
		);
	};
}
