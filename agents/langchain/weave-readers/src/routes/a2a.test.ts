/**
 * A2A resolveAgent routing tests
 *
 * resolveAgent picks the reader agent (thread/spindle/weft/warp) purely by
 * substring-matching metadata.skillId and metadata.delegationContext.agentId
 * (falling back to metadata.agentId), then defaults silently to "thread" if
 * nothing matches. A typo'd skillId or an unrecognized agentId therefore
 * routes to the wrong agent with no error — this pins that routing table so
 * a future change to the substrings or the precedence order is caught.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveAgent } from "./a2a.js";

describe("resolveAgent", () => {
	it("defaults to thread when metadata is empty", () => {
		assert.equal(resolveAgent({}), "thread");
	});

	it("routes to spindle when skillId contains 'spindle'", () => {
		assert.equal(
			resolveAgent({ metadata: { skillId: "weave-spindle-research" } }),
			"spindle",
		);
	});

	it("routes to weft when skillId contains 'weft'", () => {
		assert.equal(
			resolveAgent({ metadata: { skillId: "weft-quality-review" } }),
			"weft",
		);
	});

	it("routes to warp when skillId contains 'warp'", () => {
		assert.equal(
			resolveAgent({ metadata: { skillId: "warp-security-audit" } }),
			"warp",
		);
	});

	it("matches case-insensitively", () => {
		assert.equal(
			resolveAgent({ metadata: { skillId: "WARP-AUDIT" } }),
			"warp",
		);
	});

	it("falls back to thread for an unrecognized skillId", () => {
		assert.equal(
			resolveAgent({ metadata: { skillId: "some-other-skill" } }),
			"thread",
		);
	});

	it("prefers delegationContext.agentId over metadata.agentId", () => {
		const body = {
			metadata: {
				agentId: "warp",
				delegationContext: { agentId: "weft" },
			},
		};
		assert.equal(resolveAgent(body), "weft");
	});

	it("falls back to metadata.agentId when delegationContext.agentId is absent", () => {
		const body = { metadata: { agentId: "spindle-agent" } };
		assert.equal(resolveAgent(body), "spindle");
	});

	it("prefers weft over warp when both substrings are present", () => {
		// skillId matches "weft" and agentId matches "warp" — weft is
		// checked before warp, so weft wins.
		const body = {
			metadata: { skillId: "weft-review", agentId: "warp-agent" },
		};
		assert.equal(resolveAgent(body), "weft");
	});

	it("prefers spindle over weft when both substrings are present", () => {
		// skillId matches "spindle" and agentId matches "weft" — spindle is
		// checked before weft, so spindle wins.
		const body = {
			metadata: { skillId: "spindle-review", agentId: "weft-agent" },
		};
		assert.equal(resolveAgent(body), "spindle");
	});

	it("prefers spindle over warp when both substrings are present", () => {
		// skillId matches "spindle" and agentId matches "warp" — spindle is
		// checked before warp, so spindle wins.
		const body = {
			metadata: { skillId: "spindle-task", agentId: "warp-audit" },
		};
		assert.equal(resolveAgent(body), "spindle");
	});

	it("ignores non-string skillId/agentId values", () => {
		const body = {
			metadata: { skillId: 123, agentId: { nested: true } },
		};
		assert.equal(resolveAgent(body), "thread");
	});
});
