/**
 * The Living Memory sync's shared vocabulary (design 2026-09-23 §5.2, §5.5,
 * §11.1): the error and trigger unions are the Prisma enums value for value,
 * the automatic triggers are the poll's and the webhook's, the retry split
 * is the design's, and the run key is `<syncId>:<workflow run id>`.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/context-sync-types.test.ts
 */
import {
	ProjectContextSyncErrorSchema,
	ProjectContextSyncTriggerSchema,
} from "@repo/database/prisma/zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	AUTOMATIC_CONTEXT_SYNC_TRIGGERS,
	type AutomaticContextSyncTrigger,
	type ContextSyncTrigger,
	contextSyncRunKey,
	isAutomaticContextSyncTrigger,
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

describe("ContextSyncTrigger (§11.1)", () => {
	it("is the Prisma enum, value for value, so every stored trigger reads back", () => {
		expectTypeOf<ContextSyncTrigger>().toEqualTypeOf<
			(typeof ProjectContextSyncTriggerSchema.options)[number]
		>();
		expect([...ProjectContextSyncTriggerSchema.options].sort()).toEqual([
			"MANUAL",
			"POLL",
			"WEBHOOK",
		]);
	});

	it("starts automatically only from the poll and the push webhook", () => {
		expect([...AUTOMATIC_CONTEXT_SYNC_TRIGGERS]).toEqual([
			"POLL",
			"WEBHOOK",
		]);
		expectTypeOf<AutomaticContextSyncTrigger>().toEqualTypeOf<
			"POLL" | "WEBHOOK"
		>();
		expect(isAutomaticContextSyncTrigger("POLL")).toBe(true);
		expect(isAutomaticContextSyncTrigger("WEBHOOK")).toBe(true);
		expect(isAutomaticContextSyncTrigger("MANUAL")).toBe(false);
	});
});

describe("contextSyncRunKey", () => {
	it("is `<syncId>:<workflow run id>`, the shape the API's reconciliation splits", () => {
		expect(contextSyncRunKey("sync_1", "run-a")).toBe("sync_1:run-a");
	});
});
