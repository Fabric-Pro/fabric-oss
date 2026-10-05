import { describe, expect, it } from "vitest";
import {
	type CommitRow,
	commitBadges,
	providerName,
	revertFailureKey,
	rowSubject,
} from "../instructions-commits";

function row(sha: string, over: Partial<CommitRow> = {}): CommitRow {
	return {
		sha,
		author: { name: "Example Member" },
		date: "2026-10-01T10:00:00Z",
		message: "Subject\n\nBody",
		url: `https://github.com/example-org/instructions/commit/${sha}`,
		parent: "0".repeat(40),
		published: null,
		refused: false,
		isFabric: false,
		...over,
	};
}

describe("the badge each commit carries", () => {
	it("marks the commit Fabric's copy is of, by its sha", () => {
		const rows = [row("a"), row("b", { published: 7 }), row("c")];

		expect(commitBadges(rows, { sha: "b", version: 7 })).toEqual([
			"notSynced",
			"published",
			null,
		]);
	});

	it("marks it by version when the published version names no commit", () => {
		const rows = [row("a"), row("b", { published: 7 })];

		expect(commitBadges(rows, { sha: null, version: 7 })).toEqual([
			"notSynced",
			"published",
		]);
	});

	it("marks a refused commit wherever it is", () => {
		const rows = [
			row("a"),
			row("b", { published: 7 }),
			row("c", { refused: true }),
		];

		expect(commitBadges(rows, { sha: "b", version: 7 })).toEqual([
			"notSynced",
			"published",
			"refused",
		]);
	});

	it("says nothing of an older commit that was passed over, which a later sync's tip made moot", () => {
		const rows = [row("a", { published: 7 }), row("b"), row("c")];

		expect(commitBadges(rows, { sha: "a", version: 7 })).toEqual([
			"published",
			null,
			null,
		]);
	});

	it("leaves a commit that Fabric holds an earlier copy of unmarked", () => {
		const rows = [row("a", { published: 8 }), row("b", { published: 7 })];

		expect(commitBadges(rows, { sha: "a", version: 8 })).toEqual([
			"published",
			null,
		]);
	});

	it("calls every commit without a copy not synced yet when the published one is not among those loaded", () => {
		const rows = [row("a"), row("b", { refused: true }), row("c")];

		expect(commitBadges(rows, { sha: "elsewhere", version: 4 })).toEqual([
			"notSynced",
			"refused",
			"notSynced",
		]);
		expect(commitBadges(rows, { sha: null, version: null })).toEqual([
			"notSynced",
			"refused",
			"notSynced",
		]);
	});

	it("is empty for no commits", () => {
		expect(commitBadges([], { sha: "a", version: 1 })).toEqual([]);
	});
});

describe("a commit's subject", () => {
	it("is the first line of its message", () => {
		expect(rowSubject(row("a", { message: "Tighten lint\n\nBody" }))).toBe(
			"Tighten lint",
		);
		expect(rowSubject(row("a", { message: "One line" }))).toBe("One line");
	});

	it("is null when the message was withheld, however it says so", () => {
		expect(
			rowSubject(row("a", { message: null, messageWithheld: true })),
		).toBeNull();
		expect(rowSubject(row("a", { message: null }))).toBeNull();
		expect(
			rowSubject(row("a", { message: "Leaked", messageWithheld: true })),
		).toBeNull();
	});
});

describe("the refusals of a revert", () => {
	it.each([
		["REVERT_CONFLICT", "conflict"],
		["BRANCH_PROTECTED", "protected"],
		["BRANCH_BUSY", "busy"],
		["REVERT_BUSY", "queued"],
		["REVERT_REJECTED", "rejected"],
		["REVERT_TOO_LARGE", "tooLarge"],
		["REVERT_EMPTY", "empty"],
		["REVERT_UNSUPPORTED", "unsupported"],
		["COMMIT_NOT_FOUND", "notFound"],
	])("words %s as %s", (code, key) => {
		expect(revertFailureKey({ code: "CONFLICT", data: { code } })).toBe(
			key,
		);
	});

	it("leaves anything else to the shared error map", () => {
		expect(
			revertFailureKey({ code: "CONFLICT", data: { code: "NEW_CODE" } }),
		).toBeNull();
		expect(
			revertFailureKey({ data: { errorCode: "PROJECT_READ_ONLY" } }),
		).toBeNull();
		expect(revertFailureKey(new Error("boom"))).toBeNull();
		expect(revertFailureKey(null)).toBeNull();
	});
});

describe("a provider's name", () => {
	it("is how a person says it", () => {
		expect(providerName("GITHUB")).toBe("GitHub");
		expect(providerName("GITLAB")).toBe("GitLab");
		expect(providerName("AZURE_DEVOPS")).toBe("Azure DevOps");
		expect(providerName("BITBUCKET")).toBeNull();
	});
});
