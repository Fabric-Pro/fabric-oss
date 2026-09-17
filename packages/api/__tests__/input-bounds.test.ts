/**
 * Input bounds on high-traffic user-typed fields.
 *
 * These read the REAL input schema off the procedure (`["~orpc"].inputSchema`)
 * rather than a copy, so the assertion is about what the wire accepts. Each
 * case pairs a rejection just over the ceiling with an acceptance just under
 * it, so a bound that is accidentally too tight fails as loudly as one that is
 * missing.
 *
 * The ceilings themselves live in `lib/zod-bounds.ts`; this file pins that
 * they are applied where they matter, not their exact values.
 *
 * Run with:
 *   pnpm --filter @repo/api test __tests__/input-bounds.test.ts
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

import { INPUT_BOUNDS } from "../lib/zod-bounds";
import { addMessageToChat } from "../modules/ai/procedures/add-message-to-chat";
import { createProjectProcedure } from "../modules/projects/procedures/create-project";
import { searchStoriesProcedure } from "../modules/projects/procedures/search-stories";
import { versionProcedures } from "../modules/prompts/procedures/version";

type Parseable = {
	safeParse(input: unknown): { success: boolean };
};

function inputSchemaOf(procedure: unknown): Parseable {
	const schema = (procedure as { "~orpc": { inputSchema?: unknown } })[
		"~orpc"
	].inputSchema;
	expect(schema, "procedure has no input schema").toBeDefined();
	return schema as Parseable;
}

describe("chat message text (ai.addMessageToChat)", () => {
	const schema = inputSchemaOf(addMessageToChat);
	const message = (text: string) => ({
		chatId: "chat-1",
		messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
	});

	it("accepts a message at the ceiling", () => {
		expect(
			schema.safeParse(message("x".repeat(INPUT_BOUNDS.text))).success,
		).toBe(true);
	});

	it("rejects a message one character over", () => {
		expect(
			schema.safeParse(message("x".repeat(INPUT_BOUNDS.text + 1)))
				.success,
		).toBe(false);
	});

	it("caps the number of attached document ids", () => {
		const ids = (n: number) => ({
			...message("hi"),
			documentIds: Array.from({ length: n }, (_, i) => `doc-${i}`),
		});
		expect(schema.safeParse(ids(INPUT_BOUNDS.idArray)).success).toBe(true);
		expect(schema.safeParse(ids(INPUT_BOUNDS.idArray + 1)).success).toBe(
			false,
		);
	});
});

describe("prompt version content (prompts.version.create)", () => {
	const schema = inputSchemaOf(versionProcedures.create);

	it("accepts prompt text at the ceiling", () => {
		expect(
			schema.safeParse({
				id: "p1",
				content: "x".repeat(INPUT_BOUNDS.text),
			}).success,
		).toBe(true);
	});

	it("rejects prompt text over the ceiling", () => {
		expect(
			schema.safeParse({
				id: "p1",
				content: "x".repeat(INPUT_BOUNDS.text + 1),
			}).success,
		).toBe(false);
	});
});

describe("search query (projects.searchStories)", () => {
	const schema = inputSchemaOf(searchStoriesProcedure);

	it("accepts a long but plausible query", () => {
		expect(
			schema.safeParse({
				projectId: "proj-1",
				query: "q".repeat(INPUT_BOUNDS.name),
			}).success,
		).toBe(true);
	});

	it("rejects a query over the ceiling", () => {
		expect(
			schema.safeParse({
				projectId: "proj-1",
				query: "q".repeat(INPUT_BOUNDS.name + 1),
			}).success,
		).toBe(false);
	});
});

describe("project description and tags (projects.create)", () => {
	const schema = inputSchemaOf(createProjectProcedure);

	it("accepts a description at the ceiling and a full tag list", () => {
		expect(
			schema.safeParse({
				name: "Project",
				description: "d".repeat(INPUT_BOUNDS.description),
				tags: Array.from({ length: INPUT_BOUNDS.idArray }, (_, i) =>
					String(i),
				),
			}).success,
		).toBe(true);
	});

	it("rejects a description over the ceiling", () => {
		expect(
			schema.safeParse({
				name: "Project",
				description: "d".repeat(INPUT_BOUNDS.description + 1),
			}).success,
		).toBe(false);
	});

	it("rejects one tag too many, and a single oversized tag", () => {
		expect(
			schema.safeParse({
				name: "Project",
				tags: Array.from({ length: INPUT_BOUNDS.idArray + 1 }, (_, i) =>
					String(i),
				),
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				name: "Project",
				tags: ["t".repeat(INPUT_BOUNDS.name + 1)],
			}).success,
		).toBe(false);
	});
});
