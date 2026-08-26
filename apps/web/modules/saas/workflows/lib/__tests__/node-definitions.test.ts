/**
 * The palette is now derived from the plugin registry plus `system-nodes.ts`
 * instead of being an 865-line hand-maintained array. Two things must hold:
 * nothing that used to be offered disappeared, and nothing unrunnable appeared.
 */

import { describe, expect, it } from "vitest";

import "../plugins";
import {
	getNodeDefinition,
	hasExecutor,
	nodeCategories,
	nodeDefinitions,
} from "../node-definitions";
import { findActionById, getAllActions } from "../plugins";
import { SYSTEM_NODE_TYPES } from "../system-nodes";

/**
 * The 18 node types the hand-written palette offered. Every one must survive
 * the move to a derived palette — this is the regression guard for the
 * refactor, and for the five node types that are pinned rather than derived.
 */
const PREVIOUSLY_OFFERED = [
	"trigger",
	"ai-generate-text",
	"ai-generate-image",
	"firecrawl-scrape",
	"firecrawl-search",
	"http-request",
	"condition",
	"linear-create-ticket",
	"linear-find-issues",
	"email-send",
	"slack-send",
	"mcp-tool",
	"github-create-issue",
	"github-search-issues",
	"github-get-file",
	"perplexity-search",
	"fal-generate-image",
	"fal-generate-video",
];

describe("derived palette", () => {
	it("still offers everything the hand-written palette did", () => {
		const offered = new Set(nodeDefinitions.map((n) => n.type));
		const lost = PREVIOUSLY_OFFERED.filter((t) => !offered.has(t));

		expect(
			lost,
			`these node types were dropped by the move to a derived palette:\n${lost.join("\n")}`,
		).toEqual([]);
	});

	it("offers substantially more than it used to", () => {
		// 18 before; the previously-unreachable integrations roughly doubled it.
		expect(nodeDefinitions.length).toBeGreaterThan(40);
	});

	it("offers no action that cannot run", () => {
		const runnable = new Set(
			getAllActions()
				.filter(hasExecutor)
				.map((a) => a.nodeType),
		);
		const unrunnable = nodeDefinitions
			.map((n) => n.type)
			.filter((t) => !(runnable.has(t) || SYSTEM_NODE_TYPES.has(t)));

		expect(
			unrunnable,
			`these node types are offered but nothing can execute them:\n${unrunnable.join("\n")}`,
		).toEqual([]);
	});

	it("keeps executor-less integrations out of the palette", () => {
		// Defined for the integrations UI, no step behind them. Offering these
		// would let a user build a workflow that silently does nothing.
		const offered = new Set(nodeDefinitions.map((n) => n.type));
		for (const nodeType of [
			"notion-create-page",
			"notion-search-pages",
			"confluence-create-page",
			"google-drive-list-files",
			"microsoft-graph-list-teams",
			"nhtsa-vpic-decode-vin",
			"databricks-vector-search-query-index",
		]) {
			expect(
				offered.has(nodeType),
				`${nodeType} should not be offered`,
			).toBe(false);
		}
	});

	it("assigns every node a distinct type", () => {
		const types = nodeDefinitions.map((n) => n.type);
		expect(types).toHaveLength(new Set(types).size);
	});

	it("resolves a node definition by type", () => {
		expect(getNodeDefinition("slack-send")?.label).toBe(
			"Send Slack Message",
		);
		expect(getNodeDefinition("trigger")?.label).toBe("Trigger");
		expect(getNodeDefinition("nope")).toBeUndefined();
	});
});

/**
 * The config fields the hand-written palette offered per node type. When the
 * palette became derived, config moved to the action's own `configFields` —
 * and four Fabric AI enrichment controls, an image prompt-enhance toggle and
 * Perplexity's system prompt were silently dropped, because the plugin
 * declaration had never carried them. The steps read all of them.
 *
 * Anything listed here must stay offered.
 */
const PREVIOUSLY_OFFERED_CONFIG: Record<string, string[]> = {
	// aiModel is deliberately absent: the step resolves the model from the
	// workspace default for the SIMPLE task type and has never honoured a
	// per-node choice, so the field asked for a decision it discarded. Making
	// it authoritative instead would have switched the model on every existing
	// workflow carrying the old palette default — a migration, not a fix.
	"ai-generate-text": [
		"aiFormat",
		"aiPrompt",
		"fabricAutoDetect",
		"fabricStrategy",
		"fabricContext",
		"fabricPattern",
	],
	"ai-generate-image": ["imageModel", "imagePrompt", "enhancePrompt"],
	"perplexity-search": ["query", "model", "searchRecency", "systemPrompt"],
	"linear-create-ticket": ["ticketTitle", "ticketDescription", "priority"],
	"slack-send": ["slackChannel", "slackMessage"],
	"email-send": ["to", "subject", "body"],
	"http-request": ["method", "url"],
	condition: ["expression"],
	trigger: ["triggerType"],
};

describe("config fields survived the move to a derived palette", () => {
	it.each(Object.entries(PREVIOUSLY_OFFERED_CONFIG))(
		"%s still offers every field it used to",
		(nodeType, expected) => {
			const action = findActionById(nodeType);
			const offered = action
				? (action.configFields ?? []).map((f) => f.key)
				: (getNodeDefinition(nodeType)?.configFields ?? []).map(
						(f) => f.name,
					);

			const lost = expected.filter((key) => !offered.includes(key));

			expect(
				lost,
				`${nodeType} no longer offers ${JSON.stringify(lost)}. The step still reads these — offered: ${JSON.stringify(offered)}`,
			).toEqual([]);
		},
	);
});

describe("default config", () => {
	it("seeds a new node from its action's declared field defaults", () => {
		// github-search-issues declares limit: "10"; the hand-written palette
		// carried the same default, so dropping the node must still produce it.
		expect(
			getNodeDefinition("github-search-issues")?.defaultData.config,
		).toMatchObject({ limit: "10" });
		expect(
			getNodeDefinition("github-get-file")?.defaultData.config,
		).toMatchObject({ ref: "main" });
	});

	it("gives multi-select pickers an array to render against", () => {
		// `defaultValue` is typed as a string and cannot express an empty list.
		expect(getNodeDefinition("mcp-tool")?.defaultData.config).toMatchObject(
			{ mcpServers: [] },
		);
	});

	it("labels a node with its action label", () => {
		expect(
			getNodeDefinition("linear-create-ticket")?.defaultData.label,
		).toBe("Create Linear Ticket");
	});
});

describe("categories", () => {
	it("puts every node in exactly one category", () => {
		const grouped = nodeCategories.flatMap((c) =>
			c.nodes.map((n) => n.type),
		);
		expect(grouped.sort()).toEqual(
			nodeDefinitions.map((n) => n.type).sort(),
		);
	});

	it("leads with the system nodes", () => {
		expect(nodeCategories[0]?.id).toBe("Core");
		expect(nodeCategories[0]?.nodes.map((n) => n.type).sort()).toEqual([
			"condition",
			"http-request",
			"trigger",
		]);
	});

	it("has no empty category", () => {
		expect(nodeCategories.filter((c) => c.nodes.length === 0)).toEqual([]);
	});
});
