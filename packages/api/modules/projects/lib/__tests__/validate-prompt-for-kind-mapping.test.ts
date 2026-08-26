/**
 * The api side of the cross-kind prompt guard is now a protocol mapping and
 * nothing else (Fizzy #2048, U1). The decision and the binding lookup live in
 * `@repo/temporal/prompt-kind-guard`, which throws a typed
 * `PromptKindMismatchError` because the workflow package carries no orpc
 * dependency.
 *
 * What is pinned here is that mapping: BOTH exports — the synchronous decision
 * and the async lookup — must turn that typed error into the same
 * `BAD_REQUEST`, with a message that is byte-identical to the core's. The
 * message is rendered to the reviewer verbatim, so a wrapper that re-words,
 * prefixes or truncates it changes what a user is told without changing any
 * behaviour a coarser assertion would catch.
 *
 * The rule itself (deny by default, NULL is the only kind-agnostic scope) is
 * covered exhaustively in `validate-prompt-for-kind.test.ts` here and in
 * `packages/temporal/__tests__/prompt-kind-guard.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	promptBindingFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		promptBinding: {
			findMany: mocks.promptBindingFindMany,
		},
	},
}));

const core = await import("@repo/temporal/prompt-kind-guard");
const { assertPromptKindCompatible, validatePromptForKind } = await import(
	"../validate-prompt-for-kind"
);

/** The core's own refusal message for a set of arguments, captured verbatim. */
function coreMessageFor(args: {
	kindScopes: readonly (string | null)[];
	kind: "BUG" | "FEATURE";
	promptLabel: string;
	documentType: string;
}): string {
	try {
		core.assertPromptKindCompatible(
			args as Parameters<typeof core.assertPromptKindCompatible>[0],
		);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the core guard to refuse");
}

beforeEach(() => {
	mocks.promptBindingFindMany.mockReset();
	mocks.promptBindingFindMany.mockResolvedValue([]);
});

describe("the synchronous wrapper maps the typed error to a refusal", () => {
	const args = {
		kindScopes: ["FEATURE"] as const,
		kind: "BUG" as const,
		promptLabel: "Clean spec rewrite",
		documentType: "DRAFT",
	};

	it("throws BAD_REQUEST, not the typed error", () => {
		try {
			assertPromptKindCompatible(args);
			throw new Error("expected a refusal");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("BAD_REQUEST");
			expect(error).not.toBeInstanceOf(core.PromptKindMismatchError);
		}
	});

	it("passes the core's message through byte for byte", () => {
		try {
			assertPromptKindCompatible(args);
			throw new Error("expected a refusal");
		} catch (error) {
			expect((error as Error).message).toBe(coreMessageFor(args));
		}
	});

	it("re-throws anything that is not a kind mismatch untouched", async () => {
		// A failing binding lookup is not a refusal and must not be dressed up as
		// one: a 400 tells the reviewer to pick a different prompt, which would be
		// a lie about an outage.
		const unrelated = new Error("binding lookup failed");
		mocks.promptBindingFindMany.mockRejectedValue(unrelated);

		await expect(
			validatePromptForKind({
				promptId: "prompt-1",
				promptLabel: "Clean spec rewrite",
				kind: "BUG",
				documentType: "DRAFT",
				userId: "user-1",
			}),
		).rejects.toBe(unrelated);
	});
});

describe("the async wrapper maps the same typed error to the same refusal", () => {
	it("refuses a cross-kind binding with the core's exact message and code", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		const error = await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Clean spec rewrite",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
		}).then(
			() => {
				throw new Error("expected a refusal");
			},
			(caught: unknown) => caught,
		);

		expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		expect((error as Error).message).toBe(
			coreMessageFor({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			}),
		);
	});

	it("refuses an unbound prompt with the core's exact message and code", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([]);

		const error = await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Unbound prompt",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
		}).then(
			() => {
				throw new Error("expected a refusal");
			},
			(caught: unknown) => caught,
		);

		expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		expect((error as Error).message).toBe(
			coreMessageFor({
				kindScopes: [],
				kind: "BUG",
				promptLabel: "Unbound prompt",
				documentType: "DRAFT",
			}),
		);
	});

	it("agrees with the synchronous wrapper on both message and code", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		const asyncError = await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Clean spec rewrite",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
		}).then(
			() => {
				throw new Error("expected a refusal");
			},
			(caught: unknown) => caught,
		);

		let syncError: unknown;
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			});
		} catch (caught) {
			syncError = caught;
		}

		expect((asyncError as Error).message).toBe(
			(syncError as Error).message,
		);
		expect((asyncError as { code?: string }).code).toBe(
			(syncError as { code?: string }).code,
		);
	});
});
