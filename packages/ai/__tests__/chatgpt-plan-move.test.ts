/**
 * One ChatGPT account moves between a member's own plan and an
 * organization's shared accounts without a new sign-in (Fizzy #2770 I1):
 * under the old source's refresh lock, in one transaction that leaves both
 * sides intact when any step fails, with its per-source state re-keyed.
 */
import { Prisma } from "@repo/database/prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Tables = {
	credentials: Row[];
	accounts: Row[];
	orgUse: Row[];
	sourceState: Row[];
	servedModels: Row[];
	observations: Row[];
};

const store = vi.hoisted(() => ({
	tables: null as unknown as Tables,
	lockKeys: [] as string[],
	failOn: null as string | null,
	uniqueViolationOn: null as string | null,
}));

function matches(row: Row, where: Row | undefined): boolean {
	if (!where) {
		return true;
	}
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as Row[]).some((child) => matches(row, child));
		}
		if (value && typeof value === "object" && "equals" in value) {
			return (
				String(row[key] ?? "").toLowerCase() ===
				String((value as { equals: string }).equals).toLowerCase()
			);
		}
		if (key === "userId_organizationId") {
			return matches(row, value as Row);
		}
		return row[key] === value;
	});
}

function delegate(name: keyof Tables) {
	const rows = () => store.tables[name];
	const step = (op: string) => {
		if (store.failOn === `${name}.${op}`) {
			throw new Error(`${name}.${op} failed`);
		}
		if (store.uniqueViolationOn === `${name}.${op}`) {
			throw new Prisma.PrismaClientKnownRequestError("unique", {
				code: "P2002",
			});
		}
	};
	return {
		findUnique: async ({ where }: { where: Row }) => {
			const row = rows().find((r) => matches(r, where));
			return row ? { ...row } : null;
		},
		findFirst: async ({ where }: { where: Row }) => {
			const row = rows().find((r) => matches(r, where));
			return row ? { ...row } : null;
		},
		create: async ({ data }: { data: Row }) => {
			step("create");
			const row = { id: `${name}-${rows().length + 1}`, ...data };
			rows().push(row);
			return { ...row };
		},
		delete: async ({ where }: { where: Row }) => {
			step("delete");
			const index = rows().findIndex((r) => matches(r, where));
			if (index < 0) {
				throw new Error("not found");
			}
			return rows().splice(index, 1)[0];
		},
		deleteMany: async ({ where }: { where: Row }) => {
			step("deleteMany");
			const before = rows().length;
			store.tables[name] = rows().filter((r) => !matches(r, where));
			return { count: before - rows().length };
		},
		updateMany: async ({ where, data }: { where: Row; data: Row }) => {
			step("updateMany");
			let count = 0;
			for (const row of rows()) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		},
		upsert: async ({
			where,
			create,
			update,
		}: {
			where: Row;
			create: Row;
			update: Row;
		}) => {
			step("upsert");
			const row = rows().find((r) => matches(r, where));
			if (row) {
				Object.assign(row, update);
				return row;
			}
			rows().push({ ...create });
			return create;
		},
	};
}

const tx = {
	chatGptPlanCredential: delegate("credentials"),
	chatGptPlanOrgAccount: delegate("accounts"),
	chatGptPlanOrgUse: delegate("orgUse"),
	chatGptPlanSourceState: delegate("sourceState"),
	chatGptPlanServedModel: delegate("servedModels"),
	chatGptPlanBudgetObservation: delegate("observations"),
};

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	chatGptPlanLockKey: (userId: string) => `chatgpt-plan:${userId}`,
	// The real one runs `fn` in one transaction: a throw rolls everything back.
	withRefreshLock: async <T>(
		key: string,
		fn: (t: typeof tx) => Promise<T>,
	): Promise<T> => {
		store.lockKeys.push(key);
		const snapshot = structuredClone(store.tables);
		try {
			return await fn(tx);
		} catch (error) {
			store.tables = snapshot;
			throw error;
		}
	},
}));

vi.mock("@repo/database", () => ({
	chatGptPlanAccountIdentityWhere: (identity: {
		subject: string;
		email: string | null;
	}) => ({
		OR: [
			{ subject: identity.subject },
			...(identity.email
				? [{ email: { equals: identity.email, mode: "insensitive" } }]
				: []),
		],
	}),
}));

import {
	ChatGptPlanMoveError,
	shareOwnChatGptPlan,
	takeBackSharedChatGptPlan,
} from "../lib/chatgpt-plan/plan-move";

const SIGN_IN = {
	email: "plan@example.com",
	subject: "sub-1",
	clientId: "oaiapp_1",
	hostId: "urn:uuid:host",
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedIdToken: "enc-id",
	accessTokenExpiresAt: new Date("2026-10-09T12:00:00Z"),
	earliestRefreshAt: null,
	scopes: ["openid", "chatgpt.tokens.use.direct"],
	status: "ACTIVE",
	tier: "PLUS",
	subscriptionActiveUntil: new Date("2026-11-01T00:00:00Z"),
	lastUsedAt: new Date("2026-10-09T10:00:00Z"),
};

const userState = (sourceKind: string, sourceId: string) => ({
	sourceState: [
		{ sourceKind, sourceId, openUntil: new Date(), resetAt: null },
	],
	servedModels: [{ sourceKind, sourceId, slug: "gpt-6-astra" }],
	observations: [
		{ sourceKind, sourceId, windowStart: new Date(), inputTokens: 5 },
	],
});

function withOwnPlan(): Tables {
	return {
		credentials: [{ id: "cred-1", userId: "user-1", ...SIGN_IN }],
		accounts: [],
		orgUse: [
			{ userId: "user-1", organizationId: "org-a", enabled: true },
			{ userId: "user-1", organizationId: "org-b", enabled: true },
		],
		...userState("USER", "user-1"),
	};
}

function withSharedAccount(connectedByUserId = "user-1"): Tables {
	return {
		credentials: [],
		accounts: [
			{
				id: "acc-1",
				organizationId: "org-a",
				label: "Plan",
				connectedByUserId,
				enabled: true,
				serveInteractive: false,
				serveBackground: true,
				...SIGN_IN,
			},
		],
		orgUse: [],
		...userState("ORG", "acc-1"),
	};
}

beforeEach(() => {
	store.lockKeys = [];
	store.failOn = null;
	store.uniqueViolationOn = null;
});

describe("shareOwnChatGptPlan", () => {
	it("moves the sign-in into a shared account and re-keys its state, under the own plan's lock", async () => {
		store.tables = withOwnPlan();
		const { accountId } = await shareOwnChatGptPlan({
			userId: "user-1",
			organizationId: "org-a",
			label: "Example Member's ChatGPT plan",
		});

		expect(store.lockKeys).toEqual(["chatgpt-plan:user-1"]);
		expect(store.tables.credentials).toEqual([]);
		// Per-organization choices stay, as on a disconnect.
		expect(store.tables.orgUse).toEqual(withOwnPlan().orgUse);
		expect(store.tables.accounts).toEqual([
			expect.objectContaining({
				id: accountId,
				organizationId: "org-a",
				label: "Example Member's ChatGPT plan",
				connectedByUserId: "user-1",
				...SIGN_IN,
			}),
		]);
		for (const table of [
			"sourceState",
			"servedModels",
			"observations",
		] as const) {
			expect(store.tables[table]).toEqual([
				expect.objectContaining({
					sourceKind: "ORG",
					sourceId: accountId,
				}),
			]);
		}
	});

	it("refuses when an organization already shares the account, changing nothing", async () => {
		store.tables = withOwnPlan();
		store.tables.accounts.push({
			id: "acc-other",
			organizationId: "org-b",
			subject: "another-sub",
			email: "PLAN@example.com",
		});
		const before = structuredClone(store.tables);
		await expect(
			shareOwnChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				label: "Plan",
			}),
		).rejects.toMatchObject({ reason: "already_shared" });
		expect(store.tables).toEqual(before);
	});

	it("maps a unique-subject race to already_shared", async () => {
		store.tables = withOwnPlan();
		store.uniqueViolationOn = "accounts.create";
		await expect(
			shareOwnChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				label: "Plan",
			}),
		).rejects.toMatchObject({ reason: "already_shared" });
	});

	it("refuses without an own plan", async () => {
		store.tables = withSharedAccount();
		await expect(
			shareOwnChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				label: "Plan",
			}),
		).rejects.toBeInstanceOf(ChatGptPlanMoveError);
	});

	it("leaves both sides intact when a step after the create fails", async () => {
		store.tables = withOwnPlan();
		const before = structuredClone(store.tables);
		store.failOn = "credentials.deleteMany";
		await expect(
			shareOwnChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				label: "Plan",
			}),
		).rejects.toThrow("credentials.deleteMany failed");
		expect(store.tables).toEqual(before);
	});

	it("answers not_found, changing nothing, when the own plan was disconnected meanwhile", async () => {
		store.tables = withOwnPlan();
		const before = structuredClone(store.tables);
		// The plan was read, then a concurrent disconnect removed it.
		const real = tx.chatGptPlanCredential.deleteMany;
		tx.chatGptPlanCredential.deleteMany = async () => ({ count: 0 });
		try {
			await expect(
				shareOwnChatGptPlan({
					userId: "user-1",
					organizationId: "org-a",
					label: "Plan",
				}),
			).rejects.toMatchObject({ reason: "not_found" });
		} finally {
			tx.chatGptPlanCredential.deleteMany = real;
		}
		expect(store.tables).toEqual(before);
	});
});

describe("takeBackSharedChatGptPlan", () => {
	it("moves the account back to its connector's own plan, used in that organization, under the account's lock", async () => {
		store.tables = withSharedAccount();
		await takeBackSharedChatGptPlan({
			userId: "user-1",
			organizationId: "org-a",
			accountId: "acc-1",
		});

		expect(store.lockKeys).toEqual(["chatgpt-plan-org:acc-1"]);
		expect(store.tables.accounts).toEqual([]);
		expect(store.tables.credentials).toEqual([
			expect.objectContaining({ userId: "user-1", ...SIGN_IN }),
		]);
		expect(store.tables.orgUse).toEqual([
			{
				userId: "user-1",
				organizationId: "org-a",
				enabled: true,
				includeBackgroundJobs: false,
			},
		]);
		for (const table of [
			"sourceState",
			"servedModels",
			"observations",
		] as const) {
			expect(store.tables[table]).toEqual([
				expect.objectContaining({
					sourceKind: "USER",
					sourceId: "user-1",
				}),
			]);
		}
	});

	it("keeps the member's own choice for that organization, background jobs included", async () => {
		store.tables = withSharedAccount();
		const choice = {
			userId: "user-1",
			organizationId: "org-a",
			enabled: true,
			includeBackgroundJobs: true,
		};
		store.tables.orgUse.push({ ...choice });
		await takeBackSharedChatGptPlan({
			userId: "user-1",
			organizationId: "org-a",
			accountId: "acc-1",
		});
		expect(store.tables.orgUse).toEqual([choice]);
	});

	it("drops state left under the own plan's key instead of colliding with it", async () => {
		store.tables = withSharedAccount();
		store.tables.sourceState.push({
			sourceKind: "USER",
			sourceId: "user-1",
			openUntil: null,
			resetAt: null,
		});
		await takeBackSharedChatGptPlan({
			userId: "user-1",
			organizationId: "org-a",
			accountId: "acc-1",
		});
		expect(store.tables.sourceState).toHaveLength(1);
		expect(store.tables.sourceState[0]?.openUntil).not.toBeNull();
	});

	it("refuses anyone but the member who connected it, admins included", async () => {
		store.tables = withSharedAccount("user-connector");
		const before = structuredClone(store.tables);
		await expect(
			takeBackSharedChatGptPlan({
				userId: "user-admin",
				organizationId: "org-a",
				accountId: "acc-1",
			}),
		).rejects.toMatchObject({ reason: "not_connector" });
		expect(store.tables).toEqual(before);
	});

	it("refuses when the member already has an own plan", async () => {
		store.tables = withSharedAccount();
		store.tables.credentials.push({ id: "cred-x", userId: "user-1" });
		const before = structuredClone(store.tables);
		await expect(
			takeBackSharedChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				accountId: "acc-1",
			}),
		).rejects.toMatchObject({ reason: "personal_exists" });
		expect(store.tables).toEqual(before);
	});

	it("finds no account of another organization", async () => {
		store.tables = withSharedAccount();
		await expect(
			takeBackSharedChatGptPlan({
				userId: "user-1",
				organizationId: "org-b",
				accountId: "acc-1",
			}),
		).rejects.toMatchObject({ reason: "not_found" });
		expect(store.lockKeys).toEqual(["chatgpt-plan-org:acc-1"]);
	});

	it("leaves both sides intact when the delete fails", async () => {
		store.tables = withSharedAccount();
		const before = structuredClone(store.tables);
		store.failOn = "accounts.deleteMany";
		await expect(
			takeBackSharedChatGptPlan({
				userId: "user-1",
				organizationId: "org-a",
				accountId: "acc-1",
			}),
		).rejects.toThrow("accounts.deleteMany failed");
		expect(store.tables).toEqual(before);
	});
});
