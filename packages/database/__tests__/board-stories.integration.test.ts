import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as Client | null }));
vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		$queryRaw: async (sql: { text: string; values: unknown[] }) =>
			(await state.client?.query(sql.text, sql.values))?.rows,
	},
}));

import { Prisma } from "../prisma/client";
import {
	searchStoryDescriptions,
	storyTextPresent,
} from "../prisma/queries/projects/stories";

const enabled = process.env.RUN_DB_INTEGRATION === "1";
describe.skipIf(!enabled)("board text flags on local Postgres", () => {
	const client = new Client({
		connectionString: process.env.BOARD_TEST_DATABASE_URL,
	});
	beforeAll(async () => {
		const url = new URL(process.env.BOARD_TEST_DATABASE_URL ?? "");
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
			throw new Error("Local database required");
		}
		await client.connect();
		state.client = client;
		await client.query(
			'CREATE TEMP TABLE user_story (id text, "projectId" text, description text)',
		);
		await client.query(
			"INSERT INTO user_story VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)",
			[
				"example-one",
				"example-project",
				"Alpha % _ \\ 'quote",
				"example-two",
				"other-project",
				"Alpha % _ \\ 'quote",
				"example-three",
				"example-project",
				"beta",
			],
		);
	});
	afterAll(async () => client.end());
	it("returns matching literal needles per story within one project", async () => {
		expect(
			await searchStoryDescriptions("example-project", [
				"alpha",
				"%",
				"_",
				"\\",
				"'quote",
				"absent",
			]),
		).toEqual([
			{ id: "example-one", needles: ["alpha", "%", "_", "\\", "'quote"] },
		]);
		expect(
			await searchStoryDescriptions("example-project", ["beta"]),
		).toEqual([{ id: "example-three", needles: ["beta"] }]);
	});
	it("agrees with JS trim including long whitespace, NBSP and Unicode separators", async () => {
		const whitespace =
			"\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
		for (const value of [
			null,
			"",
			whitespace,
			whitespace.repeat(500),
			`${whitespace.repeat(4)}text`,
			" ".repeat(100),
			"short",
			"x".repeat(50000),
			"\u0085",
			"\u200b",
		]) {
			for (const column of [
				"description",
				"acceptanceCriteria",
			] as const) {
				const sql = Prisma.sql`SELECT ${storyTextPresent(column)} AS present FROM (SELECT ${value}::text AS description, ${value}::text AS "acceptanceCriteria") v`;
				const result = await client.query(sql.text, sql.values);
				expect(
					result.rows[0].present,
					JSON.stringify(value?.slice(0, 40)),
				).toBe(!!value?.trim());
			}
		}
	});
});
