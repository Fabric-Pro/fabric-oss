/**
 * `appendMessages` — single atomic jsonb-concat UPDATE.
 *
 * Locks the contract: ONE parameterized raw-SQL statement (no read-modify-write
 * — concurrent appends must both land), `title` only promoted when provided
 * (COALESCE), `"updatedAt"` bumped explicitly (raw SQL bypasses Prisma's
 * `@updatedAt`), and the affected-row count is returned so the pre-stream user
 * write can treat a missing conversation as a failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecuteRaw = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		$executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
		atlasConversation: {
			findUnique: (...args: unknown[]) => mockFindUnique(...args),
			update: (...args: unknown[]) => mockUpdate(...args),
		},
	},
	Prisma: {},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
}));

import { appendMessages } from "../queries";
import type { StoredChatMessage } from "../types";

function lastCall(): { sql: string; values: unknown[] } {
	const [strings, ...values] = mockExecuteRaw.mock.calls.at(-1) as [
		TemplateStringsArray,
		...unknown[],
	];
	return { sql: strings.join("?"), values };
}

const userTurn: StoredChatMessage[] = [
	{ role: "user", content: "How does auth work?", createdAt: "2026-06-06" },
];

beforeEach(() => {
	vi.clearAllMocks();
	mockExecuteRaw.mockResolvedValue(1);
});

describe("appendMessages — atomic UPDATE shape", () => {
	it("issues exactly one raw UPDATE (no read-modify-write)", async () => {
		await appendMessages("c1", userTurn, "How does auth work?");

		expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
		expect(mockFindUnique).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();

		const { sql } = lastCall();
		expect(sql).toContain("UPDATE atlas_conversation");
		expect(sql).toContain("COALESCE(messages, '[]'::jsonb) ||");
		expect(sql).toContain("::jsonb");
		expect(sql).toContain("title = COALESCE(");
		// Quoted exact-case identifier: the Prisma model maps only the TABLE
		// name; `updatedAt` has no @map, so the real column is "updatedAt".
		expect(sql).toContain('"updatedAt" = now()');
		expect(sql).toContain("WHERE id =");
	});

	it("binds the messages as a JSON payload, the title, and the conversation id", async () => {
		await appendMessages("c1", userTurn, "Promoted title");

		const { values } = lastCall();
		expect(values).toEqual([
			JSON.stringify(userTurn),
			"Promoted title",
			"c1",
		]);
	});

	it("binds NULL for the title when not provided, leaving the stored title untouched", async () => {
		await appendMessages("c1", userTurn);

		const { values } = lastCall();
		expect(values[1]).toBeNull();
	});

	it("serializes the interrupted marker on salvaged assistant turns", async () => {
		const interrupted: StoredChatMessage[] = [
			{
				role: "assistant",
				content: "partial ans",
				createdAt: "2026-06-06",
				interrupted: true,
			},
		];

		await appendMessages("c1", interrupted);

		const { values } = lastCall();
		expect(values[0]).toContain('"interrupted":true');
	});

	it("returns the affected-row count (1 on success, 0 when the row is missing)", async () => {
		mockExecuteRaw.mockResolvedValueOnce(1);
		await expect(appendMessages("c1", userTurn)).resolves.toBe(1);

		mockExecuteRaw.mockResolvedValueOnce(0);
		await expect(appendMessages("gone", userTurn)).resolves.toBe(0);
	});
});
