/**
 * AI-generated graphs must only contain node types this workspace can run.
 *
 * The palette is derived from the plugin registry and deliberately offers an
 * action only when it declares a step binding — `lib/node-definitions.ts` puts
 * it plainly: an action with no executor "can never be dropped onto a canvas".
 * Generation bypasses the palette completely; whatever the model returns went
 * straight back to the builder unchecked, so a generated workflow could carry
 * node types nothing executes and the author only discovered it mid-run.
 *
 * The allow-list is parsed out of the same `NODE_TYPES` block the model is
 * given, so the promise and the enforcement cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import {
	collectUnknownNodeTypes,
	SUPPORTED_GENERATED_NODE_TYPES,
} from "../generate-from-prompt";

describe("the allow-list is derived from the prompt", () => {
	it("contains the node types the prompt advertises", () => {
		for (const type of [
			"trigger",
			"ai-generate-text",
			"ai-generate-image",
			"http-request",
			"firecrawl-scrape",
			"firecrawl-search",
			"condition",
			"linear-create-ticket",
			"email-send",
			"slack-send",
			"mcp-tool",
		]) {
			expect(SUPPORTED_GENERATED_NODE_TYPES.has(type)).toBe(true);
		}
	});

	it("parsed a plausible number of types, so a format change cannot silently empty it", () => {
		// An empty or near-empty set would accept nothing; a huge one would mean
		// the regex is matching prose rather than the numbered entries.
		expect(SUPPORTED_GENERATED_NODE_TYPES.size).toBeGreaterThanOrEqual(8);
		expect(SUPPORTED_GENERATED_NODE_TYPES.size).toBeLessThan(40);
	});

	it("does not admit an invented type", () => {
		expect(SUPPORTED_GENERATED_NODE_TYPES.has("notion-create-page")).toBe(
			false,
		);
	});
});

describe("collectUnknownNodeTypes", () => {
	it("passes a graph built only from supported types", () => {
		expect(
			collectUnknownNodeTypes([
				{ id: "n1", type: "trigger" },
				{ id: "n2", type: "http-request" },
			]),
		).toEqual([]);
	});

	it("names the unsupported type", () => {
		// `notion-create-page` is a real plugin with no step implementation —
		// exactly the shape of thing the palette refuses to offer.
		expect(
			collectUnknownNodeTypes([
				{ id: "n1", type: "trigger" },
				{ id: "n2", type: "notion-create-page" },
			]),
		).toEqual(["notion-create-page"]);
	});

	it("reports each unsupported type once", () => {
		const unknown = collectUnknownNodeTypes([
			{ id: "n1", type: "made-up" },
			{ id: "n2", type: "made-up" },
			{ id: "n3", type: "also-fake" },
		]);
		expect(unknown.sort()).toEqual(["also-fake", "made-up"]);
	});

	it("treats a node with no type at all as unsupported", () => {
		expect(collectUnknownNodeTypes([{ id: "n1" }])).toHaveLength(1);
	});

	it("is quiet when there are no nodes to check", () => {
		// `update` and `removal` actions carry no nodes; they must not be
		// rejected for that.
		expect(collectUnknownNodeTypes(undefined)).toEqual([]);
		expect(collectUnknownNodeTypes([])).toEqual([]);
	});
});
