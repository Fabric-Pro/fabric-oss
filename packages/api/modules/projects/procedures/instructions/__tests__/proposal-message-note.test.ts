import { describe, expect, it } from "vitest";
import { noteWithCommitMessage } from "../proposal-message-note";

describe("noteWithCommitMessage", () => {
	it("makes a typed commit message the suggestion's title", () => {
		// Arrange
		const message = "Tighten the review rules";

		// Act
		const note = noteWithCommitMessage(undefined, message);

		// Assert
		expect(note).toEqual({ title: "Tighten the review rules" });
	});

	it("keeps an explicit note title and its description", () => {
		// Arrange
		const note = { title: "My title", body: "Why" };

		// Act
		const result = noteWithCommitMessage(note, "Typed message");

		// Assert
		expect(result).toEqual(note);
	});

	it("leaves the note alone when no message was typed", () => {
		// Act / Assert
		expect(noteWithCommitMessage({ body: "Why" }, "  ")).toEqual({
			body: "Why",
		});
		expect(noteWithCommitMessage(undefined, undefined)).toBeUndefined();
	});

	it("keeps the remainder of an over-long message in the description", () => {
		// Arrange
		const message = `${"a".repeat(120)}${"b".repeat(30)}`;

		// Act
		const note = noteWithCommitMessage({ body: "Why" }, message);

		// Assert
		expect(note?.title).toBe("a".repeat(120));
		expect(note?.body).toBe(`${"b".repeat(30)}\n\nWhy`);
	});
});
