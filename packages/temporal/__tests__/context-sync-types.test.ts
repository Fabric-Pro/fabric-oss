/**
 * The Living Memory sync's shared vocabulary (design 2026-09-23 §5.2, §5.5):
 * the error union is the Prisma enum value for value, the retry split is the
 * design's, and the run key is `<syncId>:<workflow run id>`.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/context-sync-types.test.ts
 */
import { ProjectContextSyncErrorSchema } from "@repo/database/prisma/zod";
import { describe, expect, it } from "vitest";
import {
	contextSyncRunKey,
	isContextSyncErrorCode,
	NON_RETRYABLE_CONTEXT_SYNC_ERRORS,
} from "../src/lib/context-sync-types";

describe("ProjectContextSyncError", () => {
	it("is the Prisma enum, value for value", () => {
		const prisma = [...ProjectContextSyncErrorSchema.options].sort();
		const ours = prisma.filter(isContextSyncErrorCode);

		expect(ours).toEqual(prisma);
		expect(isContextSyncErrorCode("TREE_REFUSED")).toBe(false);
		expect(isContextSyncErrorCode(42)).toBe(false);
	});

	it("retries CLONE_FAILED, INTEGRATION_UNAVAILABLE and STORE_FAILED, and nothing else", () => {
		const all = [...ProjectContextSyncErrorSchema.options];
		const retryable = all.filter(
			(code) => !NON_RETRYABLE_CONTEXT_SYNC_ERRORS.includes(code),
		);

		expect(retryable.sort()).toEqual([
			"CLONE_FAILED",
			"INTEGRATION_UNAVAILABLE",
			"STORE_FAILED",
		]);
		expect(NON_RETRYABLE_CONTEXT_SYNC_ERRORS).toHaveLength(all.length - 3);
	});
});

describe("contextSyncRunKey", () => {
	it("is `<syncId>:<workflow run id>`, the shape the API's reconciliation splits", () => {
		expect(contextSyncRunKey("sync_1", "run-a")).toBe("sync_1:run-a");
	});
});
