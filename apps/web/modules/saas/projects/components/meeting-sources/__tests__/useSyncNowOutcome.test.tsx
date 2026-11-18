import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { syncNowStatusMock, toastMock } = vi.hoisted(() => ({
	syncNowStatusMock: vi.fn(),
	toastMock: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				syncNowStatus: (...a: unknown[]) => syncNowStatusMock(...a),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import { useSyncNowOutcome } from "../useSyncNowOutcome";

function setup() {
	const onFinished = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useSyncNowOutcome({
				projectId: "proj-1",
				organizationId: "org-1",
				onFinished,
			}),
		{ wrapper },
	);
	return { hook, onFinished };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("useSyncNowOutcome", () => {
	it("does not ask for a status until a run is watched", () => {
		const { hook } = setup();

		expect(hook.result.current.isSyncing).toBe(false);
		expect(syncNowStatusMock).not.toHaveBeenCalled();
	});

	it("reports how many transcripts a finished run stored", async () => {
		syncNowStatusMock.mockResolvedValue({
			state: "completed",
			newTranscripts: 20,
			failedMeetings: 0,
			message: null,
		});
		const { hook, onFinished } = setup();

		act(() => hook.result.current.watch("wf-1"));
		expect(hook.result.current.isSyncing).toBe(true);

		await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
		expect(syncNowStatusMock).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			workflowId: "wf-1",
		});
		expect(toastMock.success).toHaveBeenCalledWith(
			"Sync finished: 20 new transcripts",
		);
		expect(hook.result.current.isSyncing).toBe(false);
	});

	it("says so when a run found nothing new", async () => {
		syncNowStatusMock.mockResolvedValue({
			state: "completed",
			newTranscripts: 0,
			failedMeetings: 0,
			message: null,
		});
		const { hook, onFinished } = setup();

		act(() => hook.result.current.watch("wf-1"));

		await waitFor(() => expect(onFinished).toHaveBeenCalled());
		expect(toastMock.success).toHaveBeenCalledWith(
			"Sync finished: no new transcripts",
		);
	});

	it("shows why a run failed", async () => {
		syncNowStatusMock.mockResolvedValue({
			state: "failed",
			newTranscripts: 0,
			message:
				"Microsoft 365 did not respond (error 502), so nothing was synced. Try again later.",
		});
		const { hook, onFinished } = setup();

		act(() => hook.result.current.watch("wf-1"));

		await waitFor(() => expect(onFinished).toHaveBeenCalled());
		expect(toastMock.error).toHaveBeenCalledWith("Transcript sync failed", {
			description:
				"Microsoft 365 did not respond (error 502), so nothing was synced. Try again later.",
		});
	});

	it("warns when some meetings could not be read", async () => {
		syncNowStatusMock.mockResolvedValue({
			state: "completed",
			newTranscripts: 1,
			failedMeetings: 1,
			message: "Microsoft is not connected",
		});
		const { hook, onFinished } = setup();

		act(() => hook.result.current.watch("wf-1"));

		await waitFor(() => expect(onFinished).toHaveBeenCalled());
		expect(toastMock.warning).toHaveBeenCalledWith(
			"Sync finished with 1 new transcript, but some meetings could not be read",
			{ description: "Microsoft is not connected" },
		);
	});

	it("keeps watching while the run is in progress", async () => {
		syncNowStatusMock.mockResolvedValue({ state: "running" });
		const { hook, onFinished } = setup();

		act(() => hook.result.current.watch("wf-1"));

		await waitFor(() => expect(syncNowStatusMock).toHaveBeenCalled());
		expect(hook.result.current.isSyncing).toBe(true);
		expect(onFinished).not.toHaveBeenCalled();
	});
});
