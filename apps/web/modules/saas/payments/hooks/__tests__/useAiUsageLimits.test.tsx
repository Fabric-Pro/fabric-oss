/**
 * Unit tests for the `useAiUsageLimits` family of hooks. Mocks the
 * oRPC client at the boundary so the test exercises only the hook's
 * own caching / invalidation / toast behaviour.
 * Per `[testing/test-writing.md]` §"Unit Tests with Vitest" — focused
 * tests, mock at the boundary, AAA structure.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiUsageLimitsKeys,
	useAiUsageLimits,
	useAiUsageLimitsStatus,
	useDeleteAiUsageLimit,
	useUpsertAiUsageLimit,
} from "../useAiUsageLimits";

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("next-intl", () => ({
	// Hooks under test use `t("key")` for the toast copy. Echoing the
	// key back is enough to assert "the right key was looked up".
	useTranslations: () => (key: string) => key,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		payments: {
			aiUsageLimits: {
				list: vi.fn(),
				status: vi.fn(),
				upsert: vi.fn(),
				delete: vi.fn(),
			},
		},
	},
}));

function makeWrapper(): {
	wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
	queryClient: QueryClient;
} {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return { wrapper, queryClient };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("aiUsageLimitsKeys", () => {
	it("builds a stable namespaced key for the personal-context list", () => {
		expect(aiUsageLimitsKeys.list({ organizationId: null })).toEqual([
			"aiUsageLimits",
			"list",
			{ organizationId: null },
		]);
	});

	it("builds a stable namespaced key for the personal-context status", () => {
		expect(aiUsageLimitsKeys.status({ organizationId: null })).toEqual([
			"aiUsageLimits",
			"status",
			{ organizationId: null },
		]);
	});

	it("differentiates org-scoped keys from personal-context keys", () => {
		const personal = aiUsageLimitsKeys.list({ organizationId: null });
		const org = aiUsageLimitsKeys.list({ organizationId: "org-1" });
		expect(personal).not.toEqual(org);
	});
});

describe("useAiUsageLimits", () => {
	it("calls the list procedure with organizationId=null in personal context", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		vi.mocked(orpcClient.payments.aiUsageLimits.list).mockResolvedValueOnce(
			{
				limits: [],
				canManage: true,
			} as unknown as Awaited<
				ReturnType<typeof orpcClient.payments.aiUsageLimits.list>
			>,
		);

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useAiUsageLimits(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(orpcClient.payments.aiUsageLimits.list).toHaveBeenCalledWith({
			organizationId: null,
		});
	});

	it("forwards the organizationId for org-scoped calls", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		vi.mocked(orpcClient.payments.aiUsageLimits.list).mockResolvedValueOnce(
			{
				limits: [],
				canManage: false,
			} as unknown as Awaited<
				ReturnType<typeof orpcClient.payments.aiUsageLimits.list>
			>,
		);

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useAiUsageLimits("org-42"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(orpcClient.payments.aiUsageLimits.list).toHaveBeenCalledWith({
			organizationId: "org-42",
		});
	});
});

describe("useAiUsageLimitsStatus", () => {
	it("calls the status procedure and returns the result", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		vi.mocked(
			orpcClient.payments.aiUsageLimits.status,
		).mockResolvedValueOnce({
			statuses: [],
		} as unknown as Awaited<
			ReturnType<typeof orpcClient.payments.aiUsageLimits.status>
		>);

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useAiUsageLimitsStatus(), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(orpcClient.payments.aiUsageLimits.status).toHaveBeenCalledWith({
			organizationId: null,
		});
		expect(result.current.data).toEqual({ statuses: [] });
	});
});

describe("useUpsertAiUsageLimit", () => {
	it("invalidates the aiUsageLimits cache on success", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const { toast } = await import("sonner");
		const savedLimit = {
			id: "limit-1",
			organizationId: null,
			userId: "user-1",
			name: "test",
			providerConfigId: null,
			modelCanonicalName: null,
			taskType: null,
			dimension: "TOKENS",
			window: "DAILY",
			maxValue: "1000",
			enforcement: "HARD",
			createdById: "user-1",
			createdAt: new Date().toISOString(),
		};
		vi.mocked(
			orpcClient.payments.aiUsageLimits.upsert,
		).mockResolvedValueOnce({ limit: savedLimit } as unknown as Awaited<
			ReturnType<typeof orpcClient.payments.aiUsageLimits.upsert>
		>);

		const { wrapper, queryClient } = makeWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useUpsertAiUsageLimit(), {
			wrapper,
		});

		result.current.mutate({
			dimension: "TOKENS",
			window: "DAILY",
			maxValue: 1000,
			enforcement: "HARD",
		} as Parameters<typeof result.current.mutate>[0]);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: aiUsageLimitsKeys.all,
		});
		expect(toast.success).toHaveBeenCalledWith(
			"settings.aiUsage.limits.sheet.savedToast",
		);
	});

	it("falls back to the i18n error key when the mutation fails", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const { toast } = await import("sonner");
		vi.mocked(
			orpcClient.payments.aiUsageLimits.upsert,
		).mockRejectedValueOnce(new Error(""));

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useUpsertAiUsageLimit(), {
			wrapper,
		});

		result.current.mutate({
			dimension: "TOKENS",
			window: "DAILY",
			maxValue: 1000,
			enforcement: "HARD",
		} as Parameters<typeof result.current.mutate>[0]);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(toast.error).toHaveBeenCalledWith(
			"settings.aiUsage.limits.sheet.saveErrorToast",
		);
	});
});

describe("useDeleteAiUsageLimit", () => {
	it("removes the deleted row from cached list snapshots and invalidates", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const { toast } = await import("sonner");
		vi.mocked(
			orpcClient.payments.aiUsageLimits.delete,
		).mockResolvedValueOnce({ archived: true } as unknown as Awaited<
			ReturnType<typeof orpcClient.payments.aiUsageLimits.delete>
		>);

		const { wrapper, queryClient } = makeWrapper();
		const filters = { organizationId: null } as const;
		queryClient.setQueryData(aiUsageLimitsKeys.list(filters), {
			limits: [
				{ id: "limit-doomed" },
				{ id: "limit-survivor" },
			] as unknown as Awaited<
				ReturnType<typeof orpcClient.payments.aiUsageLimits.list>
			>["limits"],
			canManage: true,
		});

		// Spy on the cache mutator BEFORE the mutation runs so we can
		// inspect the optimistic patch that the hook applies. Reading
		// `getQueryData` after `invalidateQueries` would race with the
		// refetch and clobber the patched snapshot — the spy gives a
		// deterministic checkpoint for the in-flight cache update.
		const setQueriesDataSpy = vi.spyOn(queryClient, "setQueriesData");
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useDeleteAiUsageLimit(), {
			wrapper,
		});

		result.current.mutate({
			id: "limit-doomed",
			organizationId: null,
		} as Parameters<typeof result.current.mutate>[0]);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		// Inspect the updater function the hook handed to the cache and
		// run it against the seeded snapshot to assert the row was
		// filtered out.
		const updaterCall = setQueriesDataSpy.mock.calls.find((call) => {
			const filter = call[0] as { queryKey?: readonly unknown[] };
			return (
				Array.isArray(filter.queryKey) &&
				filter.queryKey[0] === "aiUsageLimits" &&
				filter.queryKey[1] === "list"
			);
		});
		expect(updaterCall).toBeDefined();
		const updater = updaterCall![1] as (
			prev: { limits: { id: string }[]; canManage: boolean } | undefined,
		) => { limits: { id: string }[]; canManage: boolean } | undefined;
		const patched = updater({
			limits: [{ id: "limit-doomed" }, { id: "limit-survivor" }],
			canManage: true,
		});
		expect(patched?.limits.map((l) => l.id)).toEqual(["limit-survivor"]);

		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: aiUsageLimitsKeys.all,
		});
		expect(toast.success).toHaveBeenCalledWith(
			"settings.aiUsage.limits.sheet.deletedToast",
		);
	});

	it("falls back to the i18n error key on failure", async () => {
		const { orpcClient } = await import("@shared/lib/orpc-client");
		const { toast } = await import("sonner");
		vi.mocked(
			orpcClient.payments.aiUsageLimits.delete,
		).mockRejectedValueOnce(new Error(""));

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useDeleteAiUsageLimit(), {
			wrapper,
		});

		result.current.mutate({
			id: "limit-1",
			organizationId: null,
		} as Parameters<typeof result.current.mutate>[0]);

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(toast.error).toHaveBeenCalledWith(
			"settings.aiUsage.limits.sheet.deleteErrorToast",
		);
	});
});
