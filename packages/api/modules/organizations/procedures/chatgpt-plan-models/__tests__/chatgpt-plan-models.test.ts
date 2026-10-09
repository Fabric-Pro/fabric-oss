/**
 * The organization's ChatGPT plan models (Fizzy #2770): every member reads
 * them, only admins and owners change them, always for the session's
 * organization, and only with CHATGPT_PLAN on. The models offered are the
 * ones the organization's plans list as served (F8), and the fallback model
 * is the organization's to choose, audited (F10).
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flag: true,
	role: "member" as string | null,
	membershipCalls: [] as unknown[],
	choices: vi.fn(),
	models: vi.fn(),
	set: vi.fn(),
	policy: vi.fn(),
	sources: vi.fn(),
	served: vi.fn(),
	setFallback: vi.fn(),
	refreshStale: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	CHATGPT_PLAN_MODEL_TASK_TYPES: [
		"COMPLEX",
		"REASONING",
		"TOOL_CALLING",
		"CHAT",
		"EVAL",
		"SIMPLE",
	],
	isFeatureEnabled: async () => mocks.flag,
	getChatGptPlanOrgModelChoices: mocks.choices,
	listChatGptPlanModels: mocks.models,
	setChatGptPlanOrgModel: mocks.set,
	getChatGptPlanOrgPolicy: mocks.policy,
	listChatGptPlanOrgSources: mocks.sources,
	getChatGptPlanServedModels: mocks.served,
	setChatGptPlanOrgFallbackModel: mocks.setFallback,
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL: "gpt-6-astra",
	chatGptPlanModelLabel: (name: string) =>
		name.endsWith(" (ChatGPT plan)") ? name : `${name} (ChatGPT plan)`,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/served-models", () => ({
	refreshStaleChatGptPlanServedModels: mocks.refreshStale,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));

vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: async (userId: string, organizationId: string) => {
		mocks.membershipCalls.push({ userId, organizationId });
		return mocks.role ? { role: mocks.role } : null;
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		Permissions: { ORG_READ: "", ORG_AI_CONFIG_EDIT: "" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import {
	getChatGptPlanModelsProcedure,
	setChatGptPlanFallbackModelProcedure,
	setChatGptPlanModelProcedure,
} from "../index";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const handler = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;

const context = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_a" },
};

const rejection = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flag = true;
	mocks.role = "member";
	mocks.membershipCalls = [];
	mocks.choices.mockResolvedValue([
		{
			taskType: "COMPLEX",
			model: { canonicalName: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
			source: "default",
		},
	]);
	mocks.models.mockResolvedValue([]);
	mocks.set.mockResolvedValue(true);
	mocks.policy.mockResolvedValue({ fallbackModel: "gpt-6-astra" });
	mocks.sources.mockResolvedValue([]);
	mocks.served.mockResolvedValue([]);
	mocks.setFallback.mockResolvedValue({ saved: true, before: "gpt-6-astra" });
});

const catalogModel = (slug: string, displayName: string) => ({
	canonicalName: slug,
	slug,
	displayName,
	description: `${displayName} description`,
	autoDetected: false,
});

const servedRow = (sourceId: string, slug: string, priority: number) => ({
	sourceKind: "ORG",
	sourceId,
	slug,
	displayName: slug,
	description: null,
	priority,
	checkedAt: new Date("2026-10-08T10:00:00Z"),
});

describe("organizations.chatgptPlanModels", () => {
	it("lets any member read the session organization's choices, read-only", async () => {
		await expect(
			handler(getChatGptPlanModelsProcedure)({ context }),
		).resolves.toMatchObject({ canEdit: false });
		expect(mocks.choices).toHaveBeenCalledWith("org_a");
		expect(mocks.membershipCalls).toEqual([
			{ userId: "user_1", organizationId: "org_a" },
		]);
	});

	it("tells admins and owners they may edit", async () => {
		mocks.role = "owner";
		await expect(
			handler(getChatGptPlanModelsProcedure)({ context }),
		).resolves.toMatchObject({ canEdit: true });
	});

	it("answers NOT_FOUND with CHATGPT_PLAN off", async () => {
		mocks.flag = false;
		const error = await rejection(
			handler(getChatGptPlanModelsProcedure)({ context }),
		);
		expect(error.code).toBe("NOT_FOUND");
	});

	it("lets only admins and owners set a model", async () => {
		const error = await rejection(
			handler(setChatGptPlanModelProcedure)({
				context,
				input: {
					taskType: "COMPLEX",
					modelCanonicalName: "gpt-6-astra",
				},
			}),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.set).not.toHaveBeenCalled();

		mocks.role = "admin";
		await handler(setChatGptPlanModelProcedure)({
			context,
			input: { taskType: "COMPLEX", modelCanonicalName: "gpt-6-astra" },
		});
		expect(mocks.set).toHaveBeenCalledWith({
			organizationId: "org_a",
			taskType: "COMPLEX",
			modelCanonicalName: "gpt-6-astra",
		});
	});

	it("refuses a model no ChatGPT plan serves", async () => {
		mocks.role = "admin";
		mocks.set.mockResolvedValue(false);
		const error = await rejection(
			handler(setChatGptPlanModelProcedure)({
				context,
				input: { taskType: "CHAT", modelCanonicalName: "claude-opus" },
			}),
		);
		expect(error.code).toBe("BAD_REQUEST");
	});
});

describe("organizations.chatgptPlanModels — served models (F8)", () => {
	beforeEach(() => {
		mocks.models.mockResolvedValue([
			catalogModel("gpt-6-astra", "GPT-6 Astra (ChatGPT plan)"),
			catalogModel("gpt-5.6-sol", "GPT-5.6 Sol (ChatGPT plan)"),
			catalogModel("gpt-5.6-luna", "GPT-5.6 Luna (ChatGPT plan)"),
		]);
		mocks.sources.mockResolvedValue([
			{ sourceKind: "ORG", sourceId: "acc_1" },
			{ sourceKind: "USER", sourceId: "user_2" },
		]);
	});

	it("offers every catalog plan model before any plan was checked", async () => {
		const result = (await handler(getChatGptPlanModelsProcedure)({
			context,
		})) as {
			models: Array<{ slug: string }>;
			servedCheckedAt: Date | null;
		};
		expect(result.models.map((model) => model.slug)).toEqual([
			"gpt-6-astra",
			"gpt-5.6-sol",
			"gpt-5.6-luna",
		]);
		expect(result.servedCheckedAt).toBeNull();
		// Each source is handed to the background refresh, never awaited.
		expect(mocks.refreshStale).toHaveBeenCalledWith(
			[
				{ kind: "org", organizationId: "org_a", accountId: "acc_1" },
				{ kind: "user", userId: "user_2" },
			],
			[],
		);
	});

	it("offers only models a plan serves, marks the newest, and flags a chosen model no plan lists", async () => {
		mocks.served.mockResolvedValue([
			servedRow("acc_1", "gpt-6-astra", 2),
			servedRow("acc_1", "gpt-5.6-luna", 9),
		]);
		const result = (await handler(getChatGptPlanModelsProcedure)({
			context,
		})) as {
			models: Array<{ slug: string; newest: boolean }>;
			tasks: Array<{ noLongerServed: boolean; model: unknown }>;
			fallbackModel: string | null;
			recommendedFallbackModel: string;
			servedCheckedAt: Date | null;
		};
		expect(result.models).toEqual([
			expect.objectContaining({ slug: "gpt-6-astra", newest: true }),
			expect.objectContaining({ slug: "gpt-5.6-luna", newest: false }),
		]);
		// The preference stays; the card says it is no longer served.
		expect(result.tasks[0]).toMatchObject({
			model: {
				canonicalName: "gpt-5.6-sol",
				displayName: "GPT-5.6 Sol (ChatGPT plan)",
			},
			noLongerServed: true,
		});
		expect(result).toMatchObject({
			fallbackModel: "gpt-6-astra",
			recommendedFallbackModel: "gpt-6-astra",
			servedCheckedAt: new Date("2026-10-08T10:00:00Z"),
			// One member's own plan is among the sources.
			ownPlanMembers: 1,
		});
	});
});

describe("organizations.chatgptPlanModels.setFallback (F10)", () => {
	const setFallback = (fallbackModel: string | null, ctx = context) =>
		handler(setChatGptPlanFallbackModelProcedure)({
			context: ctx,
			input: { fallbackModel },
		});

	it("lets only admins and owners choose it", async () => {
		const error = await rejection(setFallback("gpt-5.6-sol"));
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.setFallback).not.toHaveBeenCalled();
	});

	it("refuses someone acting as another user", async () => {
		mocks.role = "owner";
		const error = await rejection(
			setFallback("gpt-5.6-sol", {
				...context,
				session: { ...context.session, impersonatedBy: "admin_1" },
			} as typeof context),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.setFallback).not.toHaveBeenCalled();
	});

	it("saves the choice, or no fallback, and audits the change", async () => {
		mocks.role = "admin";
		await setFallback(null);
		expect(mocks.setFallback).toHaveBeenCalledWith({
			organizationId: "org_a",
			slug: null,
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.fallback_model_changed",
				organizationId: "org_a",
				metadata: {
					before: { fallbackModel: "gpt-6-astra" },
					after: { fallbackModel: null },
				},
			}),
		);
	});

	it("records nothing when the value did not change", async () => {
		mocks.role = "admin";
		await setFallback("gpt-6-astra");
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("refuses a model no ChatGPT plan serves", async () => {
		mocks.role = "admin";
		mocks.setFallback.mockResolvedValue({ saved: false, before: null });
		const error = await rejection(setFallback("claude-opus"));
		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
