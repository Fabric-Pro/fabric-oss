/**
 * The plan's own model list (Fizzy #2770 F8): parsed from the account's
 * `GET /v1/models` (fixture: the 2026-10-06 probe, trimmed), stored per source
 * with any model the catalog does not know added to it, and refreshed in the
 * background once a stored list is a day old.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/chatgpt-plan-models-2026-10-06.json";

const db = vi.hoisted(() => ({
	ensure: vi.fn(),
	replace: vi.fn(),
	served: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	ensureChatGptPlanCatalogModels: db.ensure,
	replaceChatGptPlanServedModels: db.replace,
	getChatGptPlanServedModels: db.served,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: async () => ({ accessToken: "own-token" }),
	getChatGptPlanSourceAccessToken: async () => ({
		accessToken: "account-token",
	}),
}));

import {
	__resetChatGptPlanServedModelProbes,
	CHATGPT_PLAN_SERVED_MODELS_MAX_AGE_MS,
	chatGptPlanServedSlugs,
	parseChatGptPlanModelList,
	refreshChatGptPlanServedModels,
	refreshStaleChatGptPlanServedModels,
} from "../lib/chatgpt-plan/served-models";

const listResponse = (body: unknown = fixture) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

beforeEach(() => {
	vi.clearAllMocks();
	__resetChatGptPlanServedModelProbes();
	db.ensure.mockResolvedValue([]);
	db.replace.mockResolvedValue(undefined);
	db.served.mockResolvedValue([]);
});

describe("parseChatGptPlanModelList", () => {
	it("reads the 2026-10-06 probe in the server's order", () => {
		expect(parseChatGptPlanModelList(fixture)).toEqual([
			{
				slug: "gpt-6-astra",
				displayName: "GPT-6-Astra",
				description:
					"Frontier intelligence for the most demanding work.",
				priority: 2,
			},
			{
				slug: "gpt-5.6-sol",
				displayName: "GPT-5.6-Sol",
				description: "Older generation workhorse model.",
				priority: 5,
			},
			{
				slug: "gpt-5.6-terra",
				displayName: "GPT-5.6-Terra",
				description: "Older balanced model for straightforward work.",
				priority: 8,
			},
			{
				slug: "gpt-5.6-luna",
				displayName: "GPT-5.6-Luna",
				description: "Older fast and efficient model.",
				priority: 9,
			},
		]);
	});

	it("drops entries not meant for a picker and anything malformed", () => {
		expect(
			parseChatGptPlanModelList({
				models: [
					{ slug: "hidden", visibility: "hide" },
					{ display_name: "No slug" },
					null,
					{ slug: "bare" },
				],
			}),
		).toEqual([
			{
				slug: "bare",
				displayName: "bare",
				description: null,
				priority: null,
			},
		]);
		expect(parseChatGptPlanModelList({ error: "nope" })).toEqual([]);
	});
});

describe("refreshChatGptPlanServedModels", () => {
	it("lists with the source's own token, adds unknown models, and stores the list", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => listResponse());
		const now = new Date("2026-10-08T12:00:00Z");

		await refreshChatGptPlanServedModels(
			{ kind: "org", organizationId: "org_a", accountId: "acc_1" },
			{ fetchImpl, now },
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			{
				headers: { authorization: "Bearer account-token" },
			},
		);
		expect(db.ensure).toHaveBeenCalledWith(
			parseChatGptPlanModelList(fixture),
		);
		expect(db.replace).toHaveBeenCalledWith({
			sourceKind: "ORG",
			sourceId: "acc_1",
			models: parseChatGptPlanModelList(fixture),
			checkedAt: now,
		});
	});

	it("keeps the last list when the plan lists nothing, and throws on a failed request", async () => {
		await refreshChatGptPlanServedModels(
			{ kind: "user", userId: "user_1" },
			{ fetchImpl: async () => listResponse({ models: [] }) },
		);
		expect(db.replace).not.toHaveBeenCalled();

		await expect(
			refreshChatGptPlanServedModels(
				{ kind: "user", userId: "user_1" },
				{ fetchImpl: async () => new Response("no", { status: 403 }) },
			),
		).rejects.toThrow("403");
	});
});

describe("background refresh and lookups", () => {
	it("refreshes only a source never checked or checked over a day ago", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => listResponse());
		const now = Date.now();
		refreshStaleChatGptPlanServedModels(
			[
				{ kind: "user", userId: "fresh" },
				{ kind: "user", userId: "stale" },
				{ kind: "user", userId: "never" },
			],
			[
				{
					sourceKind: "USER",
					sourceId: "fresh",
					slug: "gpt-5.6-sol",
					displayName: "GPT-5.6-Sol",
					description: null,
					priority: 5,
					checkedAt: new Date(now - 60_000),
				},
				{
					sourceKind: "USER",
					sourceId: "stale",
					slug: "gpt-5.6-sol",
					displayName: "GPT-5.6-Sol",
					description: null,
					priority: 5,
					checkedAt: new Date(
						now - CHATGPT_PLAN_SERVED_MODELS_MAX_AGE_MS - 1,
					),
				},
			],
			now,
		);
		await vi.waitFor(() => expect(db.replace).toHaveBeenCalledTimes(2));
		expect(
			db.replace.mock.calls.map(([call]) => call.sourceId).sort(),
		).toEqual(["never", "stale"]);
		fetchSpy.mockRestore();
	});

	it("knows nothing about a source never checked", async () => {
		await expect(
			chatGptPlanServedSlugs({ kind: "user", userId: "user_1" }),
		).resolves.toBeNull();
		__resetChatGptPlanServedModelProbes();
		db.served.mockResolvedValue([{ slug: "gpt-5.6-sol" }]);
		await expect(
			chatGptPlanServedSlugs({ kind: "user", userId: "user_1" }),
		).resolves.toEqual(new Set(["gpt-5.6-sol"]));
	});

	// Every plan-served call reads the list; a process reuses it for a minute.
	it("reuses the stored list for a minute, then reads it again", async () => {
		const source = { kind: "user", userId: "user_1" } as const;
		const t0 = Date.parse("2026-10-08T12:00:00Z");
		db.served.mockResolvedValue([{ slug: "gpt-5.6-sol" }]);
		await chatGptPlanServedSlugs(source, t0);
		db.served.mockResolvedValue([{ slug: "gpt-6-astra" }]);
		await expect(
			chatGptPlanServedSlugs(source, t0 + 59_000),
		).resolves.toEqual(new Set(["gpt-5.6-sol"]));
		expect(db.served).toHaveBeenCalledTimes(1);
		await expect(
			chatGptPlanServedSlugs(source, t0 + 61_000),
		).resolves.toEqual(new Set(["gpt-6-astra"]));
		expect(db.served).toHaveBeenCalledTimes(2);
	});

	it("drops the reused list when this process re-reads the plan's models", async () => {
		const source = { kind: "user", userId: "user_1" } as const;
		db.served.mockResolvedValue([{ slug: "gpt-5.6-sol" }]);
		await chatGptPlanServedSlugs(source);
		const fetchImpl = vi.fn<typeof fetch>(async () => listResponse());
		await refreshChatGptPlanServedModels(source, {
			accessToken: "access-1",
			fetchImpl,
		});
		db.served.mockResolvedValue([{ slug: "gpt-6-astra" }]);
		await expect(chatGptPlanServedSlugs(source)).resolves.toEqual(
			new Set(["gpt-6-astra"]),
		);
	});
});
