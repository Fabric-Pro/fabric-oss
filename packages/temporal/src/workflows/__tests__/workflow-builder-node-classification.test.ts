/**
 * Node classification is the contract three things depend on: the read-only
 * write gate, the retry policy, and legacy-node-type resolution. It also has
 * to stay in step with the step registry — a name here that no longer exists
 * there is a silent no-op.
 */

import { describe, expect, it } from "vitest";
import { stepRegistry } from "../../activities/lib/step-registry";
import {
	EXTERNAL_WRITE_NODE_TYPES,
	isExternalWriteNodeType,
	isNonRetryableNodeType,
	LEGACY_NODE_TYPE_ALIASES,
	resolveNodeType,
} from "../lib/workflow-builder-nodes";

describe("resolveNodeType", () => {
	it("maps every legacy bare slug onto its namespaced type", () => {
		expect(resolveNodeType("create-ticket")).toBe(
			"freshservice-create-ticket",
		);
		expect(resolveNodeType("create-task")).toBe("asana-create-task");
		expect(resolveNodeType("create-record")).toBe("attio-create-record");
		expect(resolveNodeType("create-conversation")).toBe(
			"front-create-conversation",
		);
		expect(resolveNodeType("list-designs")).toBe("canva-list-designs");
	});

	it("passes through node types that are already canonical", () => {
		expect(resolveNodeType("linear-create-ticket")).toBe(
			"linear-create-ticket",
		);
		expect(resolveNodeType("http-request")).toBe("http-request");
		expect(resolveNodeType("nonsense")).toBe("nonsense");
	});
});

describe("legacy aliases vs the step registry", () => {
	it("resolves every alias to a registered step", () => {
		for (const [legacy, canonical] of Object.entries(
			LEGACY_NODE_TYPE_ALIASES,
		)) {
			expect(
				canonical in stepRegistry,
				`${legacy} -> ${canonical} is not in the step registry`,
			).toBe(true);
		}
	});

	it("no longer registers any step under a bare legacy slug", () => {
		for (const legacy of Object.keys(LEGACY_NODE_TYPE_ALIASES)) {
			expect(
				legacy in stepRegistry,
				`${legacy} is still registered — the rename is incomplete`,
			).toBe(false);
		}
	});
});

describe("isExternalWriteNodeType", () => {
	it("classifies namespaced write steps", () => {
		expect(isExternalWriteNodeType("linear-create-ticket")).toBe(true);
		expect(isExternalWriteNodeType("slack-send")).toBe(true);
		expect(isExternalWriteNodeType("freshservice-create-ticket")).toBe(
			true,
		);
	});

	it("classifies legacy write steps through the alias map", () => {
		expect(isExternalWriteNodeType("create-ticket")).toBe(true);
		expect(isExternalWriteNodeType("create-task")).toBe(true);
	});

	it("leaves reads and internal steps alone", () => {
		for (const nodeType of [
			"trigger",
			"condition",
			"ai-generate-text",
			"http-request",
			"linear-find-issues",
			"github-get-file",
			"browser-navigate",
		]) {
			expect(isExternalWriteNodeType(nodeType), nodeType).toBe(false);
		}
	});
});

describe("isNonRetryableNodeType", () => {
	it("covers every external write", () => {
		for (const nodeType of EXTERNAL_WRITE_NODE_TYPES) {
			expect(isNonRetryableNodeType(nodeType), nodeType).toBe(true);
		}
	});

	it("covers mcp-tool, which may dispatch an arbitrary write", () => {
		expect(isNonRetryableNodeType("mcp-tool")).toBe(true);
	});

	it("leaves idempotent and internal steps retryable", () => {
		for (const nodeType of [
			"trigger",
			"condition",
			"http-request",
			"ai-generate-text",
			"firecrawl-scrape",
			"linear-find-issues",
			"attio-search-records",
		]) {
			expect(isNonRetryableNodeType(nodeType), nodeType).toBe(false);
		}
	});
});
