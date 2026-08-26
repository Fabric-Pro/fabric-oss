/**
 * Tests for the `functionTags.getMyDefault` / `functionTags.setMyDefault`
 * self-service oRPC procedures (Role/Function Tags Stage 1, Task 6).
 *
 * Two seams, per the Codex plan finding: the stubbed-chain harness below
 * makes `.input()` a no-op, so a direct handler call does NOT exercise Zod
 * validation. That means:
 *
 *   1. Closed-vocabulary enforcement is verified at the SCHEMA level,
 *      directly against `FunctionTagSchema` — this is the real guard that
 *      `.input(z.object({ tags: z.array(FunctionTagSchema) }))` composes.
 *   2. Handler BEHAVIOR (dedup, pass-through, return shape) is verified by
 *      mocking the `@repo/database` helper functions the procedures import
 *      (`getUserDefaultFunctionTags` / `setUserDefaultFunctionTags`) and
 *      invoking the captured handler directly. Mocking `db.user.update`
 *      would do nothing — the helpers close over their own `db`.
 *
 * Mirrors the harness style in
 * `packages/api/modules/projects/procedures/__tests__/audit-emission.test.ts`.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/function-tags
 */

import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Schema-level: closed vocabulary (the real guard behind `.input(...)`)
// ---------------------------------------------------------------------------

describe("FunctionTagSchema closed vocabulary", () => {
	it("rejects a value outside the 8-tag enum", () => {
		expect(() => FunctionTagSchema.array().parse(["MANAGER"])).toThrow();
	});

	it("parses every valid tag", () => {
		const valid = [
			"PRODUCT_OWNER",
			"PRODUCT_CONTRIBUTOR",
			"DEVELOPER",
			"ARCHITECT",
			"DESIGNER",
			"SDET_QA",
			"SME",
			"STAKEHOLDER",
		];
		expect(() => FunctionTagSchema.array().parse(valid)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Handler behavior: mock the helper functions the procedures import
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	getUserDefaultFunctionTags: vi.fn(),
	setUserDefaultFunctionTags: vi.fn(),
	isFeatureEnabled: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getUserDefaultFunctionTags: mocks.getUserDefaultFunctionTags,
		setUserDefaultFunctionTags: mocks.setUserDefaultFunctionTags,
		isFeatureEnabled: mocks.isFeatureEnabled,
	};
});

// Stub the procedure builder so we can extract the raw handlers. `.input()`
// and `.output()` are intentionally no-ops here — see file header.
vi.mock("../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		protectedProcedure: chainable,
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

setSlot("getMyDefault");
await import("../get-my-default");

setSlot("setMyDefault");
await import("../set-my-default");

const USER_ID = "u1";
const baseCtx = { user: { id: USER_ID } };

beforeEach(() => {
	mocks.getUserDefaultFunctionTags.mockReset();
	mocks.setUserDefaultFunctionTags.mockReset();
	mocks.isFeatureEnabled.mockReset();
});

describe("getMyDefaultProcedure", () => {
	it("returns the tags resolved by getUserDefaultFunctionTags", async () => {
		mocks.getUserDefaultFunctionTags.mockResolvedValue(["ARCHITECT"]);
		mocks.isFeatureEnabled.mockResolvedValue(false);

		const result = await mocks.captured.getMyDefault({
			context: baseCtx,
			input: undefined,
		});

		expect(
			mocks.getUserDefaultFunctionTags,
		).toHaveBeenCalledExactlyOnceWith(USER_ID);
		expect(result).toEqual({
			tags: ["ARCHITECT"],
			enforcementEnabled: false,
		});
	});

	it("reports enforcementEnabled from the flag", async () => {
		mocks.getUserDefaultFunctionTags.mockResolvedValue(["DEVELOPER"]);
		mocks.isFeatureEnabled.mockResolvedValue(true);

		const result = await mocks.captured.getMyDefault({
			context: baseCtx,
			input: undefined,
		});

		expect(result).toEqual({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"ROLE_TAG_ENFORCEMENT",
		);
	});

	it("reports enforcementEnabled false when the flag is off", async () => {
		mocks.getUserDefaultFunctionTags.mockResolvedValue([]);
		mocks.isFeatureEnabled.mockResolvedValue(false);

		const result = await mocks.captured.getMyDefault({
			context: baseCtx,
			input: undefined,
		});

		expect(result).toEqual({ tags: [], enforcementEnabled: false });
	});
});

describe("setMyDefaultProcedure", () => {
	it("dedupes input tags before persisting and returns the deduped set", async () => {
		mocks.setUserDefaultFunctionTags.mockResolvedValue(undefined);

		const result = await mocks.captured.setMyDefault({
			context: baseCtx,
			input: { tags: ["DEVELOPER", "DEVELOPER"] },
		});

		expect(
			mocks.setUserDefaultFunctionTags,
		).toHaveBeenCalledExactlyOnceWith(USER_ID, ["DEVELOPER"]);
		expect(result).toEqual({ tags: ["DEVELOPER"] });
	});
});
