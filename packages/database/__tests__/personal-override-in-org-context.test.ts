/**
 * A personal default beats the organization's, for the person who set it.
 *
 * FR3 and FR4 of Fizzy #2068: "overriding Org and Universal defaults for
 * themselves", resolved "Personal > Org > Universal". Before this, the resolver
 * consulted USER bindings only in personal context, so inside an organization a
 * personal default silently did nothing for the 33 call sites that resolve a
 * prompt autonomously — QA analysis, test-case drafting, PR review, story
 * titles. The UI let you set one and the agents ignored it.
 *
 * ## Why this is not a breach of the XOR tenancy rule
 *
 * The repo rule ("always exclusive filtering — never OR") exists to stop one
 * tenant's DATA reaching another. A prompt binding is not tenant data: it is a
 * user's own preference about their own work, and honouring it exposes nobody
 * else's anything. The XOR that matters here is between two USERS, and that is
 * still absolute — a binding is always scoped to `userId`.
 *
 * What this DOES mean is that an organization's default is a strong
 * recommendation rather than an enforcement mechanism. That is the deliberate
 * product decision recorded with this change; if an organization ever needs a
 * prompt it can mandate, that wants an explicit policy, not a silently ignored
 * preference.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/personal-override-in-org-context.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, promptFindFirst } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	promptFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: { findFirst },
		prompt: { findFirst: promptFindFirst },
	},
	Prisma: {},
}));

import {
	getBoundPromptVersion,
	getPromptById,
} from "../prisma/queries/prompts";

const TARGET = {
	targetType: "AGENT" as const,
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
};

/** The (scope, userId, organizationId) triples the resolver asked for, in order. */
const queriesMade = () =>
	findFirst.mock.calls.map((c) => ({
		scope: c[0].where.scope,
		userId: c[0].where.userId,
		organizationId: c[0].where.organizationId,
	}));

beforeEach(() => {
	findFirst.mockReset();
	findFirst.mockResolvedValue(null);
});

describe("resolution order inside an organization", () => {
	it("asks for the caller's personal binding first", async () => {
		await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		const scopes = queriesMade().map((q) => q.scope);
		expect(scopes).toEqual(["USER", "ORG", "SYSTEM"]);
	});

	it("scopes that personal lookup to the caller alone", async () => {
		// The XOR that still matters absolutely: one user's override must never
		// resolve for another.
		await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		const personal = queriesMade().find((q) => q.scope === "USER");
		expect(personal?.userId).toBe("user-1");
	});

	it("stops at the personal binding when one is in force", async () => {
		findFirst.mockImplementation(async (args: any) =>
			args.where.scope === "USER"
				? { promptVersion: { id: "personal-version" } }
				: null,
		);

		const result = await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "personal-version" });
		// Having found it, there is no reason to look further.
		expect(queriesMade().map((q) => q.scope)).toEqual(["USER"]);
	});

	it("falls through to the organization when the user has no override", async () => {
		findFirst.mockImplementation(async (args: any) =>
			args.where.scope === "ORG"
				? { promptVersion: { id: "org-version" } }
				: null,
		);

		const result = await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "org-version" });
	});

	it("falls through to the system default when neither exists", async () => {
		findFirst.mockImplementation(async (args: any) =>
			args.where.scope === "SYSTEM"
				? { promptVersion: { id: "system-version" } }
				: null,
		);

		const result = await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "system-version" });
	});

	it("skips the personal lookup entirely when there is no caller", async () => {
		// A background job with an organization but no user has no personal
		// preference to honour, and must not query for one unscoped.
		await getBoundPromptVersion({ ...TARGET, organizationId: "org-1" });

		expect(queriesMade().map((q) => q.scope)).toEqual(["ORG", "SYSTEM"]);
	});
});

describe("personal context is unchanged", () => {
	it("still never consults another tenant's organization binding", async () => {
		await getBoundPromptVersion({ ...TARGET, userId: "user-1" });

		expect(queriesMade().map((q) => q.scope)).toEqual(["USER", "SYSTEM"]);
	});
});

/**
 * The resolver honouring a personal binding is only half the promise: the person
 * who set it has to be able to open the prompt too. `getPromptById` admitted
 * USER scope only outside an organization, so on staging a personal prompt was
 * listed in the catalog and its own page answered "Prompt not found" — every
 * account has an organization since ADR-018, so that branch was always taken.
 */
describe("reading a personal prompt inside an organization", () => {
	const scopesOffered = () =>
		promptFindFirst.mock.calls[0][0].where.OR.map(
			(c: { scope: string }) => c.scope,
		);

	beforeEach(() => {
		promptFindFirst.mockReset();
		promptFindFirst.mockResolvedValue(null);
	});

	it("offers the caller's own personal prompts alongside the org's", async () => {
		await getPromptById("prompt-1", {
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(scopesOffered()).toContain("USER");
	});

	it("scopes that personal condition to the caller alone", async () => {
		await getPromptById("prompt-1", {
			userId: "user-1",
			organizationId: "org-1",
		});

		const personal = promptFindFirst.mock.calls[0][0].where.OR.find(
			(c: { scope: string }) => c.scope === "USER",
		);
		expect(personal.userId).toBe("user-1");
	});

	it("still never offers another tenant's organization prompts", async () => {
		await getPromptById("prompt-1", {
			userId: "user-1",
			organizationId: "org-1",
		});

		const org = promptFindFirst.mock.calls[0][0].where.OR.find(
			(c: { scope: string }) => c.scope === "ORG",
		);
		expect(org.organizationId).toBe("org-1");
	});

	it("offers no personal condition when there is no caller", async () => {
		await getPromptById("prompt-1", { organizationId: "org-1" });

		expect(scopesOffered()).toEqual(["SYSTEM", "ORG"]);
	});
});
