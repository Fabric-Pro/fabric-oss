import { describe, expect, it } from "vitest";
import { presentRepositoryCommit } from "../commit-presentation";

const SHA = "a".repeat(40);

describe("presentRepositoryCommit", () => {
	it("keeps native history metadata safe for the shared commit dialog", () => {
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const row = presentRepositoryCommit({
			sha: SHA,
			authorName: secret,
			committerName: "Fabric",
			date: "2026-10-06T12:00:00.000Z",
			message: `Rotate ${secret}`,
			url: `https://example.invalid/commit/${SHA}`,
			parent: null,
		});

		expect(row).toEqual({
			sha: SHA,
			author: { name: "a Fabric user" },
			date: "2026-10-06T12:00:00.000Z",
			message: null,
			messageWithheld: true,
			url: `https://example.invalid/commit/${SHA}`,
			parent: null,
			published: null,
			refused: false,
			isFabric: true,
		});
		expect(JSON.stringify(row)).not.toContain(secret);
	});
});
