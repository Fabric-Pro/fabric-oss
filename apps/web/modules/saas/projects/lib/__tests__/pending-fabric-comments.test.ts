import { describe, expect, it } from "vitest";
import {
	type FabricMentionComment,
	getPendingFabricCommentIds,
	hasRecentPendingFabricComment,
	PENDING_FABRIC_POLL_WINDOW_MS,
} from "../pending-fabric-comments";

const user = (
	id: string,
	workflowId?: string,
	createdAt?: string | Date | null,
): FabricMentionComment => ({
	id,
	authorType: "USER",
	workflowId,
	createdAt,
});
const agentReplyTo = (
	id: string,
	sourceCommentId: string,
): FabricMentionComment => ({ id, authorType: "AGENT", sourceCommentId });

describe("getPendingFabricCommentIds", () => {
	it("returns empty when no comment mentions @fabric", () => {
		expect(getPendingFabricCommentIds([user("c1"), user("c2")])).toEqual(
			[],
		);
	});

	it("flags a @fabric mention that has no agent reply yet", () => {
		expect(getPendingFabricCommentIds([user("c1", "wf1")])).toEqual(["c1"]);
	});

	it("clears once the agent reply lands", () => {
		expect(
			getPendingFabricCommentIds([
				user("c1", "wf1"),
				agentReplyTo("a1", "c1"),
			]),
		).toEqual([]);
	});

	it("tracks each mention independently", () => {
		expect(
			getPendingFabricCommentIds([
				user("c1", "wf1"),
				agentReplyTo("a1", "c1"),
				user("c2", "wf2"),
			]),
		).toEqual(["c2"]);
	});
});

describe("hasRecentPendingFabricComment", () => {
	const now = 1_000_000_000_000; // fixed reference instant

	it("is true for a pending mention created inside the window", () => {
		const recent = new Date(now - 5_000).toISOString(); // 5s ago
		expect(
			hasRecentPendingFabricComment([user("c1", "wf1", recent)], now),
		).toBe(true);
	});

	it("is false once the pending mention ages past the window (stalled/failed workflow)", () => {
		const stale = new Date(
			now - PENDING_FABRIC_POLL_WINDOW_MS - 1,
		).toISOString();
		expect(
			hasRecentPendingFabricComment([user("c1", "wf1", stale)], now),
		).toBe(false);
	});

	it("is false when nothing is pending, regardless of age", () => {
		const recent = new Date(now - 5_000).toISOString();
		expect(
			hasRecentPendingFabricComment(
				[user("c1", "wf1", recent), agentReplyTo("a1", "c1")],
				now,
			),
		).toBe(false);
	});

	it("fail-closes: a pending mention with no createdAt does not poll", () => {
		expect(
			hasRecentPendingFabricComment([user("c1", "wf1", undefined)], now),
		).toBe(false);
	});

	it("fail-closes on an unparseable createdAt", () => {
		expect(
			hasRecentPendingFabricComment(
				[user("c1", "wf1", "not-a-date")],
				now,
			),
		).toBe(false);
	});

	it("is false for a grossly future createdAt (corrupt data / large skew cannot extend the poll)", () => {
		const grossFuture = new Date(
			now + PENDING_FABRIC_POLL_WINDOW_MS + 1,
		).toISOString();
		expect(
			hasRecentPendingFabricComment(
				[user("c1", "wf1", grossFuture)],
				now,
			),
		).toBe(false);
	});

	it("still polls a modestly future createdAt (client clock slightly behind the server)", () => {
		const nearFuture = new Date(now + 5_000).toISOString(); // 5s ahead
		expect(
			hasRecentPendingFabricComment([user("c1", "wf1", nearFuture)], now),
		).toBe(true);
	});
});
