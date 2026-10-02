/**
 * The owner a context workflow or activity input names (Fizzy #2719).
 *
 * The characterization that matters most is the first: an input without an
 * owner — every input recorded before company context existed, and every
 * schedule's arguments — resolves to the project owner of its own
 * `projectId`, unvalidated, so it runs exactly as it always did. A named
 * owner must be whole; anything else fails non-retryably, because a retry
 * cannot supply a missing tenant.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/lib/__tests__/context-owner.test.ts
 */

import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { COMPANY_CONTEXT_TASK_QUEUE } from "../../task-queues";
import {
	CONTEXT_OWNER_INVALID,
	type ContextOwner,
	companyContextOwnerOf,
	contextOwnerTaskQueue,
	resolveContextOwner,
} from "../context-owner";

/** The failure `fn` throws, asserted to be a non-retryable owner failure. */
function ownerFailure(fn: () => unknown): ApplicationFailure {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ApplicationFailure);
		const failure = error as ApplicationFailure;
		expect(failure.nonRetryable).toBe(true);
		expect(failure.type).toBe(CONTEXT_OWNER_INVALID);
		return failure;
	}
	throw new Error("expected an owner failure");
}

describe("resolveContextOwner", () => {
	it("resolves an input without an owner to the project owner of its projectId", () => {
		expect(
			resolveContextOwner({
				projectId: "proj-1",
				organizationId: "org-1",
			}),
		).toEqual({ kind: "project", projectId: "proj-1" });
		// A decoded history can carry null for an absent field.
		expect(
			resolveContextOwner({ projectId: "proj-1", owner: null }),
		).toEqual({ kind: "project", projectId: "proj-1" });
	});

	it("does not validate the project path an ownerless input always took", () => {
		// Whatever such an input did before owners existed, it still does:
		// resolving never throws for it.
		expect(resolveContextOwner({})).toEqual({
			kind: "project",
			projectId: undefined,
		});
	});

	it("resolves a company owner to its organization, dropping anything else it carries", () => {
		const owner = {
			kind: "company",
			organizationId: "org-1",
			projectId: "proj-1",
		} as unknown as ContextOwner;
		expect(resolveContextOwner({ owner })).toEqual({
			kind: "company",
			organizationId: "org-1",
		});
		expect(
			resolveContextOwner({
				organizationId: "org-1",
				owner: { kind: "company", organizationId: "org-1" },
			}),
		).toEqual({ kind: "company", organizationId: "org-1" });
	});

	it("fails non-retryably for a company owner without an organization", () => {
		for (const organizationId of [undefined, null, ""]) {
			const failure = ownerFailure(() =>
				resolveContextOwner({
					owner: { kind: "company", organizationId } as never,
				}),
			);
			expect(failure.message).toMatch(/requires an organizationId/);
		}
	});

	it("fails non-retryably when the company owner and the input disagree on the organization", () => {
		ownerFailure(() =>
			resolveContextOwner({
				organizationId: "org-2",
				owner: { kind: "company", organizationId: "org-1" },
			}),
		);
	});

	it("resolves an explicit project owner, filling its project from the input", () => {
		expect(
			resolveContextOwner({
				projectId: "proj-1",
				owner: { kind: "project", projectId: "proj-1" },
			}),
		).toEqual({ kind: "project", projectId: "proj-1" });
		expect(
			resolveContextOwner({
				projectId: "proj-1",
				owner: { kind: "project" } as never,
			}),
		).toEqual({ kind: "project", projectId: "proj-1" });
	});

	it("fails non-retryably for an explicit project owner without, or disagreeing on, a project", () => {
		ownerFailure(() =>
			resolveContextOwner({ owner: { kind: "project" } as never }),
		);
		ownerFailure(() =>
			resolveContextOwner({
				projectId: "proj-2",
				owner: { kind: "project", projectId: "proj-1" },
			}),
		);
	});

	it("fails non-retryably for an owner kind it does not know", () => {
		const failure = ownerFailure(() =>
			resolveContextOwner({ owner: { kind: "workspace" } as never }),
		);
		expect(failure.message).toMatch(/workspace/);
	});
});

describe("companyContextOwnerOf", () => {
	it("is null for a missing or project owner", () => {
		expect(companyContextOwnerOf(undefined)).toBeNull();
		expect(companyContextOwnerOf(null)).toBeNull();
		expect(
			companyContextOwnerOf({ kind: "project", projectId: "proj-1" }),
		).toBeNull();
	});

	it("returns a validated company owner, and refuses a malformed one", () => {
		expect(
			companyContextOwnerOf({ kind: "company", organizationId: "org-1" }),
		).toEqual({ kind: "company", organizationId: "org-1" });
		ownerFailure(() => companyContextOwnerOf({ kind: "company" } as never));
	});
});

describe("contextOwnerTaskQueue", () => {
	it("starts a company owner on its own queue, and everything else where the project starts do", () => {
		expect(
			contextOwnerTaskQueue(
				{ kind: "company", organizationId: "org-1" },
				"project-documents",
			),
		).toBe(COMPANY_CONTEXT_TASK_QUEUE);
		expect(
			contextOwnerTaskQueue(
				{ kind: "project", projectId: "proj-1" },
				"project-documents",
			),
		).toBe("project-documents");
		expect(contextOwnerTaskQueue(undefined, "document-processing")).toBe(
			"document-processing",
		);
	});
});
