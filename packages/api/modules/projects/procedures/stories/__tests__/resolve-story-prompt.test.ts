/**
 * Unit tests for `resolveStoryPromptProcedure` (Fizzy #2048, U1).
 *
 * The contract under test: the SERVER picks the template, from the work item's
 * stored kind. The caller sends a work item id and — at most — a target stage or
 * a hand-picked prompt id. It never sends a kind and never sends an agent name,
 * so a detail view holding a stale cached kind cannot steer the lookup.
 *
 * Mocks `@repo/database` and the oRPC procedure base so the handler can be
 * invoked directly, mirroring `enhance-feature.test.ts`. The kind→agent mapping
 * helper is deliberately NOT mocked — these tests exercise the real mapping.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, inputSchemas, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const inputSchemas: unknown[] = [];
	const mocks = {
		getStoryById: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		promptBindingFindMany: vi.fn(),
		requireOrganizationMembership: vi.fn(),
	};
	return { handlers, inputSchemas, mocks };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
	// The cross-kind guard (U3) reads the chosen prompt's binding rows. Left
	// unmocked here the explicit-prompt branch would hit the real client.
	db: { promptBinding: { findMany: mocks.promptBindingFindMany } },
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"PASSIVE_ANALYSIS",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			inputSchemas.push(schema);
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.resolvePrompt = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		// Real behaviour: the caller-supplied id is returned VERBATIM, with no
		// membership check of its own. That is precisely why the handler has to
		// perform one.
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		requireOrganizationMembership: mocks.requireOrganizationMembership,
	};
});

await import("../resolve-story-prompt");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const BUG_PROMPT = "BUG_CLEAN_SPEC_PROMPT_SENTINEL";
const FEATURE_PROMPT = "FEATURE_CLEAN_SPEC_PROMPT_SENTINEL";
const STAGE_PROMPT = "STAGE_DRAFTING_PROMPT_SENTINEL";

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.requireOrganizationMembership.mockResolvedValue({
		organization: { id: "org-1" },
		role: "member",
	});
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		title: "Stored work item",
		kind: "FEATURE",
		draftingStage: "DRAFT",
	});
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	// Default: the hand-picked prompt is bound at the requested document type
	// for the stored kind. Individual tests override to exercise the refusals.
	mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "FEATURE" }]);
});

/** Bind a prompt for exactly one (agentName, documentType) pair. */
function bindPromptFor(
	agentName: string,
	documentType: string,
	content: string,
	key: string,
) {
	mocks.getBoundPromptForAgent.mockImplementation(
		async (args: {
			agentName: string;
			documentType: string;
			storyKind?: string;
		}) =>
			args.agentName === agentName && args.documentType === documentType
				? { key, format: "PLAIN_TEXT", version: { content } }
				: null,
	);
}

describe("resolveStoryPromptProcedure — the stored kind picks the template", () => {
	it("a stored BUG resolves the bug clean-spec agent, with no kind from the caller", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			draftingStage: "DRAFT",
		});
		bindPromptFor(
			"bug_clean_spec_generator",
			"CLEAN_SPEC",
			BUG_PROMPT,
			"bug_clean_spec",
		);

		const result = (await handlers.resolvePrompt({
			// Note: no `kind`, no `storyKind`, no `agentName` — this IS the test.
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "BUG",
			}),
		);
		expect(result).toMatchObject({
			resolved: true,
			content: BUG_PROMPT,
			promptKey: "bug_clean_spec",
			source: "bound",
			kind: "BUG",
			kindWord: "bug",
		});
	});

	it("a stored FEATURE resolves the feature clean-spec agent", async () => {
		bindPromptFor(
			"feature_clean_spec_generator",
			"CLEAN_SPEC",
			FEATURE_PROMPT,
			"feature_clean_spec",
		);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				storyKind: "FEATURE",
			}),
		);
		expect(result).toMatchObject({
			resolved: true,
			content: FEATURE_PROMPT,
			kind: "FEATURE",
			kindWord: "feature",
		});
	});

	it("a target stage resolves the stage-scoped binding for the STORED kind", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			draftingStage: "PLACEHOLDER",
		});
		bindPromptFor(
			"project_document_generator",
			"DRAFT",
			STAGE_PROMPT,
			"bug_draft",
		);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "project_document_generator",
				documentType: "DRAFT",
				// Bugs and features share PLACEHOLDER/DRAFT; without the kind
				// scope a BUG would resolve the feature draft prompt.
				storyKind: "BUG",
			}),
		);
		expect(result).toMatchObject({
			resolved: true,
			content: STAGE_PROMPT,
			promptKey: "bug_draft",
			kind: "BUG",
		});
	});

	it("a hand-picked prompt id is resolved through the server, not fetched in the browser", async () => {
		mocks.getPromptById.mockResolvedValue({
			key: "hand_picked_prompt",
			format: "PLAIN_TEXT",
			versions: [{ content: "HAND_PICKED_SENTINEL" }],
		});

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(mocks.getPromptById).toHaveBeenCalledWith(
			"prompt-9",
			expect.objectContaining({ userId: "user-1" }),
		);
		expect(result).toMatchObject({
			resolved: true,
			content: "HAND_PICKED_SENTINEL",
			promptKey: "hand_picked_prompt",
			source: "explicitPrompt",
			kind: "FEATURE",
		});
	});

	it("accepts no kind and no agent name in its input schema", async () => {
		// Belt-and-braces on the contract above: even a future edit that adds a
		// caller-supplied kind or agent name to the schema fails here.
		const schema = inputSchemas[0] as z.ZodObject<z.ZodRawShape>;
		const keys = Object.keys(schema.shape);
		expect(keys).not.toContain("kind");
		expect(keys).not.toContain("storyKind");
		expect(keys).not.toContain("agentName");
		expect(keys).toEqual(
			expect.arrayContaining(["projectId", "storyId", "organizationId"]),
		);
	});
});

describe("resolveStoryPromptProcedure — an unbound kind holds rather than substituting", () => {
	it("returns an unresolved result, does not throw, and does not fall back to the other kind's prompt", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			draftingStage: "DRAFT",
		});
		// The FEATURE prompt IS bound; the BUG one is not. The bug run must come
		// back empty rather than picking up the feature template.
		bindPromptFor(
			"feature_clean_spec_generator",
			"CLEAN_SPEC",
			FEATURE_PROMPT,
			"feature_clean_spec",
		);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result).toEqual({
			resolved: false,
			content: null,
			promptKey: null,
			source: null,
			kind: "BUG",
			kindWord: "bug",
		});
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledTimes(1);
	});

	it("treats a whitespace-only bound prompt as unresolved", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "feature_clean_spec",
			format: "PLAIN_TEXT",
			version: { content: "   \n  " },
		});

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result.resolved).toBe(false);
		expect(result.content).toBeNull();
	});
});

describe("resolveStoryPromptProcedure — tenancy and scoping", () => {
	it("rejects an organization the caller is not a member of, before resolving that org's prompt", async () => {
		// `resolveOrganizationId` hands back the caller-supplied id verbatim and
		// prompt records are tenant-scoped, so the explicit membership check is
		// the only thing standing between a caller and another tenant's
		// customized prompt text.
		mocks.requireOrganizationMembership.mockRejectedValue(
			new Error("You are not a member of this organization"),
		);
		bindPromptFor(
			"feature_clean_spec_generator",
			"CLEAN_SPEC",
			"OTHER_TENANT_PROMPT_SENTINEL",
			"feature_clean_spec",
		);

		await expect(
			handlers.resolvePrompt({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: "org-the-caller-does-not-belong-to",
				},
				context: ctx,
			}),
		).rejects.toThrow("not a member");

		expect(mocks.requireOrganizationMembership).toHaveBeenCalledWith(
			"org-the-caller-does-not-belong-to",
			"user-1",
		);
		// The point of the guard: no prompt of that tenant's is ever read.
		expect(mocks.getBoundPromptForAgent).not.toHaveBeenCalled();
		expect(mocks.getPromptById).not.toHaveBeenCalled();
	});

	it("checks membership for a member's organization and resolves in that tenant", async () => {
		bindPromptFor(
			"feature_clean_spec_generator",
			"CLEAN_SPEC",
			FEATURE_PROMPT,
			"feature_clean_spec",
		);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: "org-1",
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(mocks.requireOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
		expect(result.resolved).toBe(true);
	});

	it("runs no membership check in personal context", async () => {
		await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.requireOrganizationMembership).not.toHaveBeenCalled();
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: undefined }),
		);
	});

	it("rejects a work item id that does not belong to the project", async () => {
		mocks.getStoryById.mockResolvedValue(null);

		await expect(
			handlers.resolvePrompt({
				input: {
					projectId: "project-1",
					storyId: "story-from-another-project",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toThrow("not found");

		// The project id is part of the lookup, which is what makes the
		// cross-project id a miss rather than a hit.
		expect(mocks.getStoryById).toHaveBeenCalledWith(
			"story-from-another-project",
			"project-1",
		);
		expect(mocks.getBoundPromptForAgent).not.toHaveBeenCalled();
	});
});

describe("the kind→clean-spec-agent mapping has exactly one source", () => {
	const PACKAGES_DIR = resolve(__dirname, "../../../../../..");
	const HELPER = join(
		PACKAGES_DIR,
		"temporal/src/lib/clean-spec-agent-for-kind.ts",
	);
	// `apps/web` is scanned too. The browser used to hold a fourth copy of this
	// mapping and pick the agent name itself — that copy is what let a converted
	// item keep getting the previous kind's template (Fizzy #2048). It is gone,
	// and this guard is what keeps it gone.
	const REPO_ROOT = resolve(PACKAGES_DIR, "..");
	const SCAN_ROOTS = [
		join(PACKAGES_DIR, "api/modules"),
		join(PACKAGES_DIR, "temporal/src"),
		join(REPO_ROOT, "apps/web/modules"),
	];
	const MAPPING_LITERAL = "_clean_spec_generator";

	function* walk(dir: string): Generator<string> {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === "__tests__") {
				continue;
			}
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				yield* walk(full);
			} else if (
				// `.tsx` matters: the copy this guard exists to prevent lived in a
				// React component, so a `.ts`-only walk would never have seen it.
				(full.endsWith(".ts") || full.endsWith(".tsx")) &&
				!full.endsWith(".test.ts") &&
				!full.endsWith(".test.tsx")
			) {
				yield full;
			}
		}
	}

	/** Lines that are pure comments don't constitute a second mapping. */
	function isComment(line: string): boolean {
		const trimmed = line.trim();
		return (
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*")
		);
	}

	it("names the two clean-spec agents in exactly one server-side file", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of walk(root)) {
				if (file === HELPER) {
					continue;
				}
				const hit = readFileSync(file, "utf8")
					.split("\n")
					.some(
						(line) =>
							line.includes(MAPPING_LITERAL) && !isComment(line),
					);
				if (hit) {
					offenders.push(file.slice(PACKAGES_DIR.length + 1));
				}
			}
		}

		// A second copy is how a converted work item keeps getting the previous
		// kind's template (Fizzy #2048). Import `cleanSpecAgentForKind` from
		// `@repo/temporal/clean-spec-agent-for-kind` instead of re-deriving it.
		expect(offenders).toEqual([]);
	});

	it("the helper itself still carries both agent keys", () => {
		const source = readFileSync(HELPER, "utf8");
		expect(source).toContain("bug_clean_spec_generator");
		expect(source).toContain("feature_clean_spec_generator");
	});
});

describe("resolveStoryPromptProcedure — a hand-picked prompt is checked against the stored kind", () => {
	beforeEach(() => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			draftingStage: "DRAFT",
		});
		mocks.getPromptById.mockResolvedValue({
			id: "prompt-9",
			key: "hand_picked_prompt",
			name: "Hand-picked rewrite",
			format: "PLAIN_TEXT",
			versions: [{ content: "HAND_PICKED_SENTINEL" }],
		});
	});

	it("refuses a FEATURE-bound prompt on a BUG, naming both kinds", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([
			{ storyKind: "FEATURE" },
		]);

		let message = "";
		try {
			await handlers.resolvePrompt({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			});
			throw new Error("expected a refusal");
		} catch (error) {
			message = (error as { message: string }).message;
		}

		expect(message).toContain("BUG");
		expect(message).toContain("FEATURE");
		expect(message).toContain("Hand-picked rewrite");
	});

	it("refuses a prompt with NO binding at the requested document type", async () => {
		// Deny by default: an absent binding is not evidence the prompt is
		// kind-agnostic, and reading it that way would disable this guard for
		// every prompt a caller can name.
		mocks.promptBindingFindMany.mockResolvedValue([]);

		await expect(
			handlers.resolvePrompt({
				input: {
					projectId: "project-1",
					storyId: "story-1",
					organizationId: null,
					targetStage: "DRAFT",
					promptId: "prompt-9",
				},
				context: ctx,
			}),
		).rejects.toThrow(/not bound to any work item kind/i);
	});

	it("asks about the stage's document type on a stage transition", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
				promptId: "prompt-9",
			},
			context: ctx,
		});

		expect(
			mocks.promptBindingFindMany.mock.calls[0][0].where.documentType,
		).toBe("DRAFT");
	});

	it("asks about CLEAN_SPEC when no stage is supplied", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
			},
			context: ctx,
		});

		expect(
			mocks.promptBindingFindMany.mock.calls[0][0].where.documentType,
		).toBe("CLEAN_SPEC");
	});

	it("allows a matching prompt and returns its content", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: "BUG" }]);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result).toMatchObject({
			resolved: true,
			content: "HAND_PICKED_SENTINEL",
			source: "explicitPrompt",
			kind: "BUG",
		});
	});

	it("allows a NULL-scoped binding for both kinds", async () => {
		mocks.promptBindingFindMany.mockResolvedValue([{ storyKind: null }]);

		const asBug = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
			},
			context: ctx,
		})) as Record<string, unknown>;
		expect(asBug.resolved).toBe(true);

		mocks.getStoryById.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			draftingStage: "DRAFT",
		});
		const asFeature = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				promptId: "prompt-9",
			},
			context: ctx,
		})) as Record<string, unknown>;
		expect(asFeature.resolved).toBe(true);
	});

	it("does not consult the binding table when the caller names no prompt", async () => {
		bindPromptFor(
			"bug_clean_spec_generator",
			"CLEAN_SPEC",
			BUG_PROMPT,
			"bug_clean_spec",
		);

		const result = (await handlers.resolvePrompt({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result.resolved).toBe(true);
		expect(mocks.promptBindingFindMany).not.toHaveBeenCalled();
	});
});
