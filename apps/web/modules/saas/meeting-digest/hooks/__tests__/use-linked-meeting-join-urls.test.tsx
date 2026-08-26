import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listLinkedMeetingsMock } = vi.hoisted(() => ({
	listLinkedMeetingsMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				listLinkedMeetings: listLinkedMeetingsMock,
			},
		},
	},
}));

import { useLinkedMeetingJoinUrls } from "../use-linked-meeting-join-urls";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useLinkedMeetingJoinUrls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the joinUrls of linked meetings", async () => {
		// listLinkedMeetings (packages/api/modules/projects/procedures/
		// meeting-transcript-sync/list-linked-meetings.ts) resolves the raw
		// db.projectLinkedMeeting.findMany() rows directly — an array, not a
		// `{ meetings: [...] }` envelope.
		listLinkedMeetingsMock.mockResolvedValue([
			{ id: "lm1", joinUrl: "https://teams/a" },
			{ id: "lm2", joinUrl: "https://teams/b" },
		]);
		const { result } = renderHook(
			() =>
				useLinkedMeetingJoinUrls({
					projectId: "p1",
					organizationId: "o1",
					enabled: true,
				}),
			{ wrapper },
		);
		await waitFor(() =>
			expect(result.current.joinUrls).toEqual([
				"https://teams/a",
				"https://teams/b",
			]),
		);

		const args = listLinkedMeetingsMock.mock.calls[0][0];
		expect(args).toEqual({ projectId: "p1", organizationId: "o1" });
	});

	it("does not fetch while disabled", async () => {
		const { result } = renderHook(
			() =>
				useLinkedMeetingJoinUrls({
					projectId: "p1",
					organizationId: "o1",
					enabled: false,
				}),
			{ wrapper },
		);
		expect(result.current.joinUrls).toEqual([]);
		expect(listLinkedMeetingsMock).not.toHaveBeenCalled();
	});
});
