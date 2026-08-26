/**
 * Unit tests for the cross-kind prompt guard (Fizzy #2048, U3 / R3 / AE2).
 *
 * The contract under test is DENY BY DEFAULT. A `PromptBinding` row's
 * `storyKind` is nullable, and one prompt version can carry many rows across
 * document types and scopes, so "the chosen prompt's kind scope" is neither
 * singular nor guaranteed to exist. Only an explicitly NULL scope counts as
 * kind-agnostic; an absent binding is an absence of evidence, not permission.
 *
 * `assertPromptKindCompatible` is the pure decision and is tested exhaustively;
 * `validatePromptForKind` is the lookup around it, tested for the shape of the
 * binding query and for what it does when that query comes back empty.
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

const { assertPromptKindCompatible, validatePromptForKind } = await import(
	"../validate-prompt-for-kind"
);

beforeEach(() => {
	mocks.promptBindingFindMany.mockReset();
	mocks.promptBindingFindMany.mockResolvedValue([]);
});

describe("assertPromptKindCompatible — a prompt bound to the other kind is refused", () => {
	it("refuses a FEATURE-bound prompt on a BUG work item", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			}),
		).toThrow();
	});

	it("refuses a BUG-bound prompt on a FEATURE work item", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: ["BUG"],
				kind: "FEATURE",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			}),
		).toThrow();
	});

	it("names BOTH kinds and the way out, because the caller renders the message verbatim", () => {
		let message = "";
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			});
		} catch (error) {
			message = (error as { message: string }).message;
		}

		// The item's kind, the prompt's bound kind, the prompt itself, and the
		// recovery action all have to be in the string a reviewer sees.
		expect(message).toContain("BUG");
		expect(message).toContain("FEATURE");
		expect(message).toContain("Clean spec rewrite");
		expect(message).toMatch(/pick a prompt/i);
	});

	it("throws a BAD_REQUEST, the same class the stage guard throws", () => {
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			});
			throw new Error("expected a refusal");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("BAD_REQUEST");
		}
	});
});

describe("assertPromptKindCompatible — what is allowed", () => {
	it("allows a prompt bound to the work item's own kind", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: ["BUG"],
				kind: "BUG",
				promptLabel: "Bug triage rewrite",
				documentType: "DRAFT",
			}),
		).not.toThrow();
	});

	it("allows a NULL kind scope for a BUG — explicitly kind-agnostic", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: [null],
				kind: "BUG",
				promptLabel: "PRD generator",
				documentType: "PRD",
			}),
		).not.toThrow();
	});

	it("allows the same NULL kind scope for a FEATURE", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: [null],
				kind: "FEATURE",
				promptLabel: "PRD generator",
				documentType: "PRD",
			}),
		).not.toThrow();
	});

	it("allows when one of several rows matches the kind", () => {
		// One prompt version, many binding rows. A single matching row is enough.
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: ["FEATURE", "BUG"],
				kind: "BUG",
				promptLabel: "Shared drafting prompt",
				documentType: "DRAFT",
			}),
		).not.toThrow();
	});
});

describe("assertPromptKindCompatible — no binding is a refusal, not a pass", () => {
	it("refuses an empty kind-scope set rather than treating it as kind-agnostic", () => {
		// The natural misreading: "no binding found, so nothing constrains it".
		// That reading turns the guard off for every prompt a caller can name.
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: [],
				kind: "BUG",
				promptLabel: "Unbound prompt",
				documentType: "DRAFT",
			}),
		).toThrow();
	});

	it("says the prompt is bound to no kind at all, and names the item's kind", () => {
		let message = "";
		try {
			assertPromptKindCompatible({
				kindScopes: [],
				kind: "BUG",
				promptLabel: "Unbound prompt",
				documentType: "DRAFT",
			});
		} catch (error) {
			message = (error as { message: string }).message;
		}

		expect(message).toContain("Unbound prompt");
		expect(message).toContain("BUG");
		expect(message).toContain("DRAFT");
		expect(message).toMatch(/not bound to any work item kind/i);
	});
});

describe("validatePromptForKind — the binding lookup", () => {
	it("asks only about bindings at the requested document type", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Bug triage rewrite",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
			organizationId: "org-1",
		});

		const where = mocks.promptBindingFindMany.mock.calls[0][0].where;
		expect(where.documentType).toBe("DRAFT");
		expect(where.targetType).toBe("AGENT");
		expect(where.promptVersion).toEqual({ promptId: "prompt-1" });
	});

	it("refuses a prompt whose only binding sits at a DIFFERENT document type", async () => {
		// The query is document-type scoped, so a prompt bound to the other kind
		// at some other action comes back empty here — and empty is a refusal.
		mocks.promptBindingFindMany.mockResolvedValue([]);

		await expect(
			validatePromptForKind({
				promptId: "prompt-bound-elsewhere",
				promptLabel: "Feature spec rewrite",
				kind: "BUG",
				documentType: "CLEAN_SPEC",
				userId: "user-1",
			}),
		).rejects.toThrow(/not bound to any work item kind/i);
	});

	it("refuses when the only binding at this document type carries the other kind", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		await expect(
			validatePromptForKind({
				promptId: "prompt-1",
				promptLabel: "Feature spec rewrite",
				kind: "BUG",
				documentType: "DRAFT",
				userId: "user-1",
			}),
		).rejects.toThrow(/FEATURE/);
	});

	it("resolves silently when a NULL-scoped binding exists", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: null }]);

		await expect(
			validatePromptForKind({
				promptId: "prompt-1",
				promptLabel: "PRD generator",
				kind: "BUG",
				documentType: "PRD",
				userId: "user-1",
			}),
		).resolves.toBeUndefined();
	});

	it("scopes binding visibility to SYSTEM plus the caller's own org and user", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Bug triage rewrite",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
			organizationId: "org-1",
		});

		const where = mocks.promptBindingFindMany.mock.calls[0][0].where;
		expect(where.OR).toEqual([
			{ scope: "SYSTEM" },
			{ scope: "ORG", organizationId: "org-1" },
			{ scope: "USER", userId: "user-1" },
		]);
	});

	it("never looks at an organization's bindings in personal context", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await validatePromptForKind({
			promptId: "prompt-1",
			promptLabel: "Bug triage rewrite",
			kind: "BUG",
			documentType: "DRAFT",
			userId: "user-1",
		});

		const where = mocks.promptBindingFindMany.mock.calls[0][0].where;
		expect(where.OR).toEqual([
			{ scope: "SYSTEM" },
			{ scope: "USER", userId: "user-1" },
		]);
	});
});
