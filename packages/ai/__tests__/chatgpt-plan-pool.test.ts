/**
 * Picking the ChatGPT plan for a call (Fizzy #2770): the member's own plan
 * first; a spent own plan falls through to shared accounts that serve
 * interactive work; NEEDS_RECONNECT is never substituted; background work
 * reaches shared accounts only for allowlisted job types; the least-used
 * account wins, leaving headroom for people; and when every plan is spent
 * interactive work fails, background work fails or — under AUTO — runs on the
 * organization's provider, audited.
 */

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Account = {
	id: string;
	enabled: boolean;
	status: "ACTIVE" | "NEEDS_RECONNECT";
	serveInteractive: boolean;
	serveBackground: boolean;
	maxMemberSharePct?: number | null;
};

const db = vi.hoisted(() => ({
	flags: {} as Record<string, boolean>,
	declined: false,
	ownUse: null as null | {
		includeBackgroundJobs: boolean;
		credentialStatus: "ACTIVE" | "NEEDS_RECONNECT";
	},
	policy: {
		poolingEnabled: true,
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedById: "owner_1",
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z") as Date | null,
	},
	accounts: [] as Account[],
	accountsCalls: [] as string[],
	usage: new Map<string, number>(),
	/** Per account, each member's uncached input in its window. */
	byUser: new Map<string, Record<string, number>>(),
	resetsAt: new Map<string, Date>(),
	budgets: new Map<string, number>(),
	open: new Map<string, Date>(),
	/** The serving source's model list, as last read. */
	served: [] as Array<{ slug: string; priority: number | null }>,
	catalog: [] as Array<{
		canonicalName: string;
		slug: string;
		displayName: string;
	}>,
	failPool: false,
	audit: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The model list's background re-read is observed, never run.
const refreshStale = vi.hoisted(() => vi.fn());
vi.mock("../lib/chatgpt-plan/served-models", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../lib/chatgpt-plan/served-models")
	>()),
	refreshStaleChatGptPlanServedModels: refreshStale,
	refreshChatGptPlanServedModelsInBackground: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getChatGptPlanServedModels: async () => db.served,
	listChatGptPlanModels: async () => db.catalog,
	isFeatureEnabled: async (key: string) => db.flags[key] === true,
	getActiveChatGptPlanOrgUse: async () => db.ownUse,
	hasDeclinedChatGptPlanInOrganization: async () => db.declined,
	getChatGptPlanOrgPolicy: async () => {
		if (db.failPool) {
			throw new Error("database down");
		}
		return db.policy;
	},
	getCachedChatGptPlanOrgPolicy: async () => {
		if (db.failPool) {
			throw new Error("database down");
		}
		return db.policy;
	},
	listChatGptPlanOrgAccounts: async (organizationId: string) => {
		db.accountsCalls.push(organizationId);
		return db.accounts;
	},
	getChatGptPlanOrgAccountWindows: async (params: { accountIds: string[] }) =>
		new Map(
			params.accountIds
				.filter((id) => db.usage.has(id))
				.map((id) => [
					id,
					{
						requests: 1,
						inputTokens: db.usage.get(id),
						outputTokens: 0,
						resetsAt: db.resetsAt.get(id) ?? null,
						inputTokensByUser: db.byUser.get(id) ?? {},
					},
				]),
		),
	getChatGptPlanWindowBudget: async (ref: { accountId: string }) =>
		db.budgets.get(ref.accountId) ?? 750_000,
	getChatGptPlanWindowBudgets: async (_kind: string, ids: string[]) =>
		new Map(ids.map((id) => [id, db.budgets.get(id) ?? 750_000])),
	getChatGptPlanSourceStates: async (kind: string, ids: string[]) =>
		ids
			.filter((id) => db.open.has(`${kind}:${id}`))
			.map((id) => ({
				sourceKind: kind,
				sourceId: id,
				openUntil: db.open.get(`${kind}:${id}`),
				resetAt: db.open.get(`${kind}:${id}`),
				consecutiveUnknownResets: 0,
			})),
	recordChatGptPlanSourceExhausted: async () => {},
	clearChatGptPlanSourceState: async () => {},
	recordAudit: db.audit,
}));

import { __resetChatGptPlanBreaker } from "../lib/chatgpt-plan/exhaustion-breaker";
import { runWithAiInteractiveContext } from "../lib/chatgpt-plan/interactive-context";
import {
	__resetChatGptPlanApiFallbackAudit,
	chatGptPlanSourceForCall,
	interactivePlanModel,
	PLAN_POOL_BACKGROUND_JOB_TYPES,
	pickChatGptPlanSource,
	planServesInteractiveWork,
	sharedPlansServeBackgroundWork,
} from "../lib/chatgpt-plan/pool";
import { __resetChatGptPlanWindowCache } from "../lib/chatgpt-plan/window-cache";

const IN_AN_HOUR = new Date(Date.now() + 60 * 60_000);

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
	id,
	enabled: true,
	status: "ACTIVE",
	serveInteractive: true,
	serveBackground: true,
	...overrides,
});

const interactive = {
	userId: "user_1",
	organizationId: "org_a",
	planEligible: true,
};
const background = {
	userId: "user_1",
	organizationId: "org_a",
	jobType: "daily-brief" as const,
};

const orgSource = (accountId: string) => ({
	source: { kind: "org", organizationId: "org_a", accountId },
});

beforeEach(() => {
	__resetChatGptPlanWindowCache();
	__resetChatGptPlanBreaker();
	__resetChatGptPlanApiFallbackAudit();
	vi.clearAllMocks();
	db.flags = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true };
	db.ownUse = null;
	db.declined = false;
	db.policy = {
		...db.policy,
		poolingEnabled: true,
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledgedAt: new Date("2026-10-01T00:00:00Z"),
	};
	db.accounts = [account("acc_1")];
	db.accountsCalls = [];
	db.usage = new Map();
	db.served = [];
	db.catalog = [];
	db.byUser = new Map();
	db.resetsAt = new Map();
	db.budgets = new Map();
	db.open = new Map();
	db.failPool = false;
});

describe("the member's own plan", () => {
	it("comes first when it is usable", async () => {
		db.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual({
			source: { kind: "user", userId: "user_1" },
		});
	});

	it("is refused, never substituted, when it needs reconnecting — even with shared accounts serving people", async () => {
		db.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "NEEDS_RECONNECT",
		};
		await expect(pickChatGptPlanSource(interactive)).rejects.toMatchObject({
			name: "ChatGptPlanAuthError",
		});
		expect(db.accountsCalls).toEqual([]);
	});

	it("falls through to a shared account that serves people once its window is spent", async () => {
		db.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		db.open.set("USER:user_1", IN_AN_HOUR);
		const pick = await pickChatGptPlanSource(interactive);
		expect(pick).toMatchObject(orgSource("acc_1"));
		expect(
			pick && "ownPlanSpent" in pick ? pick.ownPlanSpent : null,
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
	});

	it("still serves the call when its window is spent and nothing stands in, so the call fails as today", async () => {
		db.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		db.open.set("USER:user_1", IN_AN_HOUR);
		db.accounts = [account("acc_1", { serveInteractive: false })];
		await expect(chatGptPlanSourceForCall(interactive)).resolves.toEqual({
			source: { kind: "user", userId: "user_1" },
		});
	});

	it("is still the plan when the caller excluded it and nothing stands in", async () => {
		db.ownUse = {
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		};
		db.accounts = [];
		await expect(
			chatGptPlanSourceForCall(interactive, { exclude: ["user:user_1"] }),
		).resolves.toEqual({ source: { kind: "user", userId: "user_1" } });
	});
});

describe("no plan at all", () => {
	it("for a request with no organization, or one an admin makes as the member", async () => {
		await expect(
			pickChatGptPlanSource({
				...interactive,
				organizationId: undefined,
			}),
		).resolves.toBeNull();
		await runWithAiInteractiveContext(
			{ userId: "user_1", impersonated: true },
			async () => {
				await expect(
					pickChatGptPlanSource(interactive),
				).resolves.toBeNull();
				await expect(
					pickChatGptPlanSource(background),
				).resolves.toBeNull();
			},
		);
		expect(db.accountsCalls).toEqual([]);
	});

	it.each([
		["CHATGPT_PLAN off", () => (db.flags.CHATGPT_PLAN = false)],
		[
			"CHATGPT_PLAN_POOLING off",
			() => (db.flags.CHATGPT_PLAN_POOLING = false),
		],
		["pooling off in the policy", () => (db.policy.poolingEnabled = false)],
		[
			"terms not acknowledged",
			() => (db.policy.termsAcknowledgedAt = null),
		],
		["the pool lookup failing", () => (db.failPool = true)],
	])("for a member without a plan when %s", async (_case, arrange) => {
		arrange();
		await expect(pickChatGptPlanSource(interactive)).resolves.toBeNull();
	});
});

describe("shared accounts", () => {
	it("serve a member without a plan only through accounts that serve people", async () => {
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_1"),
		);
		db.accounts = [account("acc_1", { serveInteractive: false })];
		await expect(pickChatGptPlanSource(interactive)).resolves.toBeNull();
	});

	it("never serve a member who turned their own plan off here — they chose the organization's billing", async () => {
		db.declined = true;
		await expect(pickChatGptPlanSource(interactive)).resolves.toBeNull();
		expect(db.accountsCalls).toEqual([]);
		// Background jobs are the organization's own work, not the member's choice.
		await expect(pickChatGptPlanSource(background)).resolves.toEqual(
			orgSource("acc_1"),
		);
	});

	it("serve only allowlisted background jobs, through accounts that serve them", async () => {
		await expect(pickChatGptPlanSource(background)).resolves.toEqual(
			orgSource("acc_1"),
		);
		await expect(
			pickChatGptPlanSource({
				...background,
				jobType: "newsletter-curation",
			}),
		).resolves.toBeNull();
		// Meeting sync and channel monitoring are the organization's own capture
		// work, so shared accounts may run them (DSU 10/7).
		await expect(
			pickChatGptPlanSource({
				...background,
				jobType: "meeting-transcript-sync",
			}),
		).resolves.toEqual(orgSource("acc_1"));
		await expect(
			pickChatGptPlanSource({ ...background, jobType: undefined }),
		).resolves.toBeNull();
		db.accounts = [account("acc_1", { serveBackground: false })];
		await expect(pickChatGptPlanSource(background)).resolves.toBeNull();
	});

	it("skip disabled accounts and ones needing reconnect", async () => {
		db.accounts = [
			account("acc_off", { enabled: false }),
			account("acc_reconnect", { status: "NEEDS_RECONNECT" }),
			account("acc_ok"),
		];
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_ok"),
		);
	});

	it("are read for the call's own organization only", async () => {
		await pickChatGptPlanSource(interactive);
		expect(db.accountsCalls).toEqual(["org_a"]);
	});

	it("ignore an exclusion naming another organization's account", async () => {
		await expect(
			pickChatGptPlanSource(interactive, {
				exclude: ["org:acc_elsewhere", "user:someone_else"],
			}),
		).resolves.toEqual(orgSource("acc_1"));
	});

	it("pick the least-used account", async () => {
		db.accounts = [account("acc_busy"), account("acc_quiet")];
		db.usage = new Map([
			["acc_busy", 300_000],
			["acc_quiet", 10_000],
		]);
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_quiet"),
		);
	});

	// Fizzy #2770 D6: fair share.
	it("skip an account whose fair share this member has used, for their interactive work only", async () => {
		db.accounts = [
			account("acc_quiet", { maxMemberSharePct: 25 }),
			account("acc_busy"),
		];
		db.usage = new Map([
			["acc_quiet", 200_000],
			["acc_busy", 400_000],
		]);
		db.budgets = new Map([
			["acc_quiet", 800_000],
			["acc_busy", 800_000],
		]);
		db.byUser = new Map([["acc_quiet", { user_1: 200_000 }]]);
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_busy"),
		);
		// Another member still gets the quieter account.
		await expect(
			pickChatGptPlanSource({ ...interactive, userId: "user_2" }),
		).resolves.toEqual(orgSource("acc_quiet"));
		// Background work is not a member's share.
		await expect(pickChatGptPlanSource(background)).resolves.toEqual(
			orgSource("acc_quiet"),
		);
	});

	it("is spent for a member over their share on every account, until the earliest of those windows resets", async () => {
		const soon = new Date(Date.now() + 30 * 60_000);
		db.accounts = [
			account("acc_1", { maxMemberSharePct: 50 }),
			account("acc_2", { maxMemberSharePct: 50 }),
		];
		db.usage = new Map([
			["acc_1", 500_000],
			["acc_2", 500_000],
		]);
		db.budgets = new Map([
			["acc_1", 1_000_000],
			["acc_2", 1_000_000],
		]);
		db.byUser = new Map([
			["acc_1", { user_1: 500_000 }],
			["acc_2", { user_1: 500_000 }],
		]);
		db.resetsAt = new Map([
			["acc_1", IN_AN_HOUR],
			["acc_2", soon],
		]);
		await expect(pickChatGptPlanSource(interactive)).resolves.toMatchObject(
			{
				exhausted: true,
				audience: "interactive",
				resetAt: soon,
			},
		);
	});

	it("compare accounts by the share of their own window budget used", async () => {
		db.accounts = [account("acc_small"), account("acc_large")];
		db.usage = new Map([
			["acc_small", 300_000],
			["acc_large", 500_000],
		]);
		db.budgets = new Map([
			["acc_small", 500_000],
			["acc_large", 2_000_000],
		]);
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_large"),
		);
	});

	it("skip an excluded or cooling account", async () => {
		db.accounts = [account("acc_1"), account("acc_2"), account("acc_3")];
		db.open.set("ORG:acc_2", IN_AN_HOUR);
		await expect(
			pickChatGptPlanSource(interactive, { exclude: ["org:acc_1"] }),
		).resolves.toEqual(orgSource("acc_3"));
	});

	it("keep background work off an account past the headroom while another is below it", async () => {
		// 40% headroom: background stops preferring an account at 450k of 750k.
		db.accounts = [account("acc_full"), account("acc_room")];
		db.usage = new Map([
			["acc_full", 460_000],
			["acc_room", 470_000],
		]);
		await expect(pickChatGptPlanSource(background)).resolves.toEqual(
			orgSource("acc_full"),
		);
		db.usage.set("acc_room", 100_000);
		__resetChatGptPlanWindowCache();
		await expect(pickChatGptPlanSource(background)).resolves.toEqual(
			orgSource("acc_room"),
		);
		// People are not held to the headroom.
		__resetChatGptPlanWindowCache();
		db.usage = new Map([
			["acc_full", 440_000],
			["acc_room", 460_000],
		]);
		db.policy.headroomPct = 90;
		await expect(pickChatGptPlanSource(interactive)).resolves.toEqual(
			orgSource("acc_full"),
		);
	});
});

describe("every plan spent", () => {
	beforeEach(() => {
		db.accounts = [account("acc_1"), account("acc_2")];
		db.open.set("ORG:acc_1", IN_AN_HOUR);
		db.open.set("ORG:acc_2", new Date(IN_AN_HOUR.getTime() + 60_000));
	});

	it("fails interactive work, naming the first reset", async () => {
		const error = await chatGptPlanSourceForCall(interactive).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect((error as SubscriptionPlanExhaustedError).resetAt).toEqual(
			IN_AN_HOUR,
		);
		expect((error as Error).message).toMatch(/^Every ChatGPT plan/);
	});

	it("fails background work under NEVER, for the workflow to wait on", async () => {
		await expect(
			chatGptPlanSourceForCall(background),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(db.audit).not.toHaveBeenCalled();
	});

	it("runs background work on the organization's provider under AUTO, audited once per window", async () => {
		db.policy.apiFallbackBackground = "AUTO";
		await expect(chatGptPlanSourceForCall(background)).resolves.toBeNull();
		await expect(chatGptPlanSourceForCall(background)).resolves.toBeNull();
		expect(db.audit).toHaveBeenCalledTimes(1);
		expect(db.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "org.chatgpt_plan.api_fallback_used",
				organizationId: "org_a",
				metadata: { jobType: "daily-brief" },
			}),
		);
	});

	it("never falls back to the organization's provider for interactive work, even under AUTO", async () => {
		db.policy.apiFallbackBackground = "AUTO";
		await expect(
			chatGptPlanSourceForCall(interactive),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(db.audit).not.toHaveBeenCalled();
	});
});

describe("PLAN_POOL_BACKGROUND_JOB_TYPES", () => {
	// The review point for what may spend a shared plan unattended: changing
	// this list must be a deliberate, reviewed edit.
	it("is exactly the daily brief, workflow-builder, meeting sync and channel monitor runs", () => {
		expect(PLAN_POOL_BACKGROUND_JOB_TYPES).toEqual([
			"daily-brief",
			"workflow-builder",
			"meeting-transcript-sync",
			"slack-channel-monitor",
			"teams-channel-monitor",
		]);
	});
});

// CopilotKit decides once per request whether the agents run on a plan, and
// serves a member even when the organization has no provider of its own.
describe("planServesInteractiveWork", () => {
	it("is true for a member with no plan when a shared account serves people", async () => {
		await expect(
			planServesInteractiveWork({
				userId: "user_1",
				organizationId: "org_a",
			}),
		).resolves.toBe(true);
	});

	it("is false when no shared account serves people and the member has no plan", async () => {
		db.accounts = [account("acc_1", { serveInteractive: false })];
		await expect(
			planServesInteractiveWork({
				userId: "user_1",
				organizationId: "org_a",
			}),
		).resolves.toBe(false);
	});

	it("stays true while every shared plan is spent, so agents get the plan's refusal", async () => {
		db.open.set("ORG:acc_1", IN_AN_HOUR);
		await expect(
			planServesInteractiveWork({
				userId: "user_1",
				organizationId: "org_a",
			}),
		).resolves.toBe(true);
	});
});

// The model picker's read-only "ChatGPT plan · <model>" row.
describe("interactivePlanModel", () => {
	it("names the shared plan and its model for a member with no plan", async () => {
		await expect(
			interactivePlanModel({
				userId: "user_1",
				organizationId: "org_a",
				taskType: "TOOL_CALLING",
			}),
		).resolves.toMatchObject({ model: "gpt-6.1-sol", source: "shared" });
	});

	// Fizzy #2770 F13: what a chat may pick instead.
	it("offers the models the serving plan lists, marking the default and the newest", async () => {
		db.catalog = [
			{
				canonicalName: "gpt-6-astra",
				slug: "gpt-6-astra",
				displayName: "GPT-6 Astra (ChatGPT plan)",
			},
			{
				canonicalName: "gpt-6.1-sol",
				slug: "gpt-6.1-sol",
				displayName: "GPT-6.1 Sol (ChatGPT plan)",
			},
			{
				canonicalName: "gpt-5.6-luna",
				slug: "gpt-5.6-luna",
				displayName: "GPT-5.6 Luna (ChatGPT plan)",
			},
		];
		db.served = [
			{ slug: "gpt-6-astra", priority: 1 },
			{ slug: "gpt-6.1-sol", priority: 2 },
		];
		const choice = await interactivePlanModel({
			userId: "user_1",
			organizationId: "org_a",
			taskType: "TOOL_CALLING",
		});
		expect(choice?.models).toEqual([
			expect.objectContaining({
				slug: "gpt-6-astra",
				isDefault: false,
				newest: true,
			}),
			expect.objectContaining({
				slug: "gpt-6.1-sol",
				isDefault: true,
				newest: false,
			}),
		]);
	});

	it("offers only the organization's model before the plan's list was read, and asks for it", async () => {
		db.catalog = [
			{
				canonicalName: "gpt-6.1-sol",
				slug: "gpt-6.1-sol",
				displayName: "GPT-6.1 Sol (ChatGPT plan)",
			},
			{
				canonicalName: "gpt-6-astra",
				slug: "gpt-6-astra",
				displayName: "GPT-6 Astra (ChatGPT plan)",
			},
		];
		db.served = [];
		const choice = await interactivePlanModel({
			userId: "user_1",
			organizationId: "org_a",
			taskType: "TOOL_CALLING",
		});
		expect(choice?.models.map((model) => model.slug)).toEqual([
			"gpt-6.1-sol",
		]);
		expect(refreshStale).toHaveBeenCalled();
	});

	it("is null when no plan serves the member's work", async () => {
		db.accounts = [account("acc_1", { serveInteractive: false })];
		await expect(
			interactivePlanModel({
				userId: "user_1",
				organizationId: "org_a",
				taskType: "CHAT",
			}),
		).resolves.toBeNull();
	});
});

// Fizzy #2770 F3: the link dialogs warn when shared plans run background jobs.
describe("sharedPlansServeBackgroundWork", () => {
	it("is true with pooling on, terms accepted and a signed-in account that serves background work", async () => {
		db.accounts = [
			account("acc_off", { enabled: false }),
			account("acc_bg", { serveBackground: true }),
		];
		await expect(sharedPlansServeBackgroundWork("org_a")).resolves.toBe(
			true,
		);
	});

	it("is false without such an account, with pooling off, or with the flags off", async () => {
		db.accounts = [
			account("acc_people", { serveBackground: false }),
			account("acc_reconnect", { status: "NEEDS_RECONNECT" }),
		];
		await expect(sharedPlansServeBackgroundWork("org_a")).resolves.toBe(
			false,
		);
		db.accounts = [account("acc_bg")];
		db.policy = { ...db.policy, poolingEnabled: false };
		await expect(sharedPlansServeBackgroundWork("org_a")).resolves.toBe(
			false,
		);
		db.policy = { ...db.policy, poolingEnabled: true };
		db.flags = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: false };
		await expect(sharedPlansServeBackgroundWork("org_a")).resolves.toBe(
			false,
		);
	});
});
