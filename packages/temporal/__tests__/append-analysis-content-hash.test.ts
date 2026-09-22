/**
 * `appendAnalysisContentChunk` keeps `contentHash` in step with the content it
 * assembles chunk by chunk (Fizzy #2619).
 *
 * What this pins:
 *  - a non-final append clears the hash: a partial body is not the document,
 *    and must not be matched as a duplicate of anything;
 *  - the final append reads the assembled content back inside the same
 *    transaction as its write and stamps exactly `hashContextContent` of it.
 *
 * Run with: pnpm --filter @repo/temporal test -- __tests__/append-analysis-content-hash.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecuteRaw, txExecuteRaw, txFindUnique, txUpdate, transaction } =
	vi.hoisted(() => {
		const txExecuteRaw = vi.fn();
		const txFindUnique = vi.fn();
		const txUpdate = vi.fn();
		const tx = {
			$executeRaw: txExecuteRaw,
			projectContext: { findUnique: txFindUnique, update: txUpdate },
		};
		return {
			dbExecuteRaw: vi.fn(),
			txExecuteRaw,
			txFindUnique,
			txUpdate,
			transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
				fn(tx),
			),
		};
	});

vi.mock("@repo/database", () => ({
	db: { $executeRaw: dbExecuteRaw, $transaction: transaction },
	resolveModelWithCredentials: vi.fn(),
	tenantWhere: vi.fn(),
}));
vi.mock("@repo/ai", () => ({ resolveProviderApiKey: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/rag/lib/project-contexts/auto-embed", () => ({
	embedProjectContext: vi.fn(),
}));
vi.mock("../src/activities/pm-integration/fetch-pm-hierarchy", () => ({
	fetchPMWorkItemsByType: vi.fn(),
}));
vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
}));

import { appendAnalysisContentChunk } from "../src/activities/existing-project-setup";

/** The SQL text of a tagged-template `$executeRaw` call. */
function sqlOf(mock: ReturnType<typeof vi.fn>) {
	const strings = mock.mock.calls.at(-1)?.[0] as TemplateStringsArray;
	return strings.join("?");
}

beforeEach(() => {
	vi.clearAllMocks();
	dbExecuteRaw.mockResolvedValue(1);
	txExecuteRaw.mockResolvedValue(1);
	txUpdate.mockResolvedValue({});
});

describe("appendAnalysisContentChunk — contentHash", () => {
	it("clears the hash on a non-final append", async () => {
		await appendAnalysisContentChunk({
			contextId: "ctx-1",
			chunk: "part one",
			isFinal: false,
		});

		expect(sqlOf(dbExecuteRaw)).toMatch(/"contentHash"\s*=\s*NULL/);
		expect(transaction).not.toHaveBeenCalled();
		expect(txUpdate).not.toHaveBeenCalled();
	});

	it("stamps the hash of the assembled content in the final append's transaction", async () => {
		const assembled = "part one, part two — final ✓";
		txFindUnique.mockResolvedValue({ content: assembled });

		await appendAnalysisContentChunk({
			contextId: "ctx-1",
			chunk: "part two — final ✓",
			isFinal: true,
		});

		expect(transaction).toHaveBeenCalledTimes(1);
		expect(sqlOf(txExecuteRaw)).toMatch(/'COMPLETED'/);
		expect(txFindUnique).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			select: { content: true },
		});
		expect(txUpdate).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: {
				contentHash: createHash("sha256")
					.update(assembled, "utf8")
					.digest("hex"),
			},
		});
		// The write and the hash share one transaction; nothing ran outside it.
		expect(dbExecuteRaw).not.toHaveBeenCalled();
	});
});
