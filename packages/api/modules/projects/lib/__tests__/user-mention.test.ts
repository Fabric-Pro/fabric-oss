import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		member: { findMany: vi.fn() },
		projectMember: { findMany: vi.fn() },
		user: { findMany: vi.fn() },
	},
}));

import { db } from "@repo/database";
import {
	extractUserMentions,
	filterAuthorizedMentionRecipients,
} from "../user-mention";

describe("extractUserMentions", () => {
	it("returns an empty array for empty input", () => {
		expect(extractUserMentions("")).toEqual([]);
	});

	it("extracts a single username", () => {
		expect(extractUserMentions("hey @alice can you review")).toEqual([
			"alice",
		]);
	});

	it("extracts multiple distinct usernames", () => {
		expect(
			extractUserMentions(
				"@alice and @bob_smith plus @charlie-doe please",
			),
		).toEqual(["alice", "bob_smith", "charlie-doe"]);
	});

	it("deduplicates the same username", () => {
		expect(extractUserMentions("@alice and @alice and @ALICE")).toEqual([
			"alice",
		]);
	});

	it("excludes the reserved @fabric mention", () => {
		expect(extractUserMentions("@fabric please summarize")).toEqual([]);
	});

	it("keeps non-fabric mentions when @fabric also appears", () => {
		expect(extractUserMentions("@fabric and @alice")).toEqual(["alice"]);
	});

	it("requires whitespace or start-of-string before @", () => {
		// Email-like patterns must not match.
		expect(extractUserMentions("ping me at user@example.com")).toEqual([]);
	});

	it("does not match URL fragments", () => {
		expect(
			extractUserMentions("see https://x.com/path?u=@bob now"),
		).toEqual([]);
		expect(
			extractUserMentions(
				"read https://example.com/posts/@alice/profile",
			),
		).toEqual([]);
	});

	it("matches when separated from a code block by whitespace", () => {
		// Inline backticks adjacent to @ — `code` followed by space then @alice
		// should match alice (terminator after backtick is whitespace).
		expect(extractUserMentions("hey `code` @alice take a look")).toEqual([
			"alice",
		]);
	});

	it("does not match @ glued to backticks (no whitespace boundary)", () => {
		// `@bob` inside backticks: ` precedes @, fails the (^|\s) lookbehind.
		expect(extractUserMentions("see `@bob` for example")).toEqual([]);
	});

	it("matches at start of string", () => {
		expect(extractUserMentions("@alice hi")).toEqual(["alice"]);
	});

	it("requires terminator (whitespace or punctuation)", () => {
		// 33-char username is too long.
		expect(
			extractUserMentions("@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa hi"),
		).toEqual([]);
	});

	it("accepts trailing punctuation", () => {
		expect(extractUserMentions("hey @alice, can you?")).toEqual(["alice"]);
		expect(extractUserMentions("hi @alice.")).toEqual(["alice"]);
	});
});

describe("filterAuthorizedMentionRecipients", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty array when no candidate IDs provided", async () => {
		const result = await filterAuthorizedMentionRecipients(
			[],
			"proj_1",
			"org_1",
		);
		expect(result).toEqual([]);
		expect(db.member.findMany).not.toHaveBeenCalled();
	});

	it("admits candidates who are members of the host organization", async () => {
		(db.member.findMany as any).mockResolvedValue([{ userId: "u_1" }]);
		(db.projectMember.findMany as any).mockResolvedValue([]);

		const result = await filterAuthorizedMentionRecipients(
			["u_1", "u_2"],
			"proj_1",
			"org_1",
		);

		expect(result.sort()).toEqual(["u_1"]);
	});

	it("admits candidates who are accepted project members even without org membership", async () => {
		(db.member.findMany as any).mockResolvedValue([]);
		(db.projectMember.findMany as any).mockResolvedValue([
			{ userId: "u_2" },
		]);

		const result = await filterAuthorizedMentionRecipients(
			["u_1", "u_2"],
			"proj_1",
			null,
		);

		expect(result.sort()).toEqual(["u_2"]);
		expect(db.member.findMany).not.toHaveBeenCalled();
	});

	it("dedups when a candidate is both org and project member", async () => {
		(db.member.findMany as any).mockResolvedValue([{ userId: "u_1" }]);
		(db.projectMember.findMany as any).mockResolvedValue([
			{ userId: "u_1" },
		]);

		const result = await filterAuthorizedMentionRecipients(
			["u_1"],
			"proj_1",
			"org_1",
		);

		expect(result).toEqual(["u_1"]);
	});
});
