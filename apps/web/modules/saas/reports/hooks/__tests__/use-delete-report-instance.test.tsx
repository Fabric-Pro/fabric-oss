import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteReport: vi.fn(),
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
// Keys shaped as oRPC builds them: a partial input matches the full one.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			instances: {
				list: { key: () => ["reports", "instances", "list"] },
				get: {
					key: ({ input }: { input: { id: string } }) => [
						"reports",
						"instances",
						"get",
						{ input },
					],
				},
				delete: {
					mutationOptions: (options: object) => ({
						mutationFn: mocks.deleteReport,
						...options,
					}),
				},
			},
		},
	},
}));

import { useDeleteReportInstance } from "../use-delete-report-instance";

const REPORT = "example-report";
const reportPageKey = [
	"reports",
	"instances",
	"get",
	{ input: { id: REPORT, organizationId: "example-org" } },
];

let client = new QueryClient();
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function deleteReport(onDeleted = vi.fn()) {
	const { result } = renderHook(
		() => useDeleteReportInstance({ onDeleted }),
		{ wrapper },
	);
	act(() => {
		result.current.mutate({ id: REPORT, organizationId: "example-org" });
	});
	return { result, onDeleted };
}

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	mocks.deleteReport.mockResolvedValue({ success: true });
});

describe("useDeleteReportInstance", () => {
	it("drops the deleted report's cached page that no screen shows", async () => {
		client.setQueryData(reportPageKey, { id: REPORT, name: "Weekly" });

		const { result, onDeleted } = deleteReport();

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(onDeleted).toHaveBeenCalledTimes(1);
		expect(client.getQueryData(reportPageKey)).toBeUndefined();
	});

	it("keeps the page that deleted it until it closes, then drops it", async () => {
		const page = renderHook(
			() =>
				useQuery({
					queryKey: reportPageKey,
					queryFn: () => ({ id: REPORT, name: "Weekly" }),
				}),
			{ wrapper },
		);
		await waitFor(() => expect(page.result.current.data).toBeDefined());

		const { result } = deleteReport();
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(page.result.current.data).toBeDefined();
		page.unmount();
		expect(client.getQueryData(reportPageKey)).toBeUndefined();
	});

	it("drops the page too when the report was already gone", async () => {
		client.setQueryData(reportPageKey, { id: REPORT, name: "Weekly" });
		mocks.deleteReport.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);

		const { result, onDeleted } = deleteReport();

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(mocks.toast.info).toHaveBeenCalledTimes(1);
		expect(onDeleted).toHaveBeenCalledTimes(1);
		expect(client.getQueryData(reportPageKey)).toBeUndefined();
	});

	it("keeps the page when the deletion is refused", async () => {
		client.setQueryData(reportPageKey, { id: REPORT, name: "Weekly" });
		mocks.deleteReport.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);

		const { result, onDeleted } = deleteReport();

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(mocks.toast.error).toHaveBeenCalledTimes(1);
		expect(onDeleted).not.toHaveBeenCalled();
		expect(client.getQueryData(reportPageKey)).toEqual({
			id: REPORT,
			name: "Weekly",
		});
	});
});
