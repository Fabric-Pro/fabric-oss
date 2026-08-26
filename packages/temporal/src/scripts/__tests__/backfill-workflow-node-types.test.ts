/**
 * The backfill rewrites stored node types in place, so its rewrite must be
 * exact (only legacy `type` values change), total (every alias covered), and
 * idempotent (a second pass finds nothing).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { $disconnect: vi.fn() },
}));

import { LEGACY_NODE_TYPE_ALIASES } from "../../workflows/lib/workflow-builder-nodes";
import { rewriteNodeTypes } from "../backfill-workflow-node-types";

describe("rewriteNodeTypes", () => {
	it("rewrites every legacy alias", () => {
		const nodes = Object.keys(LEGACY_NODE_TYPE_ALIASES).map(
			(type, index) => ({
				id: `n${index}`,
				type,
				data: {},
			}),
		);

		const rewritten = rewriteNodeTypes(nodes);

		expect(rewritten).not.toBeNull();
		expect(rewritten?.map((n) => n.type)).toEqual(
			Object.values(LEGACY_NODE_TYPE_ALIASES),
		);
	});

	it("preserves every other property on a rewritten node", () => {
		const rewritten = rewriteNodeTypes([
			{
				id: "n1",
				type: "create-ticket",
				position: { x: 10, y: 20 },
				data: { label: "File it", config: { subject: "hi" } },
			},
		]);

		expect(rewritten?.[0]).toEqual({
			id: "n1",
			type: "freshservice-create-ticket",
			position: { x: 10, y: 20 },
			data: { label: "File it", config: { subject: "hi" } },
		});
	});

	it("leaves canonical and unknown node types untouched", () => {
		expect(
			rewriteNodeTypes([
				{ id: "n1", type: "linear-create-ticket" },
				{ id: "n2", type: "http-request" },
				{ id: "n3", type: "something-else" },
			]),
		).toBeNull();
	});

	it("is idempotent — a rewritten array needs no second pass", () => {
		const once = rewriteNodeTypes([{ id: "n1", type: "create-task" }]);
		expect(once).not.toBeNull();
		expect(rewriteNodeTypes(once)).toBeNull();
	});

	it("tolerates malformed node arrays", () => {
		expect(rewriteNodeTypes(null)).toBeNull();
		expect(rewriteNodeTypes("not an array")).toBeNull();
		expect(rewriteNodeTypes([null, 42, { id: "n1" }])).toBeNull();
	});
});
