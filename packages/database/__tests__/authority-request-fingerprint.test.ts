/**
 * The fingerprint of one call, which a per-call approval is bound to.
 *
 * A tool that asks the person for every call raises a one-shot grant for the
 * exact tool and arguments it was asked about. The grant authorizes a call
 * with the same fingerprint and no other, so the fingerprint has to be equal
 * for the same call however the arguments were assembled, and different for
 * any other call: a different tool, a different value, a different list.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({ db: {} }));

import { authorityRequestFingerprint } from "../prisma/queries/authority";

describe("authorityRequestFingerprint", () => {
	it("is the same call whatever order the arguments were built in", () => {
		expect(
			authorityRequestFingerprint("fabric_update_workflow", {
				workflowId: "wf-1",
				preset: { cron: "0 9 * * 1", name: "Digest" },
			}),
		).toBe(
			authorityRequestFingerprint("fabric_update_workflow", {
				preset: { name: "Digest", cron: "0 9 * * 1" },
				workflowId: "wf-1",
			}),
		);
	});

	it("is the same across nested objects inside lists", () => {
		expect(
			authorityRequestFingerprint("fabric_create_frame", {
				blocks: [{ type: "html", id: "page" }],
			}),
		).toBe(
			authorityRequestFingerprint("fabric_create_frame", {
				blocks: [{ id: "page", type: "html" }],
			}),
		);
	});

	it("differs for another tool with the same arguments", () => {
		const args = { workflowId: "wf-1" };

		expect(
			authorityRequestFingerprint("fabric_publish_workflow", args),
		).not.toBe(
			authorityRequestFingerprint("fabric_execute_workflow", args),
		);
	});

	it("differs for another value, another workflow, another list", () => {
		const base = authorityRequestFingerprint("fabric_publish_workflow", {
			workflowId: "wf-1",
		});

		expect(
			authorityRequestFingerprint("fabric_publish_workflow", {
				workflowId: "wf-2",
			}),
		).not.toBe(base);
		expect(
			authorityRequestFingerprint("fabric_publish_workflow", {
				workflowId: "wf-1",
				extra: true,
			}),
		).not.toBe(base);
		expect(
			authorityRequestFingerprint("fabric_create_frame", {
				runtimeTools: ["a", "b"],
			}),
		).not.toBe(
			authorityRequestFingerprint("fabric_create_frame", {
				runtimeTools: ["b", "a"],
			}),
		);
	});

	it("does not confuse a value with a tool name", () => {
		expect(authorityRequestFingerprint("a", { b: "c:d" })).not.toBe(
			authorityRequestFingerprint("a:b", { c: "d" }),
		);
	});

	it("is a stable hex digest", () => {
		expect(
			authorityRequestFingerprint("fabric_pause_workflow", {}),
		).toMatch(/^[0-9a-f]{64}$/);
	});
});
