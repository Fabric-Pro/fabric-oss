import { beforeEach, describe, expect, it, vi } from "vitest";

// Run the real credential services, database queries and advisory-lock helper.
// Only the SQL transport and provider are replaced, so missing participation
// in the lock changes the final tokens and rows, rather than a mock call count.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
	own: [] as Row[],
	shared: [] as Row[],
	// Per-source rows (Fizzy #3037), keyed by sourceKind and sourceId.
	sourceState: [] as Row[],
	servedModels: [] as Row[],
	observations: [] as Row[],
	accuracy: [] as Row[],
	tails: new Map<number, Promise<void>>(),
	beforeOwnCreate: undefined as (() => Promise<void>) | undefined,
	beforeReconnectMark: undefined as (() => Promise<void>) | undefined,
	/** Runs before any per-source row is written. */
	beforeSourceWrite: undefined as (() => Promise<void>) | undefined,
}));

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as Row[]).some((part) => matches(row, part));
		}
		if (value && typeof value === "object" && "equals" in value) {
			return (
				String(row[key]).toLowerCase() ===
				String(value.equals).toLowerCase()
			);
		}
		if (value && typeof value === "object" && "gt" in value) {
			return (row[key] as number) > (value.gt as number);
		}
		if (value && typeof value === "object" && "in" in value) {
			return (value.in as unknown[]).includes(row[key]);
		}
		return row[key] === value;
	});
}

function sourceTable(
	name: "sourceState" | "servedModels" | "observations" | "accuracy",
) {
	const write = async () => {
		await state.beforeSourceWrite?.();
	};
	return {
		findMany: async ({ where }: { where: Row }) =>
			state[name]
				.filter((row) => matches(row, where))
				.map((row) => ({ ...row })),
		upsert: async ({
			where,
			create,
			update,
		}: {
			where: { sourceKind_sourceId: Row };
			create: Row;
			update: Row;
		}) => {
			await write();
			const row = state[name].find((entry) =>
				matches(entry, where.sourceKind_sourceId),
			);
			if (row) {
				Object.assign(row, update);
				return { ...row };
			}
			state[name].push({ ...create });
			return { ...create };
		},
		createMany: async ({ data }: { data: Row[] }) => {
			await write();
			state[name].push(...data.map((row) => ({ ...row })));
			return { count: data.length };
		},
		updateMany: async ({ where, data }: { where: Row; data: Row }) => {
			const rows = state[name].filter((entry) => matches(entry, where));
			for (const row of rows) {
				Object.assign(row, data);
			}
			return { count: rows.length };
		},
		deleteMany: async ({ where }: { where: Row }) => {
			const before = state[name].length;
			state[name] = state[name].filter((entry) => !matches(entry, where));
			return { count: before - state[name].length };
		},
	};
}

function table(name: "own" | "shared") {
	const read = async ({ where }: { where: Row }) => {
		const row = state[name].find((entry) => matches(entry, where));
		return row ? { ...row } : null;
	};
	return {
		findUnique: read,
		findFirst: read,
		create: async ({ data }: { data: Row }) => {
			if (name === "own") {
				await state.beforeOwnCreate?.();
			}
			if (
				name === "own" &&
				state.own.some((row) => row.userId === data.userId)
			) {
				throw new Error("unique userId violated");
			}
			const row = { id: `${name}-new`, ...data };
			state[name].push(row);
			return { ...row };
		},
		update: async ({ where, data }: { where: Row; data: Row }) => {
			const row = state[name].find((entry) => matches(entry, where));
			if (!row) {
				throw new Error("row missing");
			}
			Object.assign(row, data);
			return { ...row };
		},
		updateMany: async ({ where, data }: { where: Row; data: Row }) => {
			if (data.status === "NEEDS_RECONNECT") {
				await state.beforeReconnectMark?.();
			}
			const rows = state[name].filter((entry) => matches(entry, where));
			for (const row of rows) {
				Object.assign(row, data);
			}
			return { count: rows.length };
		},
		deleteMany: async ({ where }: { where: Row }) => {
			const before = state[name].length;
			state[name] = state[name].filter((entry) => !matches(entry, where));
			return { count: before - state[name].length };
		},
	};
}

vi.mock("@repo/database/prisma/client", async () => {
	const { Prisma } = await import("@repo/database/prisma/generated/client");
	const unusedState = {
		deleteMany: async () => ({ count: 0 }),
		updateMany: async () => ({ count: 0 }),
		upsert: async () => ({}),
	};
	const delegates = {
		chatGptPlanCredential: table("own"),
		chatGptPlanOrgAccount: table("shared"),
		chatGptPlanSourceState: sourceTable("sourceState"),
		chatGptPlanServedModel: sourceTable("servedModels"),
		chatGptPlanBudgetObservation: sourceTable("observations"),
		chatGptPlanWindowAccuracy: sourceTable("accuracy"),
		chatGptPlanOrgUse: unusedState,
	};
	const db = {
		...delegates,
		$transaction: async (
			work: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[],
		) => {
			if (Array.isArray(work)) {
				return Promise.all(work);
			}
			const releases: (() => void)[] = [];
			const tx = {
				...delegates,
				$executeRaw: async (
					_sql: TemplateStringsArray,
					_class: number,
					key: number,
				) => {
					const previous = state.tails.get(key) ?? Promise.resolve();
					let release!: () => void;
					state.tails.set(
						key,
						new Promise<void>((resolve) => {
							release = resolve;
						}),
					);
					await previous;
					releases.push(release);
					return 1;
				},
			};
			try {
				return await work(tx);
			} finally {
				for (const release of releases.reverse()) {
					release();
				}
			}
		},
	};
	return { db, Prisma };
});
vi.mock("@repo/database", async () => ({
	...(await import("../../database/prisma/queries/chatgpt-plan-credentials")),
	...(await import(
		"../../database/prisma/queries/chatgpt-plan-org-accounts"
	)),
	...(await import(
		"../../database/prisma/queries/chatgpt-plan-source-state"
	)),
	...(await import(
		"../../database/prisma/queries/chatgpt-plan-served-models"
	)),
	ensureChatGptPlanCatalogModels: async () => [],
	getChatGptPlanOrgAccountWindows: async () => new Map(),
	notifyChatGptPlanOrgAccountNeedsReconnect: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc:${value}`,
	decryptApiKey: (value: string) => value.slice(4),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import {
	deleteChatGptPlanCredential,
	deleteChatGptPlanOrgAccount,
	markChatGptPlanSourceAnswered,
	notifyChatGptPlanOrgAccountNeedsReconnect,
} from "@repo/database";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import { generateText } from "ai";
import {
	__resetChatGptPlanBreaker,
	chatGptPlanSourceExhaustedError,
	recordChatGptPlanSourceExhausted,
	recordReportedChatGptPlanSourceExhausted,
} from "../lib/chatgpt-plan/exhaustion-breaker";
import {
	disconnectChatGptPlan,
	disconnectChatGptPlanOrgAccount,
	getChatGptPlanSourceAccessToken,
	storeChatGptPlanCredential,
	storeChatGptPlanOrgAccount,
} from "../lib/chatgpt-plan/plan-credentials";
import {
	shareOwnChatGptPlan,
	takeBackSharedChatGptPlan,
} from "../lib/chatgpt-plan/plan-move";
import { createChatGptPlanModel } from "../lib/chatgpt-plan/provider";
import {
	__resetChatGptPlanServedModelProbes,
	refreshChatGptPlanServedModels,
} from "../lib/chatgpt-plan/served-models";
import { chatGptPlanServedSlugs } from "../lib/chatgpt-plan/served-slugs";
import {
	chatGptPlanSourceLockKey,
	planSourceStateKey,
} from "../lib/chatgpt-plan/sources";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const userId = "example-user";
const organizationId = "example-org";
const accountId = "example-account";
const params = { userId, organizationId, accountId };
function generation(name: string) {
	return {
		email: "plan@example.com",
		subject: `subject-${name}`,
		clientId: `client-${name}`,
		hostId: `host-${name}`,
		encryptedAccessToken: `enc:access-${name}`,
		encryptedRefreshToken: `enc:refresh-${name}`,
		encryptedIdToken: null,
		accessTokenExpiresAt: new Date(NOW + 30_000),
		earliestRefreshAt: null,
		scopes: ["chatgpt.tokens.use.direct"],
		status: "ACTIVE",
		tier: "PLUS",
		subscriptionActiveUntil: null,
	};
}
function replacement() {
	return {
		userId,
		organizationId,
		connectedByUserId: userId,
		label: "Example plan",
		email: "plan@example.com",
		subject: "subject-B",
		clientId: "client-B",
		hostId: "host-B",
		scopes: ["chatgpt.tokens.use.direct"],
		now: NOW,
		tokens: {
			access_token: "access-B",
			refresh_token: "refresh-B",
			id_token: "synthetic-id-B",
			token_type: "Bearer",
			expires_in: 3600,
		},
	};
}
function gate() {
	let release!: () => void;
	let enter!: () => void;
	return {
		entered: new Promise<void>((resolve) => {
			enter = resolve;
		}),
		wait: new Promise<void>((resolve) => {
			release = resolve;
		}),
		enter: () => enter(),
		release: () => release(),
	};
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
	state.own = [];
	state.shared = [];
	state.sourceState = [];
	state.servedModels = [];
	state.observations = [];
	state.accuracy = [];
	state.tails.clear();
	state.beforeOwnCreate = undefined;
	state.beforeReconnectMark = undefined;
	state.beforeSourceWrite = undefined;
	__resetChatGptPlanBreaker();
	__resetChatGptPlanServedModelProbes();
	vi.mocked(notifyChatGptPlanOrgAccountNeedsReconnect).mockClear();
});

for (const kind of ["user", "org"] as const) {
	const ref =
		kind === "user"
			? { kind, userId }
			: { kind, organizationId, accountId };
	const rows = () => (kind === "user" ? state.own : state.shared);
	const connect = () =>
		kind === "user"
			? storeChatGptPlanCredential(replacement())
			: storeChatGptPlanOrgAccount(replacement());
	const disconnect = (fetchImpl: typeof fetch) =>
		kind === "user"
			? disconnectChatGptPlan(userId, { fetchImpl })
			: disconnectChatGptPlanOrgAccount(params, { fetchImpl });
	const move = () =>
		kind === "user"
			? shareOwnChatGptPlan({ ...params, label: "Example plan" })
			: takeBackSharedChatGptPlan(params);

	describe(`${kind} credential lifecycle`, () => {
		beforeEach(() => {
			rows().push({
				id: kind === "user" ? "example-credential" : accountId,
				userId,
				organizationId,
				connectedByUserId: userId,
				...generation("A"),
			});
		});

		it("keeps replacement tokens and client together when refresh is in flight", async () => {
			const provider = gate();
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () => {
					provider.enter();
					await provider.wait;
					return Response.json({
						access_token: "rotated-A",
						refresh_token: "rotated-refresh-A",
						token_type: "Bearer",
						expires_in: 3600,
					});
				},
			});
			await provider.entered;
			const replacing = connect();
			await turn();
			provider.release();
			await Promise.all([refresh, replacing]);
			expect(rows()[0]).toMatchObject({
				clientId: "client-B",
				subject: "subject-B",
				encryptedAccessToken: "enc:access-B",
				encryptedRefreshToken: "enc:refresh-B",
			});
		});

		it("keeps a reconnect active when the previous refresh failure is delayed", async () => {
			const marking = gate();
			state.beforeReconnectMark = async () => {
				marking.enter();
				await marking.wait;
			};
			// Delay the status SQL after the failing refresh transaction releases
			// its lock, then run the real reconnect service and database query.
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () =>
					Response.json({ error: "invalid_grant" }, { status: 400 }),
			}).catch((error: { code: string }) => error.code);
			await marking.entered;
			await connect();
			marking.release();
			expect(await refresh).toBe("invalid_grant");
			expect(rows()[0]).toMatchObject({
				status: "ACTIVE",
				clientId: "client-B",
				encryptedRefreshToken: "enc:refresh-B",
			});
			expect(
				notifyChatGptPlanOrgAccountNeedsReconnect,
			).not.toHaveBeenCalled();
		});

		it("marks an unchanged failed credential and announces a shared account once", async () => {
			const fetchImpl = vi.fn<typeof fetch>(async () =>
				Response.json({ error: "invalid_grant" }, { status: 400 }),
			);
			await expect(
				getChatGptPlanSourceAccessToken(ref, {
					now: () => NOW,
					fetchImpl,
				}),
			).rejects.toMatchObject({ code: "invalid_grant" });
			expect(rows()[0]?.status).toBe("NEEDS_RECONNECT");
			await expect(
				getChatGptPlanSourceAccessToken(ref, {
					now: () => NOW,
					fetchImpl,
				}),
			).rejects.toMatchObject({ code: "needs_reconnect" });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(
				notifyChatGptPlanOrgAccountNeedsReconnect,
			).toHaveBeenCalledTimes(kind === "org" ? 1 : 0);
		});

		it("preserves a new access token even when reconnect retains the client and refresh token", async () => {
			const marking = gate();
			state.beforeReconnectMark = async () => {
				marking.enter();
				await marking.wait;
			};
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () =>
					Response.json({ error: "invalid_grant" }, { status: 400 }),
			}).catch((error: { code: string }) => error.code);
			await marking.entered;
			const input = {
				...replacement(),
				clientId: "client-A",
				tokens: { ...replacement().tokens, refresh_token: "refresh-A" },
			};
			await (kind === "user"
				? storeChatGptPlanCredential(input)
				: storeChatGptPlanOrgAccount(input));
			marking.release();
			expect(await refresh).toBe("invalid_grant");
			expect(rows()[0]).toMatchObject({
				status: "ACTIVE",
				encryptedAccessToken: "enc:access-B",
			});
			expect(
				notifyChatGptPlanOrgAccountNeedsReconnect,
			).not.toHaveBeenCalled();
		});

		it("marks the credential that failed under the lock after a queued reconnect", async () => {
			const holding = gate();
			const held = withRefreshLock(
				chatGptPlanSourceLockKey(ref),
				async () => {
					holding.enter();
					await holding.wait;
				},
			);
			await holding.entered;
			const replacing = connect();
			await turn();
			const usedTokens: string[] = [];
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				// Reconnect B is also near expiry for this request.
				now: () => NOW + 3_590_000,
				fetchImpl: async (_url, init) => {
					usedTokens.push(
						new URLSearchParams(String(init?.body)).get(
							"refresh_token",
						) ?? "",
					);
					return Response.json(
						{ error: "invalid_grant" },
						{ status: 400 },
					);
				},
			}).catch((error: { code: string }) => error.code);
			await turn();
			holding.release();
			await Promise.all([held, replacing]);
			expect(await refresh).toBe("invalid_grant");
			expect(usedTokens).toEqual(["refresh-B"]);
			expect(rows()[0]).toMatchObject({
				clientId: "client-B",
				status: "NEEDS_RECONNECT",
			});
		});

		it("preserves a reconnect queued while the previous generation is being revoked", async () => {
			const provider = gate();
			const revoking = disconnect(async () => {
				provider.enter();
				await provider.wait;
				return new Response("{}");
			});
			await provider.entered;
			const replacing = connect();
			await turn();
			provider.release();
			await Promise.all([revoking, replacing]);
			expect(rows()).toEqual([
				expect.objectContaining({
					clientId: "client-B",
					encryptedRefreshToken: "enc:refresh-B",
				}),
			]);
		});

		it("does not move a generation while disconnect is revoking it", async () => {
			const provider = gate();
			const revoking = disconnect(async () => {
				provider.enter();
				await provider.wait;
				return new Response("{}");
			});
			await provider.entered;
			const moving = move().then(
				() => "moved",
				(error: { reason: string }) => error.reason,
			);
			await turn();
			provider.release();
			await revoking;
			expect(await moving).toBe("not_found");
			expect(state.own).toEqual([]);
			expect(state.shared).toEqual([]);
		});

		it("revokes the refreshed token when disconnect waits for refresh", async () => {
			const provider = gate();
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () => {
					provider.enter();
					await provider.wait;
					return Response.json({
						access_token: "rotated-A",
						refresh_token: "rotated-refresh-A",
						token_type: "Bearer",
						expires_in: 3600,
					});
				},
			});
			await provider.entered;
			const revoked: string[] = [];
			const revoking = disconnect(async (_url, init) => {
				revoked.push(
					new URLSearchParams(String(init?.body)).get("token") ?? "",
				);
				return new Response("{}");
			});
			await turn();
			provider.release();
			await Promise.all([refresh, revoking]);
			expect(revoked).toEqual(["rotated-refresh-A"]);
			expect(rows()).toEqual([]);
		});

		it("keeps direct database deletion behind an in-flight refresh", async () => {
			const provider = gate();
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () => {
					provider.enter();
					await provider.wait;
					return Response.json({
						access_token: "rotated-A",
						refresh_token: "rotated-refresh-A",
						token_type: "Bearer",
						expires_in: 3600,
					});
				},
			});
			await provider.entered;
			const deleting =
				kind === "user"
					? deleteChatGptPlanCredential(userId)
					: deleteChatGptPlanOrgAccount(params);
			await turn();
			provider.release();
			await expect(refresh).resolves.toMatchObject({
				accessToken: "rotated-A",
			});
			await expect(deleting).resolves.toBe(true);
			expect(rows()).toEqual([]);
		});

		it("refuses to start revocation when the transaction lacks its provider budget", async () => {
			const clock = vi
				.spyOn(performance, "now")
				.mockReturnValueOnce(0)
				.mockReturnValue(16_000);
			const fetchImpl = vi.fn<typeof fetch>(
				async () => new Response("{}"),
			);
			try {
				await expect(disconnect(fetchImpl)).rejects.toMatchObject({
					name: "RefreshLockBudgetExhaustedError",
				});
				expect(fetchImpl).not.toHaveBeenCalled();
				expect(rows()[0]).toMatchObject({
					encryptedRefreshToken: "enc:refresh-A",
				});
			} finally {
				clock.mockRestore();
			}
		});

		it("moves the refreshed generation after an in-flight refresh", async () => {
			const provider = gate();
			const refresh = getChatGptPlanSourceAccessToken(ref, {
				now: () => NOW,
				fetchImpl: async () => {
					provider.enter();
					await provider.wait;
					return Response.json({
						access_token: "rotated-A",
						refresh_token: "rotated-refresh-A",
						token_type: "Bearer",
						expires_in: 3600,
					});
				},
			});
			await provider.entered;
			const moving = move();
			await turn();
			provider.release();
			await Promise.all([refresh, moving]);
			const destination = kind === "user" ? state.shared : state.own;
			expect(destination[0]).toMatchObject({
				clientId: "client-A",
				encryptedRefreshToken: "enc:rotated-refresh-A",
			});
			expect(rows()).toEqual([]);
		});

		// Fizzy #3037: work begun with the previous sign-in's token finishes
		// after the source was replaced or disconnected.
		describe("work begun with the previous sign-in", () => {
			const HOUR = 3_600_000;
			const stateKey = planSourceStateKey(ref);
			const spent = () =>
				new SubscriptionPlanExhaustedError(
					"limit",
					new Date(NOW + HOUR),
				);
			const revoke = async () => new Response("{}");
			// A member's own plan replaced by another ChatGPT account; another
			// account is a new row for an organization, so a shared account
			// is reconnected under a new subject instead.
			const cleanups = {
				replacement: () =>
					kind === "user"
						? storeChatGptPlanCredential({
								...replacement(),
								email: "other@example.com",
							})
						: storeChatGptPlanOrgAccount(replacement()),
				disconnect: () => disconnect(revoke),
			};
			// Cleanups that also remove the source's rows.
			const clearing =
				kind === "user"
					? (["replacement", "disconnect"] as const)
					: (["disconnect"] as const);
			const signIn = async () =>
				(await getChatGptPlanSourceAccessToken(ref))
					.credentialFingerprint;

			// Tokens stay valid, so no read here refreshes one.
			const keepTokensValid = () => {
				for (const row of rows()) {
					row.accessTokenExpiresAt = new Date(Date.now() + HOUR);
				}
			};
			beforeEach(keepTokensValid);

			it("records a refusal from the sign-in the source still has", async () => {
				await recordChatGptPlanSourceExhausted(
					ref,
					await signIn(),
					spent(),
				);
				expect(state.sourceState).toEqual([
					expect.objectContaining({
						...stateKey,
						openUntil: new Date(NOW + HOUR),
					}),
				]);
				expect(
					await chatGptPlanSourceExhaustedError(ref, NOW),
				).toBeInstanceOf(SubscriptionPlanExhaustedError);
			});

			it.each(["replacement", "disconnect"] as const)(
				"drops a refusal from the previous sign-in after a %s",
				async (cleanup) => {
					const previous = await signIn();
					await cleanups[cleanup]();
					await recordChatGptPlanSourceExhausted(
						ref,
						previous,
						spent(),
					);
					expect(state.sourceState).toEqual([]);
					expect(
						await chatGptPlanSourceExhaustedError(ref, NOW),
					).toBeNull();
				},
			);

			it.each(clearing)(
				"leaves nothing behind when the refusal's write commits before a %s",
				async (cleanup) => {
					const previous = await signIn();
					const writing = gate();
					state.beforeSourceWrite = async () => {
						writing.enter();
						await writing.wait;
					};
					const recording = recordChatGptPlanSourceExhausted(
						ref,
						previous,
						spent(),
					);
					await writing.entered;
					state.beforeSourceWrite = undefined;
					const cleaning = cleanups[cleanup]();
					await turn();
					writing.release();
					await Promise.all([recording, cleaning]);
					expect(state.sourceState).toEqual([]);
				},
			);

			it("does not clear the new sign-in's spent window when the previous one answers", async () => {
				const previous = await signIn();
				await cleanups.replacement();
				keepTokensValid();
				const current = await signIn();
				await recordChatGptPlanSourceExhausted(ref, current, spent());
				await expect(
					markChatGptPlanSourceAnswered(stateKey, previous),
				).resolves.toBe(false);
				expect(state.sourceState[0]?.openUntil).toEqual(
					new Date(NOW + HOUR),
				);
				await expect(
					markChatGptPlanSourceAnswered(stateKey, current),
				).resolves.toBe(true);
				expect(state.sourceState[0]?.openUntil).toBeNull();
			});

			it.each(["replacement", "disconnect"] as const)(
				"drops an agent's report naming the previous sign-in after a %s",
				async (cleanup) => {
					const previous = await signIn();
					await cleanups[cleanup]();
					await recordReportedChatGptPlanSourceExhausted(
						ref,
						spent(),
						previous,
					);
					expect(state.sourceState).toEqual([]);
				},
			);

			it("still records an older agent's report that names no sign-in, while one is connected", async () => {
				await cleanups.replacement();
				await recordReportedChatGptPlanSourceExhausted(
					ref,
					spent(),
					null,
				);
				expect(state.sourceState).toHaveLength(1);
				await disconnect(revoke);
				await recordReportedChatGptPlanSourceExhausted(
					ref,
					spent(),
					null,
				);
				expect(state.sourceState).toEqual([]);
			});

			it.each([undefined, "replacement", "disconnect"] as const)(
				"binds a plan call's refusal to the sign-in it used (cleanup: %s)",
				async (cleanup) => {
					const api = gate();
					const model = createChatGptPlanModel({
						userId,
						source: ref,
						modelId: "gpt-test",
						fetchImpl: async () => {
							api.enter();
							await api.wait;
							return Response.json(
								{
									error: {
										code: CHATGPT_PLAN_EXHAUSTED_CODE,
										message: "limit",
										resets_at: new Date(
											Date.now() + HOUR,
										).toISOString(),
									},
								},
								{ status: 429 },
							);
						},
					});
					const calling = generateText({ model, prompt: "x" }).catch(
						(error: unknown) => error,
					);
					await api.entered;
					if (cleanup) {
						await cleanups[cleanup]();
					}
					api.release();
					expect(await calling).toBeInstanceOf(
						SubscriptionPlanExhaustedError,
					);
					expect(state.sourceState).toHaveLength(cleanup ? 0 : 1);
				},
			);

			it.each([undefined, "replacement", "disconnect"] as const)(
				"stores a model list only for the sign-in that listed it (cleanup: %s)",
				async (cleanup) => {
					const listing = gate();
					const probing = refreshChatGptPlanServedModels(ref, {
						fetchImpl: async () => {
							listing.enter();
							await listing.wait;
							return Response.json({
								models: [{ slug: "previous-model" }],
							});
						},
					});
					await listing.entered;
					if (cleanup) {
						await cleanups[cleanup]();
					}
					listing.release();
					await probing;
					expect(state.servedModels).toHaveLength(cleanup ? 0 : 1);
				},
			);

			it("forgets this process's cached state when the plan is disconnected", async () => {
				await recordChatGptPlanSourceExhausted(
					ref,
					await signIn(),
					spent(),
				);
				state.servedModels.push({
					...stateKey,
					slug: "previous-model",
				});
				expect(await chatGptPlanServedSlugs(ref)).toEqual(
					new Set(["previous-model"]),
				);
				await disconnect(revoke);
				expect(
					await chatGptPlanSourceExhaustedError(ref, NOW),
				).toBeNull();
				expect(await chatGptPlanServedSlugs(ref)).toBeNull();
			});
		});
	});
}

it("serializes a take-back with a reconnect of the destination own plan", async () => {
	state.shared.push({
		id: accountId,
		organizationId,
		connectedByUserId: userId,
		...generation("A"),
	});
	const creating = gate();
	state.beforeOwnCreate = async () => {
		creating.enter();
		await creating.wait;
	};
	const takingBack = takeBackSharedChatGptPlan(params);
	await creating.entered;
	// Pause only the move's create; reconnect must wait for the destination lock.
	state.beforeOwnCreate = undefined;
	const connecting = storeChatGptPlanCredential(replacement());
	await turn();
	creating.release();
	await Promise.all([takingBack, connecting]);
	expect(state.shared).toEqual([]);
	expect(state.own).toEqual([
		expect.objectContaining({
			clientId: "client-B",
			encryptedRefreshToken: "enc:refresh-B",
		}),
	]);
});

it("does not mark a recreated own credential with identical tokens", async () => {
	state.own.push({ id: "example-credential", userId, ...generation("A") });
	const marking = gate();
	state.beforeReconnectMark = async () => {
		marking.enter();
		await marking.wait;
	};
	const refresh = getChatGptPlanSourceAccessToken(
		{ kind: "user", userId },
		{
			now: () => NOW,
			fetchImpl: async () =>
				Response.json({ error: "invalid_grant" }, { status: 400 }),
		},
	).catch((error: { code: string }) => error.code);
	await marking.entered;
	await deleteChatGptPlanCredential(userId);
	await storeChatGptPlanCredential({
		...replacement(),
		clientId: "client-A",
		tokens: {
			...replacement().tokens,
			access_token: "access-A",
			refresh_token: "refresh-A",
		},
	});
	marking.release();
	expect(await refresh).toBe("invalid_grant");
	expect(state.own[0]).toMatchObject({ id: "own-new", status: "ACTIVE" });
});

it("serializes a take-back with disconnect of its destination own plan", async () => {
	state.shared.push({
		id: accountId,
		organizationId,
		connectedByUserId: userId,
		...generation("A"),
	});
	const creating = gate();
	state.beforeOwnCreate = async () => {
		creating.enter();
		await creating.wait;
	};
	const takingBack = takeBackSharedChatGptPlan(params);
	await creating.entered;
	const revoked: string[] = [];
	const disconnecting = disconnectChatGptPlan(userId, {
		fetchImpl: async (_url, init) => {
			revoked.push(
				new URLSearchParams(String(init?.body)).get("token") ?? "",
			);
			return new Response("{}");
		},
	});
	await turn();
	creating.release();
	await takingBack;
	await expect(disconnecting).resolves.toBe(true);
	expect(revoked).toEqual(["refresh-A"]);
	expect(state.own).toEqual([]);
	expect(state.shared).toEqual([]);
});
