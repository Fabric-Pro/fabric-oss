/**
 * Tests for setDefaultProviderProcedure — embeddings preservation on a
 * default-provider change.
 *
 * When the default AI provider changes, per-task model preferences are cleared
 * so users don't keep models that aren't available under the new provider. The
 * embeddings model, however, is pinned to the dedicated "Use for Documents"
 * provider (isEmbeddingProvider) independent of the default provider —
 * re-pointing it would invalidate already-indexed vectors. These tests verify
 * the EMBEDDING preference is excluded from the deleteMany exactly when a
 * documents provider governs embeddings, in both org and personal
 * contexts. In organization context the deletion predicate preserves DECISION: it is
 * pinned to the organization's Vercel AI Gateway rather than the default
 * provider, and its row can mean "switched off", which a clear would undo.
 * IMAGE is also pinned to Vercel AI Gateway and is preserved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockSelector,
	mockSystem,
	mockEmbeddingDefault,
	transactionState,
	mockOrgDeleteMany,
	mockUserDeleteMany,
	mockGetEmbeddingProviderConfig,
	mockRequireOrgMembership,
	mockResolveOrganizationId,
} = vi.hoisted(() => {
	const transactionState = {
		active: false,
		documentsProvider: null as string | null,
	};
	const mockOrgDeleteMany = vi.fn();
	const mockUserDeleteMany = vi.fn();
	const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
	const mockDb = {
		cloudProviderConfig: {
			findFirst: vi.fn(),
			findMany: vi.fn(async () => [{ provider: "ANTHROPIC_DIRECT" }]),
		},
		userCloudProviderConfig: { findFirst: vi.fn() },
		organizationModelPreference: {
			deleteMany: mockOrgDeleteMany,
			findMany: vi.fn(async () => []),
		},
		userModelPreference: { deleteMany: mockUserDeleteMany },
		$transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
			transactionState.active = true;
			try {
				return await cb({
					$queryRaw: vi.fn(async () => []),
					cloudProviderConfig: {
						updateMany: txUpdateMany,
						findFirst: async (...args: unknown[]) => {
							if (
								(
									args[0] as {
										where: {
											isEmbeddingProvider?: boolean;
										};
									}
								).where.isEmbeddingProvider
							) {
								return transactionState.documentsProvider
									? {
											provider:
												transactionState.documentsProvider,
											enabled: true,
											encryptedApiKey: "example-key",
											config: {},
										}
									: null;
							}
							const row =
								await mockDb.cloudProviderConfig.findFirst(
									...args,
								);
							return row
								? {
										...row,
										enabled: true,
										encryptedApiKey: "example-key",
									}
								: null;
						},
					},
					organizationModelPreference:
						mockDb.organizationModelPreference,
					userCloudProviderConfig: {
						updateMany: txUpdateMany,
						findFirst: async (args: {
							where: { isEmbeddingProvider?: boolean };
						}) =>
							args.where.isEmbeddingProvider
								? transactionState.documentsProvider
									? {
											provider:
												transactionState.documentsProvider,
											enabled: true,
											encryptedApiKey: "example-key",
											config: {},
										}
									: null
								: mockDb.userCloudProviderConfig.findFirst(
										args,
									),
					},
					userModelPreference: mockDb.userModelPreference,
				});
			} finally {
				transactionState.active = false;
			}
		}),
	};
	return {
		transactionState,
		mockSystem: vi.fn(async () => ({
			provider: null as string | null,
			source: null as string | null,
			configId: null as string | null,
		})),
		mockEmbeddingDefault: vi.fn(async () => null as { id: string } | null),
		mockDb,
		mockSelector: vi.fn(),
		mockOrgDeleteMany,
		mockUserDeleteMany,
		mockGetEmbeddingProviderConfig: vi.fn(),
		mockRequireOrgMembership: vi.fn(),
		mockResolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

vi.mock("@repo/ai/model-selector", () => ({
	selectModelDynamic: mockSelector,
}));

vi.mock("@repo/database", async () => ({
	organizationDefaultProviderWhere: (
		await vi.importActual<
			typeof import("../../../../../../database/prisma/queries/ai-gateway")
		>("../../../../../../database/prisma/queries/ai-gateway")
	).organizationDefaultProviderWhere,
	readProviderRowCredentials: (
		await vi.importActual<
			typeof import("../../../../../../database/prisma/queries/ai-gateway")
		>("../../../../../../database/prisma/queries/ai-gateway")
	).readProviderRowCredentials,
	db: {
		...mockDb,
		cloudProviderConfig: {
			...mockDb.cloudProviderConfig,
			findFirst: async (args: any) => {
				if (args?.where?.isEmbeddingProvider) {
					return transactionState.documentsProvider
						? {
								provider: transactionState.documentsProvider,
								enabled: true,
								encryptedApiKey: "example-key",
								config: {},
							}
						: null;
				}
				const row = await mockDb.cloudProviderConfig.findFirst(args);
				return row
					? { ...row, enabled: true, encryptedApiKey: "example-key" }
					: null;
			},
		},
		userCloudProviderConfig: {
			...mockDb.userCloudProviderConfig,
			findFirst: async (args: any) =>
				args?.where?.isEmbeddingProvider
					? transactionState.documentsProvider
						? {
								provider: transactionState.documentsProvider,
								enabled: true,
								encryptedApiKey: "example-key",
								config: {},
							}
						: null
					: mockDb.userCloudProviderConfig.findFirst(args),
		},
	},
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	getOrganizationDefaultProvider: async () =>
		(await mockDb.cloudProviderConfig.findFirst())?.provider ?? null,
	getAiProviderApiKeyByProvider: async ({
		provider,
	}: {
		provider: string;
	}) => ({ provider, source: "organization" }),
	getSystemAiProviderApiKey: mockSystem,
	getTaskDefaultModelUncached: mockEmbeddingDefault,
	lockTenantProviderConnections: (
		await import(
			"../../../../../../database/prisma/queries/provider-write-locks"
		)
	).lockTenantProviderConnections,
	taskDefaultsSnapshotMutation: vi.fn(async () => ({})),
	getEmbeddingProviderConfig: (...args: unknown[]) =>
		mockGetEmbeddingProviderConfig(...args),
	// Named imports used by sibling procedures in the module (unused here, but
	// must resolve since we import the whole module for side effects).
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
	getProviderDisplayName: vi.fn((p: string) => p),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) =>
		mockRequireOrgMembership(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_input: (chainable as { _input?: unknown })._input,
		}),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			mockResolveOrganizationId(organizationId),
		requirePermission: vi.fn(() => ({})),
		// Used at module-eval time by sibling procedures in upsert.ts (e.g.
		// getProviderConfigProcedure) that this side-effect import evaluates. The
		// mocked `.use()` ignores its argument, so a no-op factory suffices.
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Side-effect import registers the handler on the exported procedure object.
import { setDefaultProviderProcedure } from "../upsert";

type SetDefaultResult = { success: boolean; preferencesCleared: number };
const setDefault = setDefaultProviderProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<SetDefaultResult>;
};

const orgContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};
const personalContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: null },
};

function setDocumentsProvider(provider: string | null) {
	transactionState.documentsProvider = provider;
	mockGetEmbeddingProviderConfig.mockResolvedValue({ provider });
}

describe("setDefaultProviderProcedure — embeddings preservation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		mockOrgDeleteMany.mockResolvedValue({ count: 4 });
		mockUserDeleteMany.mockResolvedValue({ count: 2 });
		setDocumentsProvider(null);
	});

	describe("organization context", () => {
		it("preserves EMBEDDING when a distinct documents provider governs it", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			setDocumentsProvider("OPENAI_DIRECT");

			const res = await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: "org-1",
			});
			expect(mockOrgDeleteMany).toHaveBeenCalledTimes(1);
			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
				taskType: {
					notIn: ["DECISION", "IMAGE", "AUDIO", "EMBEDDING"],
				},
				// The ChatGPT plan's model choices are not tied to the default.
				provider: { not: "OPENAI_CHATGPT_PLAN" },
			});
			expect(res.preferencesCleared).toBe(4);
		});

		it("preserves EMBEDDING when the documents provider is the new default", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			setDocumentsProvider("ANTHROPIC_DIRECT");

			await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
				taskType: {
					notIn: ["DECISION", "IMAGE", "AUDIO", "EMBEDDING"],
				},
				// The ChatGPT plan's model choices are not tied to the default.
				provider: { not: "OPENAI_CHATGPT_PLAN" },
			});
		});

		it("clears EMBEDDING when no documents provider is configured", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			setDocumentsProvider(null);

			await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
				taskType: { notIn: ["DECISION", "IMAGE", "AUDIO"] },
				// The ChatGPT plan's model choices are not tied to the default.
				provider: { not: "OPENAI_CHATGPT_PLAN" },
			});
		});

		it("does not clear anything when the provider is unchanged", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "ANTHROPIC_DIRECT",
			});

			const res = await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany).not.toHaveBeenCalled();
			expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: "org-1",
			});
			expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledTimes(2);
			expect(res.preferencesCleared).toBe(0);
		});

		it("preserves a DECISION preference, so a switched-off decision model stays off", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "OPENAI_DIRECT",
			});
			setDocumentsProvider(null);

			await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany).toHaveBeenCalledTimes(1);
			const where = mockOrgDeleteMany.mock.calls[0][0].where;
			expect(where.taskType.notIn).toContain("DECISION");
		});
	});

	describe("personal context", () => {
		it.each(["OPENAI_DIRECT", "ANTHROPIC_DIRECT"])(
			"preserves EMBEDDING with documents provider %s",
			async (documentsProvider) => {
				mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
					provider: "VERCEL_GATEWAY",
				});
				setDocumentsProvider(documentsProvider);

				const res = await setDefault._handler({
					input: {
						provider: "ANTHROPIC_DIRECT",
						organizationId: null,
					},
					context: personalContext,
				});

				expect(mockGetEmbeddingProviderConfig).not.toHaveBeenCalled();
				expect(mockUserDeleteMany).toHaveBeenCalledTimes(1);
				expect(mockUserDeleteMany.mock.calls[0][0].where).toEqual({
					userId: "user-1",
					taskType: { not: "EMBEDDING" },
				});
				expect(res.preferencesCleared).toBe(2);
			},
		);

		it("clears EMBEDDING when no documents provider is configured", async () => {
			mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			setDocumentsProvider(null);

			await setDefault._handler({
				input: { provider: "ANTHROPIC_DIRECT", organizationId: null },
				context: personalContext,
			});

			expect(mockUserDeleteMany.mock.calls[0][0].where).toEqual({
				userId: "user-1",
			});
		});

		it("keeps saved choices when there is no current default to replace", async () => {
			// First read is the target row, second the current default.
			mockDb.userCloudProviderConfig.findFirst.mockImplementation(
				async ({ where }) =>
					where.provider ? { provider: "ANTHROPIC_DIRECT" } : null,
			);
			setDocumentsProvider(null);

			await setDefault._handler({
				input: { provider: "ANTHROPIC_DIRECT", organizationId: null },
				context: personalContext,
			});

			expect(mockUserDeleteMany).not.toHaveBeenCalled();
		});
	});
});

// A global-client lookup inside the transaction would hold a second pool slot.
it.each([orgContext, personalContext])(
	"keeps global embedding-provider reads outside the default transaction (%j)",
	async (context) => {
		mockGetEmbeddingProviderConfig.mockClear();
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
		});
		setDocumentsProvider("OPENAI_DIRECT");
		mockGetEmbeddingProviderConfig.mockImplementation(async () => {
			expect(transactionState.active).toBe(false);
			return { provider: "OPENAI_DIRECT" };
		});
		await setDefault._handler({
			input: {
				provider: "ANTHROPIC_DIRECT",
				organizationId: context.session.activeOrganizationId,
			},
			context,
		});
		expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledTimes(
			context.session.activeOrganizationId ? 2 : 0,
		);
	},
);
describe("gateway choices on an organization default switch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
	});
	// Removing IMAGE from preservedTaskTypes must delete the seeded IMAGE row.
	it.each([null, "ANTHROPIC_DIRECT", "OPENAI_DIRECT"])(
		"keeps gateway choices and conditionally embeddings with documents provider %s",
		async (documentsProvider) => {
			const tasks = [
				"SIMPLE",
				"COMPLEX",
				"REASONING",
				"CHAT",
				"TOOL_CALLING",
				"EVAL",
				"IMAGE",
				"DECISION",
				"AUDIO",
				"EMBEDDING",
			];
			let remaining = [...tasks];
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			setDocumentsProvider(documentsProvider);
			mockOrgDeleteMany.mockImplementation(async ({ where }) => {
				remaining = remaining.filter((task) =>
					where.taskType.notIn.includes(task),
				);
				return { count: tasks.length - remaining.length };
			});
			await setDefault._handler({
				input: {
					organizationId: "example-org",
					provider: "ANTHROPIC_DIRECT",
				},
				context: orgContext,
			});
			expect(remaining).toEqual(
				documentsProvider !== null
					? ["IMAGE", "DECISION", "AUDIO", "EMBEDDING"]
					: ["IMAGE", "DECISION", "AUDIO"],
			);
		},
	);
});

it.each(["organization", "user"] as const)(
	"pins the outgoing %s row under lock before deletion and audits the pin",
	async (scope) => {
		vi.clearAllMocks();
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		setDocumentsProvider(null);
		const organizationId = scope === "organization" ? "example-org" : null;
		const owner = organizationId
			? { organizationId }
			: { userId: "example-user" };
		const outgoing = {
			id: "example-outgoing",
			provider: "OPENAI_DIRECT",
			isDefault: true,
			isEmbeddingProvider: false,
			enabled: true,
			encryptedApiKey: "example-key",
			clientId: null,
			encryptedClientSecret: null,
			config: {},
			purpose: "ALL",
		};
		const target = {
			...outgoing,
			id: "example-target",
			provider: "ANTHROPIC_DIRECT",
			isDefault: false,
		};
		mockDb.cloudProviderConfig.findFirst.mockResolvedValue(outgoing);
		mockDb.userCloudProviderConfig.findFirst.mockResolvedValue(outgoing);
		mockSystem.mockResolvedValue({
			...outgoing,
			configId: outgoing.id,
			source: scope,
		});
		mockEmbeddingDefault.mockResolvedValue({ id: "example-embedding" });
		mockSelector.mockResolvedValue({
			modelId: "example-embedding",
			canonicalName: "example-embedding",
			displayName: "Example embedding",
		});
		const events: string[] = [];
		let remaining = ["CHAT", "EMBEDDING"];
		const updateMany = vi.fn(async ({ where, data }) => {
			expect(events[0]).toBe("lock");
			if (data.isEmbeddingProvider) {
				expect(where).toMatchObject({ ...owner, id: outgoing.id });
				outgoing.isEmbeddingProvider = true;
				events.push("pin");
			}
			return { count: 1 };
		});
		const findFirst = vi.fn(async ({ where }) =>
			where.isEmbeddingProvider
				? null
				: where.provider
					? target
					: outgoing,
		);
		const deleteMany = vi.fn(async ({ where }) => {
			expect(events).toContain("pin");
			events.push("delete");
			remaining = remaining.filter(
				(task) =>
					where.taskType?.notIn?.includes(task) ||
					where.taskType?.not === task,
			);
			return { count: 2 - remaining.length };
		});
		mockDb.$transaction.mockImplementationOnce(async (cb) =>
			cb({
				$queryRaw: async () => {
					events.push("lock");
					return [];
				},
				cloudProviderConfig: { findFirst, updateMany },
				userCloudProviderConfig: { findFirst, updateMany },
				organizationModelPreference: { deleteMany },
				userModelPreference: { deleteMany },
			}),
		);
		const context = {
			user: { id: "example-user" },
			session: { activeOrganizationId: organizationId },
		};
		await setDefault._handler({
			input: { organizationId, provider: "ANTHROPIC_DIRECT" },
			context,
		});
		expect(remaining).toEqual(["EMBEDDING"]);
		expect(events).toEqual(["lock", "pin", "delete"]);
		const { recordAuditFromRequest } = await import(
			"../../../../../lib/audit"
		);
		expect(recordAuditFromRequest).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: `${scope === "organization" ? "org" : "account"}.ai_provider.embedding_changed`,
				resource: {
					type: "ai_provider",
					id: "example-outgoing",
					name: "OPENAI_DIRECT",
				},
				metadata: expect.objectContaining({
					before: { isEmbeddingProvider: false },
					after: { isEmbeddingProvider: true },
					reason: "pinned_by_default_switch",
				}),
			}),
		);
	},
);

it.each(["organization", "user"] as const)(
	"resolves the outgoing %s embedding model outside the transaction",
	async (scope) => {
		vi.clearAllMocks();
		mockOrgDeleteMany.mockResolvedValue({ count: 1 });
		mockUserDeleteMany.mockResolvedValue({ count: 1 });
		setDocumentsProvider(null);
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		const outgoing = {
			id: "example-outgoing",
			provider: "OPENAI_DIRECT",
			isDefault: true,
			isEmbeddingProvider: false,
			enabled: true,
			encryptedApiKey: "example-key",
			clientId: null,
			encryptedClientSecret: null,
			config: {},
			purpose: "ALL",
		};
		const target = {
			...outgoing,
			id: "example-target",
			provider: "ANTHROPIC_DIRECT",
			isDefault: false,
		};
		for (const table of [
			mockDb.cloudProviderConfig,
			mockDb.userCloudProviderConfig,
		]) {
			table.findFirst.mockImplementation(async (args) =>
				args?.where?.isEmbeddingProvider
					? null
					: args?.where?.provider
						? target
						: outgoing,
			);
		}
		mockSystem.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			source: scope,
			configId: outgoing.id,
		});
		const activeStates: boolean[] = [];
		mockSelector.mockImplementation(async () => {
			activeStates.push(transactionState.active);
			return {
				modelId: "example-embedding",
				canonicalName: "example-embedding",
				displayName: "Example embedding",
			};
		});
		const organizationId = scope === "organization" ? "example-org" : null;
		await setDefault._handler({
			input: { organizationId, provider: "ANTHROPIC_DIRECT" },
			context: {
				user: { id: "example-user" },
				session: { activeOrganizationId: organizationId },
			},
		});
		expect(activeStates.length).toBeGreaterThan(0);
		expect(activeStates).not.toContain(true);
		expect(mockSelector).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "EMBEDDING",
				preferredProvider: "OPENAI_DIRECT",
				ignorePreferences: false,
			}),
			expect.objectContaining({ userId: "example-user" }),
		);
	},
);
