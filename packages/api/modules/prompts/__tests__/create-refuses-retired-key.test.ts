/**
 * Creating a prompt under a retired key is a refusal, not a crash
 * (Fizzy #2328 — R9).
 *
 * The database layer vetoes a SYSTEM insert whose key carries a retirement
 * record. What that veto looks like from the client decides whether the
 * deletion holds: an administrator who sees "Failed to create prompt" reads a
 * bug and retries, and retrying is exactly how the "DO NOT USE - " prompts kept
 * coming back. So the handler says what happened and names the one way to undo
 * it deliberately — an operator removes the record and runs the catalogue seed.
 *
 * The refusal is classified by the error's `code`, mirroring how the delete
 * procedure classifies Prisma's `P2025`. That matters here: this suite mocks
 * `@repo/database` wholesale, so an `instanceof` check against the real error
 * class could not survive the module boundary — and neither could it in any
 * other context where the two modules are loaded twice.
 *
 * The suite also covers everything the handler does with the failures it does
 * NOT recognise, because the refusal above was for a while the only failure it
 * classified: a transaction that ran out of time waiting on the key lock, and
 * any unclassified error, both reached the client as raw Prisma text.
 *
 * Run with:
 *   pnpm --filter api test modules/prompts/__tests__/create-refuses-retired-key.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createPrompt,
	verifyOrganizationMembership,
	assertValidTemplate,
	resolveOrganizationId,
	loggerError,
} = vi.hoisted(() => ({
	createPrompt: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
	assertValidTemplate: vi.fn(),
	resolveOrganizationId: vi.fn(() => "org-1"),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({ createPrompt }));
vi.mock("@repo/logs", () => ({ logger: { error: loggerError } }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));
vi.mock("../lib/assert-valid-template", () => ({ assertValidTemplate }));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_CREATE: "prompt:create" },
	requirePermission: () => (next: unknown) => next,
	resolveOrganizationId,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({ handler: (fn: unknown) => fn }),
			}),
		}),
	},
}));

import { createProcedure } from "../procedures/create";

type Handler = (a: unknown) => Promise<unknown>;

const RETIRED_KEY = "story_drafter";

/** What `createPrompt` raises when the key is recorded — a plain object
 *  carrying the code, because the code is the whole contract. */
const retired = () =>
	Object.assign(new Error(`The prompt key "${RETIRED_KEY}" is retired`), {
		code: "PROMPT_KEY_RETIRED",
		promptKey: RETIRED_KEY,
	});

const callCreate = (over: Record<string, unknown> = {}) =>
	(createProcedure as unknown as Handler)({
		input: {
			key: RETIRED_KEY,
			name: "Story Drafter",
			scope: "SYSTEM",
			format: "PLAIN_TEXT",
			tags: [],
			isPublic: false,
			...over,
		},
		context: {
			user: {
				id: "user-1",
				email: "operator@example.com",
				name: "Operator",
				role: "admin",
			},
			session: { id: "session-1", activeOrganizationId: "org-1" },
			tenantContext: {
				userId: "user-1",
				type: "organization",
				organizationId: "org-1",
			},
		},
	});

beforeEach(() => {
	vi.clearAllMocks();
	resolveOrganizationId.mockReturnValue("org-1");
	createPrompt.mockResolvedValue({ id: "prompt-1", key: RETIRED_KEY });
});

describe("prompts.create — a key recorded as retired", () => {
	it("refuses with a conflict rather than an internal error", async () => {
		createPrompt.mockRejectedValue(retired());

		const error = await callCreate().catch((e) => e);

		expect(error.code).toBe("CONFLICT");
		expect(error.code).not.toBe("INTERNAL_SERVER_ERROR");
	});

	// The message is the whole point of the case: without the operator path, a
	// refusal is a dead end, and the way out of a dead end has historically
	// been to recreate the prompt by hand.
	it("names the operator path as the only way back", async () => {
		createPrompt.mockRejectedValue(retired());

		const error = await callCreate().catch((e) => e);

		expect(error.message).toContain(RETIRED_KEY);
		expect(error.message).toContain("retired");
		expect(error.message).toMatch(/remove the retirement record/i);
		expect(error.message).toMatch(/seed/i);
	});

	// Previously this asserted the raw error came back untouched
	// (`rejects.toBe(boom)`). It no longer does, deliberately: an unclassified
	// database failure reaching the client verbatim is how an administrator
	// ends up reading Prisma's internals instead of a sentence about prompts,
	// and the delete handler has always wrapped its own. The identity of the
	// error is preserved where it belongs — in the log line below.
	it("reports an unclassified failure as an internal error, not raw database text", async () => {
		const boom = new Error("connection reset");
		createPrompt.mockRejectedValue(boom);

		const error = await callCreate().catch((e) => e);

		expect(error).not.toBe(boom);
		expect(error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(error.message).toContain("Failed to create prompt");
		expect(loggerError).toHaveBeenCalledWith(
			"[prompts.create] Error creating prompt",
			expect.objectContaining({ error: "connection reset" }),
		);
	});
});

/**
 * The guarded insert waits on the per-key retirement lock, and its transaction
 * ceiling sits BELOW the deletion's cascade budget on purpose — a creation that
 * waited out a full cascade would hold a request open for a minute only to be
 * told the key is now retired. The database layer's own comment states the
 * intended outcome: "it fails instead, and the retry gets the refusal."
 *
 * That is only true if the failure asks for a retry. Re-thrown raw, the
 * operator sees "Transaction already closed" — a database internal in place of
 * the one instruction that resolves it, on the exact path whose design assumes
 * they will try again.
 */
describe("prompts.create — the guarded insert running out of time", () => {
	it.each([
		[
			"Prisma's P2028 with its transaction-API text",
			Object.assign(
				new Error(
					"Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
				),
				{ code: "P2028" },
			),
		],
		[
			"the expiry message alone, with no code attached",
			new Error(
				"Invalid `prisma.$transaction()` invocation: The timeout for this transaction was 15000 ms, however 15001 ms passed since the start of the transaction.",
			),
		],
	])("asks for a retry when %s comes back", async (_label, failure) => {
		createPrompt.mockRejectedValue(failure);

		const error = await callCreate().catch((e) => e);

		expect(error.code).toBe("SERVICE_UNAVAILABLE");
		expect(error.message).toMatch(/try again/i);
		expect(error.message).toContain("nothing was created");
		// Never the raw text, which is what this case used to hand back.
		expect(error.message).not.toContain("Transaction");
	});

	// A timeout and a genuine failure mean different things to whoever is
	// looking: the first removed nothing and is worth retrying, the second is
	// not. Reporting both as one status tells the operator neither.
	it("reports a timeout distinctly from an unclassified failure", async () => {
		createPrompt.mockRejectedValue(
			Object.assign(new Error("Transaction already closed"), {
				code: "P2028",
			}),
		);
		const timedOut = await callCreate().catch((e) => e);

		createPrompt.mockRejectedValue(new Error("connection reset"));
		const failed = await callCreate().catch((e) => e);

		expect(timedOut.code).toBe("SERVICE_UNAVAILABLE");
		expect(failed.code).toBe("INTERNAL_SERVER_ERROR");
		expect(timedOut.code).not.toBe(failed.code);
	});

	// The refusal is classified first: a retired key is a decision, and a
	// decision must never be re-labelled as a transient failure the caller is
	// invited to retry — retrying is how the deleted prompts came back.
	it("still classifies the retired-key refusal ahead of everything else", async () => {
		createPrompt.mockRejectedValue(
			Object.assign(retired(), { code: "PROMPT_KEY_RETIRED" }),
		);

		const error = await callCreate().catch((e) => e);

		expect(error.code).toBe("CONFLICT");
		expect(error.message).toMatch(/remove the retirement record/i);
	});
});

describe("prompts.create — everything the guard does not touch", () => {
	it("creates a SYSTEM prompt whose key carries no record", async () => {
		await expect(callCreate()).resolves.toEqual({
			prompt: { id: "prompt-1", key: RETIRED_KEY },
		});
	});

	// The authorization branch runs BEFORE the call, so its refusal must not be
	// re-labelled by the catch that surrounds the create.
	it("still refuses a non-admin a SYSTEM prompt, without calling the database", async () => {
		const refusal = await (createProcedure as unknown as Handler)({
			input: {
				key: RETIRED_KEY,
				name: "Story Drafter",
				scope: "SYSTEM",
				format: "PLAIN_TEXT",
				tags: [],
				isPublic: false,
			},
			context: {
				user: { id: "user-2", role: "user" },
				session: { id: "session-2", activeOrganizationId: "org-1" },
			},
		}).catch((e) => e);

		expect(refusal.code).toBe("FORBIDDEN");
		expect(createPrompt).not.toHaveBeenCalled();
	});

	it("creates an ORG prompt for an organization admin, untouched by the guard", async () => {
		verifyOrganizationMembership.mockResolvedValue({ role: "admin" });
		createPrompt.mockResolvedValue({ id: "prompt-2", key: "team_drafter" });

		await expect(
			callCreate({ key: "team_drafter", scope: "ORG" }),
		).resolves.toEqual({
			prompt: { id: "prompt-2", key: "team_drafter" },
		});
		expect(createPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "ORG", organizationId: "org-1" }),
		);
	});
});
