import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	testConnections: vi.fn(),
	toast: { success: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		reports: { instances: { testConnections: mocks.testConnections } },
	},
}));

import { useReportConnectionTest } from "../use-report-connection-test";

let client = new QueryClient();
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const connected = {
	diagnostics: [
		{
			configId: "example-config",
			serverName: "Example server",
			outcome: "connected",
			toolCount: 3,
			readOnlyToolCount: 2,
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	mocks.testConnections.mockResolvedValue(connected);
});

describe("useReportConnectionTest", () => {
	it("tests once, quietly, when the page opens", async () => {
		const onError = vi.fn();
		const { result, rerender } = renderHook(
			() =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic: true,
					onError,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.data).toEqual(connected));
		rerender();
		expect(mocks.testConnections).toHaveBeenCalledTimes(1);
		expect(mocks.testConnections).toHaveBeenCalledWith({
			instanceId: "example-report",
			organizationId: "example-org",
		});
		expect(mocks.toast.success).not.toHaveBeenCalled();
	});

	it("does not test on its own while automatic testing is off", () => {
		renderHook(
			() =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic: false,
					onError: vi.fn(),
				}),
			{ wrapper },
		);
		expect(mocks.testConnections).not.toHaveBeenCalled();
	});

	it("reports a test the person starts", async () => {
		const { result } = renderHook(
			() =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic: false,
					onError: vi.fn(),
				}),
			{ wrapper },
		);
		act(() => result.current.test());
		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith(
				"All data sources connected",
			),
		);
	});

	it("does not start a second test while one is running", async () => {
		let finish: (value: typeof connected) => void = () => {};
		mocks.testConnections.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { result } = renderHook(
			() =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic: true,
					onError: vi.fn(),
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isPending).toBe(true));
		act(() => result.current.testBeforeRun());
		act(() => result.current.test());
		expect(mocks.testConnections).toHaveBeenCalledTimes(1);
		await act(async () => finish(connected));
	});

	it("still tests on open once a test the person started has finished", async () => {
		let finish: (value: typeof connected) => void = () => {};
		mocks.testConnections.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { result, rerender } = renderHook(
			({ automatic }: { automatic: boolean }) =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic,
					onError: vi.fn(),
				}),
			{ wrapper, initialProps: { automatic: false } },
		);
		act(() => result.current.test());
		await waitFor(() => expect(result.current.isPending).toBe(true));
		rerender({ automatic: true });
		expect(mocks.testConnections).toHaveBeenCalledTimes(1);
		await act(async () => finish(connected));
		await waitFor(() =>
			expect(mocks.testConnections).toHaveBeenCalledTimes(2),
		);
	});

	it("keeps a failed automatic test out of the error toast", async () => {
		mocks.testConnections.mockRejectedValue(new Error("unreachable"));
		const onError = vi.fn();
		const { result } = renderHook(
			() =>
				useReportConnectionTest({
					instanceId: "example-report",
					organizationId: "example-org",
					automatic: true,
					onError,
				}),
			{ wrapper },
		);
		await waitFor(() =>
			expect(mocks.testConnections).toHaveBeenCalledTimes(1),
		);
		await waitFor(() => expect(result.current.isPending).toBe(false));
		expect(onError).not.toHaveBeenCalled();
	});
});
