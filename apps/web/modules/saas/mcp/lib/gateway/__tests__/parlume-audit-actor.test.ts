/**
 * A tool call a Parlume meeting turn makes is audited as Parlume, an agent,
 * acting for the person who invited it. Any other call keeps its own actor.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/parlume-audit-actor
 */

import { describe, expect, it } from "vitest";
import { parlumeAuditActor } from "../parlume-audit-actor";

describe("parlumeAuditActor", () => {
	it("names Parlume as an agent acting for the inviter on a Parlume turn", () => {
		expect(
			parlumeAuditActor({
				userId: "inviter-1",
				actingContext: { projectId: "project-1", surface: "parlume" },
			}),
		).toEqual({
			type: "agent",
			userId: "inviter-1",
			nameSnapshot: "Fabric Parlume",
		});
	});

	it("leaves every other call to its own actor", () => {
		expect(parlumeAuditActor({ userId: "user-1" })).toBeUndefined();
		expect(
			parlumeAuditActor({
				userId: "user-1",
				actingContext: { surface: "workspace" },
			}),
		).toBeUndefined();
		expect(
			parlumeAuditActor({
				userId: "user-1",
				actingContext: { conversationId: "conversation-1" },
			}),
		).toBeUndefined();
	});
});
