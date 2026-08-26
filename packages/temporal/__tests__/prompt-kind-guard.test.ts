/**
 * Unit tests for the cross-kind prompt guard now that it lives in
 * `@repo/temporal` (Fizzy #2048, U1 / R3 / AE2).
 *
 * The contract under test is DENY BY DEFAULT. A `PromptBinding` row's
 * `storyKind` is nullable, and one prompt version can carry many rows across
 * document types and scopes, so "the chosen prompt's kind scope" is neither
 * singular nor guaranteed to exist. Only an explicitly NULL scope counts as
 * kind-agnostic; an absent binding is an absence of evidence, not permission.
 *
 * The second thing pinned here is the error TYPE. This module is imported by
 * the creation path inside this package, so it must refuse with a plain typed
 * error and carry no orpc dependency — `@repo/api` is the layer that turns the
 * refusal into a 400, and that mapping is covered on the api side.
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

const {
	assertPromptKindCompatible,
	PromptKindMismatchError,
	validatePromptForKind,
} = await import("../src/lib/prompt-kind-guard");

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
		).toThrow(PromptKindMismatchError);
	});

	it("refuses a BUG-bound prompt on a FEATURE work item", () => {
		expect(() =>
			assertPromptKindCompatible({
				kindScopes: ["BUG"],
				kind: "FEATURE",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			}),
		).toThrow(PromptKindMismatchError);
	});

	it("names BOTH the bound kind and the item's kind, because the message is rendered verbatim", () => {
		let message = "";
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			});
		} catch (error) {
			message = (error as Error).message;
		}

		// The item's kind, the prompt's bound kind, the prompt itself, and the
		// recovery action all have to be in the string a reviewer sees.
		expect(message).toContain("BUG");
		expect(message).toContain("FEATURE");
		expect(message).toContain("Clean spec rewrite");
		expect(message).toMatch(/pick a prompt/i);
	});

	it("carries the decision as structured fields, so a caller need not parse the sentence", () => {
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE", "FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "CLEAN_SPEC",
			});
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(PromptKindMismatchError);
			const mismatch = error as InstanceType<
				typeof PromptKindMismatchError
			>;
			expect(mismatch.kind).toBe("BUG");
			expect(mismatch.promptLabel).toBe("Clean spec rewrite");
			expect(mismatch.documentType).toBe("CLEAN_SPEC");
			// Deduped, so a prompt with four FEATURE rows reads as one kind.
			expect(mismatch.boundKinds).toEqual(["FEATURE"]);
		}
	});

	it("throws no orpc error — this package has no orpc dependency to throw one from", () => {
		try {
			assertPromptKindCompatible({
				kindScopes: ["FEATURE"],
				kind: "BUG",
				promptLabel: "Clean spec rewrite",
				documentType: "DRAFT",
			});
			throw new Error("expected a refusal");
		} catch (error) {
			// The api wrappers add the protocol code; the core stays transport-free.
			expect((error as { code?: string }).code).toBeUndefined();
			expect((error as Error).name).toBe("PromptKindMismatchError");
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
		).toThrow(PromptKindMismatchError);
	});

	it("says the prompt is bound to no kind at all, and names the item's kind", () => {
		let message = "";
		let boundKinds: readonly string[] = ["not read"];
		try {
			assertPromptKindCompatible({
				kindScopes: [],
				kind: "BUG",
				promptLabel: "Unbound prompt",
				documentType: "DRAFT",
			});
		} catch (error) {
			message = (error as Error).message;
			boundKinds = (error as InstanceType<typeof PromptKindMismatchError>)
				.boundKinds;
		}

		expect(message).toContain("Unbound prompt");
		expect(message).toContain("BUG");
		expect(message).toContain("DRAFT");
		expect(message).toMatch(/not bound to any work item kind/i);
		expect(boundKinds).toEqual([]);
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
		).rejects.toThrow(PromptKindMismatchError);
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
