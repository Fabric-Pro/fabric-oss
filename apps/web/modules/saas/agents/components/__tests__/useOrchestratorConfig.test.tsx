import { sessionQueryKey } from "@saas/auth/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import type { Action, ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
const notifications = vi.hoisted(() => ({
	error: vi.fn(
		(_message: string, _options?: ExternalToast) => "example-sync-error",
	),
	dismiss: vi.fn(),
	warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: notifications }));
const registry = vi.hoisted(() => ({ agents: [] as unknown[] }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: { orchestratorPreferences: mocks },
		mcp: {
			configs: {
				list: async () => [{ id: "example-mcp", enabled: true }],
			},
		},
		workflows: {
			integrations: {
				list: async () => ({
					integrations: [
						{
							id: "example-integration",
							isActive: true,
							hasCredentials: true,
						},
					],
				}),
			},
		},
		agents: { registry: { list: async () => registry } },
	},
}));
vi.mock("@saas/mcp/components/McpLogo", () => ({ McpLogo: () => null }));
vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

import {
	getOrganizationStorageKey,
	ORGANIZATION_STORAGE_KEYS,
	STORAGE_KEYS,
	showSyncError,
	showSyncSuccess,
} from "../../hooks/useAgentConfigPersistence";
import { resetOrchestratorPreferenceSaveQueueForTests } from "../../lib/orchestrator-preference-save-queue";
import { useOrchestratorConfig } from "../OrchestratorConfigPanel";

const orgAgentKey =
	"fabric-orchestrator-enabled-agents:example-user:example-org";

const systemAgentIds = [
	"project_document_generator",
	"document_generator",
	"task_planner",
	"story_breakdown",
	"code_executor",
	"prompt_enhancer",
	"api_agent",
	"data_analyst",
	"cuga_generalist",
	"mcp_tool_executor",
];

beforeEach(() => {
	resetOrchestratorPreferenceSaveQueueForTests();
	vi.useFakeTimers();
	vi.clearAllMocks();
	localStorage.clear();
	registry.agents = [];
	mocks.update.mockResolvedValue({});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function mountConfig(
	agentIds: string[],
	cached = true,
	organizationId: string | null = "example-org",
	userId: string | null = "example-user",
) {
	const preferences = {
		exists: true,
		enabledAgentIds: agentIds,
		enabledMcpConfigIds: [
			"example-mcp",
			"oauth:integration:example-integration",
		],
		enabledWorkspaceIds: ["example-workspace"],
	};
	mocks.get.mockResolvedValue(preferences);
	const client = new QueryClient({
		// Preserve new response references so refetches exercise the hook effects.
		defaultOptions: { queries: { retry: false, structuralSharing: false } },
	});
	client.setQueryData(
		sessionQueryKey,
		userId ? { user: { id: userId } } : null,
	);
	// FabricAIClient seeds this same query with the SSR page's initialData.
	if (cached) {
		client.setQueryData(
			["orchestrator-preferences", organizationId ?? null],
			preferences,
		);
	}
	const hook = renderHook(
		({ org, user } = { org: organizationId, user: userId }) =>
			useOrchestratorConfig(org ?? undefined, user ?? undefined),
		{
			initialProps: { org: organizationId, user: userId },
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>
					{children}
				</QueryClientProvider>
			),
		},
	);
	return { ...hook, client };
}

async function settleLoad() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000);
	});
}

describe("saved orchestrator agent preferences", () => {
	// Depends on including the URL organization in the preference read.
	it("reads preferences for the page organization", async () => {
		mountConfig([], false, "example-org-b");
		await settleLoad();
		expect(mocks.get).toHaveBeenCalledWith({
			organizationId: "example-org-b",
		});
	});

	// Depends on checking for a pending batch before mutating in the flush.
	it("does not flush when unmounting without pending edits", async () => {
		const { unmount } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		unmount();
		await settleLoad();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	// Depends on flushing the captured organization batch during effect cleanup.
	it("flushes a pending save on unmount for its scheduled organization", async () => {
		const { result, unmount } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		act(() => result.current.handleDisableAllAgents());
		unmount();
		await act(async () => {
			await Promise.resolve();
		});
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			organizationId: "example-org",
			enabledAgentIds: [],
		});
	});

	// Depends on capturing the organization in mutation input so delayed retries retain it.
	it("keeps a delayed save and its retries on org A after rerendering with org B", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const preferences = {
			exists: true,
			enabledAgentIds: ["example-agent"],
			enabledMcpConfigIds: [],
			enabledWorkspaceIds: [],
		};
		client.setQueryData(sessionQueryKey, { user: { id: "example-user" } });
		for (const org of ["example-org-a", "example-org-b"]) {
			client.setQueryData(["orchestrator-preferences", org], preferences);
		}
		const { result, rerender } = renderHook(
			({ org }) => useOrchestratorConfig(org, "example-user"),
			{
				initialProps: { org: "example-org-a" },
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>
						{children}
					</QueryClientProvider>
				),
			},
		);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValueOnce(
			new Error("Example transient failure"),
		);
		act(() => result.current.handleDisableAllAgents());
		rerender({ org: "example-org-b" });
		await settleLoad();
		await settleLoad();
		expect(mocks.update).toHaveBeenCalledTimes(2);
		for (const [input] of mocks.update.mock.calls) {
			expect(input).toEqual({
				organizationId: "example-org-a",
				enabledAgentIds: [],
			});
		}
	});

	// Depends on organizationId in the flush effect dependencies: flush A before B can merge into it.
	it("flushes separate organization batches before a new edit inside the debounce window", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(sessionQueryKey, { user: { id: "example-user" } });
		const preferences = {
			exists: true,
			enabledAgentIds: ["example-agent"],
			enabledMcpConfigIds: [],
			enabledWorkspaceIds: [],
		};
		for (const org of ["example-org-a", "example-org-b"]) {
			client.setQueryData(["orchestrator-preferences", org], preferences);
		}
		const { result, rerender } = renderHook(
			({ org }) => useOrchestratorConfig(org, "example-user"),
			{
				initialProps: { org: "example-org-a" },
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>
						{children}
					</QueryClientProvider>
				),
			},
		);
		await settleLoad();
		mocks.update.mockClear();
		act(() => result.current.handleDisableAllAgents());
		rerender({ org: "example-org-b" });
		act(() =>
			result.current.handleWorkspaceToggle("example-workspace-b", true),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(mocks.update.mock.calls).toEqual([
			[{ organizationId: "example-org-a", enabledAgentIds: [] }],
			[
				{
					organizationId: "example-org-b",
					enabledWorkspaceIds: ["example-workspace-b"],
				},
			],
		]);
	});

	// Depends on capturing the scheduled user and checking the live session cache during flush.
	it.each([null, { user: { id: "example-other-user" } }])(
		"drops a pending unmount save after the session user changes to %s",
		async (session) => {
			const { result, client, unmount } = mountConfig([]);
			await settleLoad();
			mocks.update.mockClear();
			act(() => result.current.handleDisableAllAgents());
			client.setQueryData(sessionQueryKey, session);
			unmount();
			await settleLoad();
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it("isolates cached agents across organizations and seeds active A2A defaults", async () => {
		const orgA = mountConfig([], true, "example-org-a");
		await settleLoad();
		act(() => orgA.result.current.handleDisableAllAgents());
		act(() =>
			orgA.result.current.handleAgentToggle("example-org-a-agent", true),
		);
		await settleLoad();
		orgA.unmount();
		registry.agents = [
			{
				agentId: "example-org-b-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
			{
				agentId: "example-paused-agent",
				framework: "A2A",
				status: "PAUSED",
			},
		];
		const orgB = mountConfig([], true, "example-org-b");
		await settleLoad();
		expect(orgB.result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-org-b-agent",
		]);
	});

	it("ignores and removes legacy unscoped agents before seeding defaults", async () => {
		localStorage.setItem(
			STORAGE_KEYS.AGENTS,
			JSON.stringify(["example-legacy-agent"]),
		);
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-a2a-agent",
		]);
		expect(localStorage.getItem(STORAGE_KEYS.AGENTS)).toBeNull();
	});

	it.each([
		["organization", null, "example-user"],
		["user", "example-org", null],
	] as const)(
		"does not read or write organization caches without a resolved %s",
		async (_missing, organizationId, userId) => {
			for (const key of ORGANIZATION_STORAGE_KEYS) {
				localStorage.setItem(
					key,
					JSON.stringify(["example-legacy-id"]),
				);
				localStorage.setItem(
					`${key}:example-user:example-org`,
					JSON.stringify(["example-org-id"]),
				);
			}
			const reads = vi.spyOn(Storage.prototype, "getItem");
			const writes = vi.spyOn(Storage.prototype, "setItem");
			try {
				const { result } = mountConfig(
					[],
					true,
					organizationId,
					userId,
				);
				await settleLoad();
				expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
				expect(result.current.enabledWorkspaceIds).not.toContain(
					"example-org-id",
				);
				expect(result.current.prioritizedAgentIds).toEqual([]);
				act(() => {
					result.current.handleAgentToggle("example-new-agent", true);
					result.current.handleMcpToggle("example-mcp", true);
					result.current.handleWorkspaceToggle(
						"example-workspace",
						true,
					);
					result.current.handleIntegrationToggle(
						"example-integration",
						true,
					);
					result.current.handleAgentPrioritize(
						"example-new-agent",
						true,
					);
					result.current.handleMcpPrioritize("example-mcp", true);
					result.current.handleIntegrationPrioritize(
						"example-integration",
						true,
					);
				});
				await settleLoad();
				act(() => result.current.handleClearAllPrioritized());
				const orgCalls = [
					...reads.mock.calls,
					...writes.mock.calls,
				].filter(([key]) =>
					ORGANIZATION_STORAGE_KEYS.some(
						(base) => key === base || key.startsWith(`${base}:`),
					),
				);
				expect(orgCalls).toEqual([]);
			} finally {
				reads.mockRestore();
				writes.mockRestore();
			}
		},
	);

	it("cleans up all legacy organization keys while preserving global tools", async () => {
		for (const key of ORGANIZATION_STORAGE_KEYS) {
			localStorage.setItem(key, "[]");
		}
		localStorage.setItem(
			STORAGE_KEYS.PRIORITIZED_TOOLS,
			'["fabric_pattern"]',
		);
		const { result } = mountConfig([]);
		await settleLoad();
		for (const key of ORGANIZATION_STORAGE_KEYS) {
			expect(localStorage.getItem(key)).toBeNull();
		}
		expect(result.current.prioritizedToolIds).toEqual(["fabric_pattern"]);
	});

	it("continues with scoped defaults when legacy cleanup throws", async () => {
		const remove = vi
			.spyOn(Storage.prototype, "removeItem")
			.mockImplementation(() => {
				throw new Error("Storage unavailable");
			});
		try {
			const { result } = mountConfig([]);
			await settleLoad();
			expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		} finally {
			remove.mockRestore();
		}
	});

	it("persists all organization selections only in the current organization's keys", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		act(() => {
			result.current.handleDisableAllAgents();
			result.current.handleDisableAllMcp();
			result.current.handleDisableAllWorkspaces();
			result.current.handleDisableAllIntegrations();
			result.current.handleAgentPrioritize("example-agent", true);
			result.current.handleMcpPrioritize("example-mcp", true);
			result.current.handleIntegrationPrioritize(
				"example-integration",
				true,
			);
		});
		await settleLoad();
		const expected = [
			[],
			[],
			[],
			[],
			["example-agent"],
			["example-mcp"],
			["example-integration"],
		];
		ORGANIZATION_STORAGE_KEYS.forEach((base, index) => {
			expect(
				localStorage.getItem(`${base}:example-user:example-org`),
			).toBe(JSON.stringify(expected[index]));
			expect(localStorage.getItem(base)).toBeNull();
		});
	});

	it.each([null, undefined])(
		"returns no scoped key for an unresolved organization (%s)",
		(organizationId) => {
			expect(
				getOrganizationStorageKey(
					STORAGE_KEYS.AGENTS,
					organizationId,
					"example-user",
				),
			).toBeNull();
		},
	);

	it("reloads selections and seeding refs when the owner key changes organizations", async () => {
		const preferences = {
			exists: true,
			enabledAgentIds: [],
			enabledMcpConfigIds: [],
			enabledWorkspaceIds: [],
		};
		mocks.get.mockResolvedValue(preferences);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		function Owner({ organizationId }: { organizationId?: string }) {
			const config = useOrchestratorConfig(
				organizationId,
				"example-user",
			);
			return (
				<button
					type="button"
					onClick={() => {
						config.handleDisableAllAgents();
						config.handleAgentToggle("example-org-a-agent", true);
					}}
				>
					{JSON.stringify(config.enabledAgentIds)}
				</button>
			);
		}
		const owner = (organizationId?: string) => (
			<QueryClientProvider client={client}>
				<Owner
					key={organizationId ?? "no-organization"}
					organizationId={organizationId}
				/>
			</QueryClientProvider>
		);
		const view = render(owner("example-org-a"));
		await settleLoad();
		fireEvent.click(screen.getByRole("button"));
		await settleLoad();
		expect(screen.getByRole("button").textContent).toBe(
			JSON.stringify(["example-org-a-agent"]),
		);
		view.rerender(owner());
		await settleLoad();
		expect(screen.getByRole("button").textContent).toBe(
			JSON.stringify(systemAgentIds),
		);
		registry.agents = [
			{
				agentId: "example-org-b-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		view.rerender(owner("example-org-b"));
		await settleLoad();
		expect(screen.getByRole("button").textContent).toBe(
			JSON.stringify([...systemAgentIds, "example-org-b-agent"]),
		);
	});

	it("isolates cached agents between users in the same organization", async () => {
		const first = mountConfig([], true, "example-org", "example-user-x");
		await settleLoad();
		act(() => {
			first.result.current.handleDisableAllAgents();
			first.result.current.handleAgentToggle(
				"example-user-x-agent",
				true,
			);
		});
		await settleLoad();
		first.unmount();
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const second = mountConfig([], true, "example-org", "example-user-y");
		await settleLoad();
		expect(second.result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-a2a-agent",
		]);
	});

	it.each([
		["organization", null, "example-user"],
		["user", "example-org", null],
	] as const)(
		"does not fetch preferences without a resolved %s",
		async (_missing, organizationId, userId) => {
			mountConfig([], false, organizationId, userId);
			await settleLoad();
			expect(mocks.get).not.toHaveBeenCalled();
		},
	);

	it.each([
		["organization", null, "example-user"],
		["user", "example-org", null],
	] as const)(
		"does not debounce preference saves without a resolved %s",
		async (_missing, organizationId, userId) => {
			const { result } = mountConfig([], false, organizationId, userId);
			await settleLoad();
			act(() => result.current.handleDisableAllAgents());
			await settleLoad();
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it.each([
		["organization", null, "example-user"],
		["user", "example-org", null],
	] as const)(
		"does not retry preference saves without a resolved %s",
		async (_missing, organizationId, userId) => {
			const { result } = mountConfig([], false, organizationId, userId);
			await settleLoad();
			act(() => result.current.retrySyncNow());
			await settleLoad();
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it.each([null, undefined])(
		"returns no scoped key for an unresolved user (%s)",
		(userId) => {
			expect(
				getOrganizationStorageKey(
					STORAGE_KEYS.AGENTS,
					"example-org",
					userId,
				),
			).toBeNull();
		},
	);

	it("saves Enable All intent while the first preferences fetch is pending", async () => {
		let resolvePreferences!: (value: object) => void;
		mocks.get.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePreferences = resolve;
			}),
		);
		const { result } = mountConfig([], false);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		act(() => result.current.handleEnableAllAgents());
		act(() => {
			resolvePreferences({
				exists: true,
				enabledAgentIds: ["task_planner"],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ enabledAgentIds: systemAgentIds }),
		);
	});

	it("saves off-then-on intent while the first preferences fetch is pending", async () => {
		let resolvePreferences!: (value: object) => void;
		mocks.get.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePreferences = resolve;
			}),
		);
		const { result } = mountConfig([], false);
		await settleLoad();
		act(() => {
			result.current.handleAgentToggle("mcp_tool_executor", false);
			result.current.handleAgentToggle("mcp_tool_executor", true);
		});
		act(() => {
			resolvePreferences({
				exists: true,
				enabledAgentIds: ["task_planner"],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ enabledAgentIds: systemAgentIds }),
		);
	});

	it("saves a user subset over a different first preferences response", async () => {
		let resolvePreferences!: (value: object) => void;
		mocks.get.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePreferences = resolve;
			}),
		);
		const { result } = mountConfig([], false);
		await settleLoad();
		act(() => result.current.handleAgentToggle("mcp_tool_executor", false));
		act(() => {
			resolvePreferences({
				exists: true,
				enabledAgentIds: ["task_planner"],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			});
		});
		await settleLoad();
		const userAgentIds = systemAgentIds.slice(0, -1);
		expect(result.current.enabledAgentIds).toEqual(userAgentIds);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ enabledAgentIds: userAgentIds }),
		);
	});

	it("applies the first pending saved subset without saving agents when unedited", async () => {
		let resolvePreferences!: (value: object) => void;
		mocks.get.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePreferences = resolve;
			}),
		);
		const { result } = mountConfig([], false);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		act(() => {
			resolvePreferences({
				exists: true,
				enabledAgentIds: ["task_planner"],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["task_planner"]);
		for (const [preferences] of mocks.update.mock.calls) {
			expect(preferences).not.toHaveProperty("enabledAgentIds");
		}
	});

	it.each([true, false])(
		"keeps system defaults with an empty DB agent list (cached: %s)",
		async (cached) => {
			const { result, rerender } = mountConfig([], cached);
			await settleLoad();
			rerender();
			await settleLoad();
			expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
			expect(result.current.enabledMcpConfigIds).toEqual(["example-mcp"]);
			expect(result.current.enabledIntegrationIds).toEqual([
				"example-integration",
			]);
			expect(result.current.enabledWorkspaceIds).toEqual([
				"example-workspace",
			]);
			expect(localStorage.getItem(orgAgentKey)).toBeNull();
			expect(mocks.update).not.toHaveBeenCalled();
			for (const [preferences] of mocks.update.mock.calls) {
				expect(preferences).not.toHaveProperty("enabledAgentIds");
			}
		},
	);

	it.each([true, false])(
		"adds active registered A2A agents with an empty DB agent list (cached: %s)",
		async (cached) => {
			registry.agents = [
				{
					agentId: "example-a2a-agent",
					framework: "A2A",
					status: "ACTIVE",
				},
				{
					agentId: "example-paused-agent",
					framework: "A2A",
					status: "PAUSED",
				},
			];
			const { result, rerender } = mountConfig([], cached);
			await settleLoad();
			rerender();
			await settleLoad();
			expect(result.current.enabledAgentIds).toEqual([
				...systemAgentIds,
				"example-a2a-agent",
			]);
			for (const [preferences] of mocks.update.mock.calls) {
				expect(preferences).not.toHaveProperty("enabledAgentIds");
			}
		},
	);

	it("does not add registered A2A agents over a saved agent list", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result, rerender } = mountConfig(["example-db-agent"]);
		await settleLoad();
		rerender();
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["example-db-agent"]);
	});

	it("keeps localStorage agents with an empty DB agent list", async () => {
		localStorage.setItem(
			orgAgentKey,
			JSON.stringify(["example-local-agent"]),
		);
		const { result } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["example-local-agent"]);
		expect(localStorage.getItem(orgAgentKey)).toBe(
			JSON.stringify(["example-local-agent"]),
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("applies a non-empty DB agent list over localStorage", async () => {
		localStorage.setItem(
			orgAgentKey,
			JSON.stringify(["example-local-agent"]),
		);
		const { result } = mountConfig(["example-db-agent"]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["example-db-agent"]);
		expect(localStorage.getItem(orgAgentKey)).toBe(
			JSON.stringify(["example-db-agent"]),
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("keeps Disable all agents effective for the current session", async () => {
		const { result, rerender } = mountConfig([]);
		await settleLoad();
		rerender();
		await settleLoad();
		act(() => result.current.handleDisableAllAgents());
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([]);
		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "example-org",
			enabledAgentIds: [],
		});
	});

	it("keeps all agents disabled after a registry refetch", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result, client } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-a2a-agent",
		]);
		mocks.update.mockClear();
		act(() => result.current.handleDisableAllAgents());
		await settleLoad();
		act(() => {
			client.setQueryData(["agents", "registry", "list", "example-org"], {
				agents: registry.agents.map((agent) => ({
					...(agent as object),
				})),
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([]);
		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "example-org",
			enabledAgentIds: [],
		});
		for (const [preferences] of mocks.update.mock.calls) {
			if (preferences.enabledAgentIds) {
				expect(preferences.enabledAgentIds).toEqual([]);
			}
		}
	});

	it("keeps an unticked A2A agent off after a registry refetch", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result, client } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toContain("example-a2a-agent");
		mocks.update.mockClear();
		act(() => result.current.handleAgentToggle("example-a2a-agent", false));
		await settleLoad();
		act(() => {
			client.setQueryData(["agents", "registry", "list", "example-org"], {
				agents: registry.agents.map((agent) => ({
					...(agent as object),
				})),
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "example-org",
			enabledAgentIds: systemAgentIds,
		});
		for (const [preferences] of mocks.update.mock.calls) {
			expect(preferences.enabledAgentIds ?? []).not.toContain(
				"example-a2a-agent",
			);
		}
	});

	it("seeds active A2A and system agents when localStorage holds an empty list", async () => {
		localStorage.setItem(orgAgentKey, "[]");
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-a2a-agent",
		]);
	});

	it("waits for preferences before deciding whether to seed", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		let resolvePreferences!: (value: object) => void;
		mocks.get.mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePreferences = resolve;
			}),
		);
		const { result } = mountConfig([], false);
		await settleLoad();
		expect(result.current.enabledAgentIds).not.toContain(
			"example-a2a-agent",
		);
		act(() => {
			resolvePreferences({
				exists: true,
				enabledAgentIds: ["example-db-agent"],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["example-db-agent"]);
		for (const [preferences] of mocks.update.mock.calls) {
			expect(preferences).not.toHaveProperty("enabledAgentIds");
		}
	});

	it("keeps user choices across preferences refetches, including a later non-empty DB list", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		const { result, client } = mountConfig([]);
		await settleLoad();
		act(() => result.current.handleDisableAllAgents());
		await settleLoad();
		act(() => {
			client.setQueryData(["orchestrator-preferences", "example-org"], {
				...client.getQueryData<object>([
					"orchestrator-preferences",
					"example-org",
				]),
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([]);
		mocks.update.mockClear();
		act(() => {
			client.setQueryData(["orchestrator-preferences", "example-org"], {
				...client.getQueryData<object>([
					"orchestrator-preferences",
					"example-org",
				]),
				enabledAgentIds: ["example-db-agent"],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual([]);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("accepts a later non-empty DB list when the user has not edited agents", async () => {
		const { result, client } = mountConfig([]);
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(systemAgentIds);
		act(() => {
			client.setQueryData(["orchestrator-preferences", "example-org"], {
				...client.getQueryData<object>([
					"orchestrator-preferences",
					"example-org",
				]),
				enabledAgentIds: ["example-db-agent"],
			});
		});
		await settleLoad();
		expect(result.current.enabledAgentIds).toEqual(["example-db-agent"]);
		for (const [preferences] of mocks.update.mock.calls) {
			expect(preferences).not.toHaveProperty("enabledAgentIds");
		}
	});

	it("seeds after the preferences fetch exhausts retries without saving the defaults", async () => {
		registry.agents = [
			{
				agentId: "example-a2a-agent",
				framework: "A2A",
				status: "ACTIVE",
			},
		];
		for (let attempt = 0; attempt < 3; attempt++) {
			mocks.get.mockRejectedValueOnce(
				new Error("Example connection failure"),
			);
		}
		const { result } = mountConfig([], false);
		for (let elapsed = 0; elapsed < 5; elapsed++) {
			await settleLoad();
		}
		expect(mocks.get).toHaveBeenCalledTimes(3);
		expect(result.current.enabledAgentIds).toEqual([
			...systemAgentIds,
			"example-a2a-agent",
		]);
		for (const [preferences] of mocks.update.mock.calls) {
			expect(preferences).not.toHaveProperty("enabledAgentIds");
		}
	});
});

describe("failed orchestrator preference recovery", () => {
	beforeEach(() => {
		showSyncSuccess();
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	async function advance(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	function clickRetry(options?: ExternalToast) {
		expect(options?.action).toMatchObject({
			label: "Retry",
			onClick: expect.any(Function),
		});
		const event = { preventDefault: vi.fn() };
		(options?.action as Action).onClick(
			event as unknown as MouseEvent<HTMLButtonElement>,
		);
		return event;
	}

	async function failAgentsSave() {
		const hook = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValue(new Error("Example save failure"));
		act(() => hook.result.current.handleDisableAllAgents());
		await advance(7500);
		expect(mocks.update).toHaveBeenCalledTimes(4);
		expect(hook.result.current.syncStatus).toBe("error");
		mocks.update.mockResolvedValue({});
		return hook;
	}

	it.each(["Retry", "online"])(
		"re-sends only the failed fields on %s",
		async (trigger) => {
			const { result } = await failAgentsSave();
			mocks.update.mockClear();
			await act(async () => {
				if (trigger === "Retry") {
					const options = notifications.error.mock.calls.at(-1)?.[1];
					clickRetry(options);
				} else {
					window.dispatchEvent(new Event("online"));
				}
			});
			expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
				organizationId: "example-org",
				enabledAgentIds: [],
			});
			expect(result.current.syncStatus).toBe("success");
			expect(notifications.dismiss).toHaveBeenCalledWith(
				"example-sync-error",
			);
		},
	);

	it("includes failed agents with the next workspaces edit", async () => {
		const { result } = await failAgentsSave();
		mocks.update.mockClear();
		act(() => result.current.handleDisableAllWorkspaces());
		await advance(500);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			organizationId: "example-org",
			enabledAgentIds: [],
			enabledWorkspaceIds: [],
		});
	});

	it("retries the merged MCP and integration list without saving seeded agents", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValue(new Error("Example save failure"));
		act(() => result.current.handleDisableAllMcp());
		await advance(7500);
		expect(mocks.update).toHaveBeenCalledTimes(4);
		mocks.update.mockClear();
		mocks.update.mockResolvedValue({});
		act(() => result.current.retrySyncNow());
		await advance(0);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			organizationId: "example-org",
			enabledMcpConfigIds: ["oauth:integration:example-integration"],
		});
	});

	it("serializes overlapping saves and writes the newest value last", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		let finishFirst!: () => void;
		const writes: unknown[] = [];
		mocks.update
			.mockImplementationOnce(async (input) => {
				await new Promise<void>((resolve) => {
					finishFirst = resolve;
				});
				writes.push(input);
			})
			.mockImplementation(async (input) => {
				writes.push(input);
			});
		act(() => result.current.handleDisableAllAgents());
		await advance(500);
		act(() => result.current.handleAgentToggle("example-agent", true));
		await advance(500);
		expect(mocks.update).toHaveBeenCalledTimes(1);
		await act(async () => {
			finishFirst();
		});
		await advance(0);
		expect(writes).toEqual([
			{ organizationId: "example-org", enabledAgentIds: [] },
			{
				organizationId: "example-org",
				enabledAgentIds: ["example-agent"],
			},
		]);
		expect(result.current.syncStatus).toBe("success");
	});

	it("skips a superseded field during retry backoff", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValueOnce(
			new Error("Example transient failure"),
		);
		act(() => result.current.handleDisableAllAgents());
		await advance(500);
		act(() => result.current.handleAgentToggle("example-agent", true));
		await advance(1000);
		expect(mocks.update.mock.calls).toEqual([
			[{ organizationId: "example-org", enabledAgentIds: [] }],
			[
				{
					organizationId: "example-org",
					enabledAgentIds: ["example-agent"],
				},
			],
		]);
	});

	it.each(["success", "failure"])(
		"flushes a captured unmount batch after the running save's %s",
		async (outcome) => {
			const { result, unmount } = mountConfig([], true, "example-org-a");
			await settleLoad();
			mocks.update.mockClear();
			let settleFirst!: () => void;
			mocks.update.mockImplementationOnce(
				() =>
					new Promise<void>((resolve, reject) => {
						settleFirst = () =>
							outcome === "success"
								? resolve()
								: reject(new Error("Example failure"));
					}),
			);
			if (outcome === "failure") {
				for (let retry = 0; retry < 3; retry++) {
					mocks.update.mockRejectedValueOnce(
						new Error("Example failure"),
					);
				}
			}
			act(() => result.current.handleDisableAllAgents());
			await advance(500);
			act(() => result.current.handleDisableAllWorkspaces());
			unmount();
			await act(async () => {
				await Promise.resolve();
			});
			expect(mocks.update).toHaveBeenCalledTimes(1);
			await act(async () => {
				settleFirst();
			});
			await advance(7000);
			expect(mocks.update).toHaveBeenLastCalledWith({
				organizationId: "example-org-a",
				...(outcome === "failure" ? { enabledAgentIds: [] } : {}),
				enabledWorkspaceIds: [],
			});
		},
	);

	it("does not dismiss an error when a successful send still has pending edits", async () => {
		const { result } = await failAgentsSave();
		let finish!: () => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		act(() => result.current.retrySyncNow());
		await advance(0);
		act(() => result.current.handleDisableAllWorkspaces());
		await act(async () => {
			finish();
		});
		expect(result.current.syncStatus).not.toBe("success");
		expect(notifications.dismiss).not.toHaveBeenCalled();
		await advance(500);
		expect(result.current.syncStatus).toBe("success");
		expect(notifications.dismiss).toHaveBeenCalledWith(
			"example-sync-error",
		);
	});

	it("retries unsuperseded fields while leaving newer fields for the next send", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValueOnce(
			new Error("Example transient failure"),
		);
		act(() => {
			result.current.handleDisableAllAgents();
			result.current.handleDisableAllWorkspaces();
		});
		await advance(500);
		act(() => result.current.handleAgentToggle("example-agent", true));
		await advance(1000);
		expect(mocks.update.mock.calls).toEqual([
			[
				{
					organizationId: "example-org",
					enabledAgentIds: [],
					enabledWorkspaceIds: [],
				},
			],
			[{ organizationId: "example-org", enabledWorkspaceIds: [] }],
			[
				{
					organizationId: "example-org",
					enabledAgentIds: ["example-agent"],
				},
			],
		]);
	});

	it("requeues failed fields without overwriting a newer pending value", async () => {
		const { result } = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValue(new Error("Example save failure"));
		act(() => result.current.handleDisableAllAgents());
		await advance(3500);
		let rejectLast!: (error: Error) => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectLast = reject;
				}),
		);
		await advance(4000);
		act(() => result.current.handleAgentToggle("example-agent", true));
		await act(async () => {
			rejectLast(new Error("Example last failure"));
		});
		mocks.update.mockResolvedValue({});
		act(() => result.current.retrySyncNow());
		await advance(0);
		expect(mocks.update).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			enabledAgentIds: ["example-agent"],
		});
	});

	it("does not clear the error notice when a retry is entirely superseded", async () => {
		const { result } = await failAgentsSave();
		let finishNewest!: () => void;
		mocks.update.mockRejectedValueOnce(
			new Error("Example transient failure"),
		);
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishNewest = resolve;
				}),
		);
		act(() => result.current.retrySyncNow());
		await advance(0);
		act(() => result.current.handleAgentToggle("example-agent", true));
		await advance(1000);
		expect(result.current.syncStatus).not.toBe("success");
		expect(notifications.dismiss).not.toHaveBeenCalled();
		await act(async () => {
			finishNewest();
		});
		expect(result.current.syncStatus).toBe("success");
		expect(notifications.dismiss).toHaveBeenCalledWith(
			"example-sync-error",
		);
	});

	it.each(["organization", "user"])(
		"keeps failed fields separate from another %s's pending batch",
		async (changed) => {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			client.setQueryData(sessionQueryKey, {
				user: { id: "example-user" },
			});
			for (const org of ["example-org", "example-org-b"]) {
				client.setQueryData(["orchestrator-preferences", org], {
					exists: true,
					enabledAgentIds: [],
					enabledMcpConfigIds: [],
					enabledWorkspaceIds: [],
				});
			}
			const { result, rerender } = renderHook(
				({ org, user }) => useOrchestratorConfig(org, user),
				{
					initialProps: { org: "example-org", user: "example-user" },
					wrapper: ({ children }: { children: ReactNode }) => (
						<QueryClientProvider client={client}>
							{children}
						</QueryClientProvider>
					),
				},
			);
			await settleLoad();
			mocks.update.mockClear();
			mocks.update.mockRejectedValue(new Error("Example save failure"));
			act(() => result.current.handleDisableAllAgents());
			await advance(3500);
			let rejectLast!: (error: Error) => void;
			mocks.update.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectLast = reject;
					}),
			);
			await advance(4000);
			const org =
				changed === "organization" ? "example-org-b" : "example-org";
			const user = changed === "user" ? "example-user-b" : "example-user";
			client.setQueryData(sessionQueryKey, { user: { id: user } });
			rerender({ org, user });
			act(() =>
				result.current.handleWorkspaceToggle(
					"example-workspace-b",
					true,
				),
			);
			await act(async () => {
				rejectLast(new Error("Example last failure"));
			});
			mocks.update.mockResolvedValue({});
			act(() => result.current.retrySyncNow());
			await advance(0);
			expect(mocks.update).toHaveBeenLastCalledWith({
				organizationId: org,
				enabledWorkspaceIds: ["example-workspace-b"],
			});
		},
	);

	it("shares backoff across instances so an old retry cannot follow a newer save", async () => {
		const first = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValueOnce(new Error("Example failure"));
		act(() => first.result.current.handleDisableAllAgents());
		await advance(500);
		first.unmount();
		const second = mountConfig([]);
		await advance(50);
		act(() =>
			second.result.current.handleAgentToggle("example-new-agent", true),
		);
		await advance(1500);
		expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
			{ organizationId: "example-org", enabledAgentIds: [] },
			{
				organizationId: "example-org",
				enabledAgentIds: ["example-new-agent"],
			},
		]);
		expect(second.result.current.syncStatus).toBe("success");
	});

	it("keeps pending org A fields on org A during an in-flight organization change", async () => {
		const hook = mountConfig([], true, "example-org-a");
		await settleLoad();
		hook.client.setQueryData(
			["orchestrator-preferences", "example-org-b"],
			{
				exists: true,
				enabledAgentIds: [],
				enabledMcpConfigIds: [],
				enabledWorkspaceIds: [],
			},
		);
		mocks.update.mockClear();
		let finish!: () => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		act(() => hook.result.current.handleDisableAllAgents());
		await advance(500);
		act(() => hook.result.current.handleDisableAllWorkspaces());
		hook.rerender({ org: "example-org-b", user: "example-user" });
		act(() => hook.result.current.handleDisableAllMcp());
		await advance(500);
		await act(async () => {
			finish();
		});
		await advance(0);
		expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
			{ organizationId: "example-org-a", enabledAgentIds: [] },
			{
				organizationId: "example-org-b",
				enabledMcpConfigIds: ["oauth:integration:example-integration"],
			},
			{ organizationId: "example-org-a", enabledWorkspaceIds: [] },
		]);
	});

	it("flushes the live key when a leftover toast Retry is clicked after remount", async () => {
		const first = await failAgentsSave();
		const options = notifications.error.mock.calls.at(-1)?.[1];
		mocks.update.mockRejectedValue(new Error("Example failure"));
		first.unmount();
		await advance(7000);
		mocks.update.mockResolvedValue({});
		const second = mountConfig([]);
		await advance(50);
		act(() =>
			second.result.current.handleAgentToggle("example-new-agent", true),
		);
		await advance(500);
		expect(mocks.update).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			enabledAgentIds: ["example-new-agent"],
		});
		mocks.update.mockClear();
		await act(async () => {
			clickRetry(options);
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("reports a terminal drop on session mismatch without offering Retry", async () => {
		const hook = mountConfig([]);
		await settleLoad();
		mocks.update.mockClear();
		mocks.update.mockRejectedValueOnce(new Error("Example failure"));
		act(() => hook.result.current.handleDisableAllAgents());
		await advance(500);
		hook.client.setQueryData(sessionQueryKey, {
			user: { id: "example-other-user" },
		});
		await advance(1000);
		expect(hook.result.current.syncStatus).toBe("idle");
		expect(hook.result.current.isSyncing).toBe(false);
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(notifications.error).not.toHaveBeenCalled();
	});

	async function failAndUnmount(hook: ReturnType<typeof mountConfig>) {
		await advance(7500);
		expect(hook.result.current.syncStatus).toBe("error");
		expect(mocks.update).toHaveBeenCalledTimes(4);
		hook.unmount();
		// Cleanup requests another flush; let it fail so the remount starts with pending fields.
		await advance(7000);
		mocks.update.mockClear();
		notifications.dismiss.mockClear();
	}

	it.each([
		[true, "mcp", false],
		[false, "mcp", false],
		[true, "integration", false],
		[false, "integration", false],
		[true, "both", false],
		[false, "both", false],
		[true, "mcp", true],
		[false, "mcp", true],
	] as const)(
		"hydrates unsent MCP/integration choices on remount (cached: %s, disabled: %s, clear storage: %s)",
		async (cached, disabled, clearStorage) => {
			const first = mountConfig([]);
			await settleLoad();
			mocks.update.mockClear();
			mocks.update.mockRejectedValue(new Error("Example save failure"));
			act(() => {
				if (disabled !== "integration") {
					first.result.current.handleDisableAllMcp();
				}
				if (disabled !== "mcp") {
					first.result.current.handleDisableAllIntegrations();
				}
			});
			await failAndUnmount(first);
			if (clearStorage) {
				localStorage.clear();
			}
			const second = mountConfig([], cached);
			await settleLoad();
			expect
				.soft(second.result.current.enabledMcpConfigIds)
				.toEqual(disabled === "integration" ? ["example-mcp"] : []);
			expect
				.soft(second.result.current.enabledIntegrationIds)
				.toEqual(disabled === "mcp" ? ["example-integration"] : []);
			expect
				.soft(
					JSON.parse(
						localStorage.getItem(
							"fabric-orchestrator-enabled-mcp:example-user:example-org",
						) ?? "null",
					),
				)
				.toEqual(disabled === "integration" ? ["example-mcp"] : []);
			expect
				.soft(
					JSON.parse(
						localStorage.getItem(
							"fabric-orchestrator-enabled-integrations:example-user:example-org",
						) ?? "null",
					),
				)
				.toEqual(disabled === "mcp" ? ["example-integration"] : []);
			expect.soft(mocks.update).not.toHaveBeenCalled();
			expect.soft(notifications.dismiss).not.toHaveBeenCalled();
			mocks.update.mockResolvedValue({});
			await act(async () => {
				clickRetry(notifications.error.mock.calls.at(-1)?.[1]);
			});
			expect(mocks.update).toHaveBeenLastCalledWith({
				organizationId: "example-org",
				enabledMcpConfigIds:
					disabled === "mcp"
						? ["oauth:integration:example-integration"]
						: disabled === "integration"
							? ["example-mcp"]
							: [],
			});
			expect(notifications.dismiss).toHaveBeenCalledWith(
				"example-sync-error",
			);
		},
	);

	it.each([{ dbAgents: [] }, { dbAgents: ["example-db-agent"] }])(
		"hydrates unsent empty agent choices on remount over DB agents $dbAgents",
		async ({ dbAgents }) => {
			const first = mountConfig(dbAgents);
			await settleLoad();
			mocks.update.mockClear();
			mocks.update.mockRejectedValue(new Error("Example save failure"));
			act(() => first.result.current.handleDisableAllAgents());
			await failAndUnmount(first);
			const second = mountConfig(dbAgents);
			await settleLoad();
			expect.soft(second.result.current.enabledAgentIds).toEqual([]);
			expect.soft(localStorage.getItem(orgAgentKey)).toBe("[]");
			expect(mocks.update).not.toHaveBeenCalled();
			expect(notifications.dismiss).not.toHaveBeenCalled();
			mocks.update.mockResolvedValue({});
			await act(async () => {
				clickRetry(notifications.error.mock.calls.at(-1)?.[1]);
			});
			expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
				organizationId: "example-org",
				enabledAgentIds: [],
			});
		},
	);

	it("hydrates in-flight choices on remount without enqueueing the overlay", async () => {
		const first = mountConfig(["example-db-agent"]);
		await settleLoad();
		mocks.update.mockClear();
		let finish!: () => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		act(() => {
			first.result.current.handleDisableAllAgents();
			first.result.current.handleDisableAllMcp();
			first.result.current.handleDisableAllIntegrations();
			first.result.current.handleDisableAllWorkspaces();
		});
		await advance(500);
		first.unmount();
		const second = mountConfig(["example-db-agent"]);
		await settleLoad();
		expect.soft(second.result.current.enabledAgentIds).toEqual([]);
		expect.soft(second.result.current.enabledMcpConfigIds).toEqual([]);
		expect.soft(second.result.current.enabledIntegrationIds).toEqual([]);
		expect.soft(second.result.current.enabledWorkspaceIds).toEqual([]);
		await act(async () => {
			finish();
		});
		await advance(1000);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			organizationId: "example-org",
			enabledAgentIds: [],
			enabledMcpConfigIds: [],
			enabledWorkspaceIds: [],
		});
	});

	it("saves edits made while database hydration is finishing", async () => {
		const hook = mountConfig([]);
		act(() => {
			hook.result.current.handleDisableAllMcp();
			hook.result.current.handleDisableAllWorkspaces();
		});
		await settleLoad();
		await advance(500);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			organizationId: "example-org",
			enabledMcpConfigIds: ["oauth:integration:example-integration"],
			enabledWorkspaceIds: [],
		});
	});

	it("keeps the error toast open without a timeout", () => {
		showSyncError("Example error");
		expect(notifications.error.mock.lastCall?.[1]).toMatchObject({
			duration: Number.POSITIVE_INFINITY,
		});
	});

	it("wires toast Retry to the callback and keeps the error notice open", () => {
		const retry = vi.fn();
		showSyncError("Example error", "Example description", retry);
		const options = notifications.error.mock.calls.at(-1)?.[1];
		const event = clickRetry(options);
		expect(retry).toHaveBeenCalledOnce();
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(options).toMatchObject({ duration: Number.POSITIVE_INFINITY });
		expect(notifications.dismiss).not.toHaveBeenCalled();
	});
});
