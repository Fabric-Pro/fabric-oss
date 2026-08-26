import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMeetingsMock } = vi.hoisted(() => ({ listMeetingsMock: vi.fn() }));

// Force-refresh path calls the raw client; the normal read goes through orpc utils.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { backlog: { listMeetings: listMeetingsMock } },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			backlog: {
				listMeetings: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.backlog.listMeetings", input],
						queryFn: () => listMeetingsMock(input),
					}),
				},
			},
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { MeetingSelector } from "../MeetingSelector";

const noop = () => undefined;

function renderWithClient(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMeetingsMock.mockReset();
});

// Radix/jsdom shims.
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

const ONE_MEETING = {
	meetings: [
		{
			id: "m1",
			subject: "Sprint Planning",
			startTime: "2026-06-11T10:00:00Z",
			organizer: "Alice",
			joinUrl: "u-sprint",
		},
	],
};

describe("MeetingSelector", () => {
	it("renders meetings and emits the selected joinUrl on Confirm", async () => {
		const user = userEvent.setup();
		listMeetingsMock.mockResolvedValue(ONE_MEETING);
		const onConfirm = vi.fn();

		renderWithClient(
			<MeetingSelector
				projectId="p1"
				organizationId={null}
				onConfirm={onConfirm}
				onCancel={noop}
			/>,
		);

		await user.click(await screen.findByText("Sprint Planning"));
		await user.click(
			await screen.findByRole("button", {
				name: /Confirm \(1 selected\)/i,
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith([
			{ joinUrl: "u-sprint", startTime: "2026-06-11T10:00:00Z" },
		]);
	});

	it("disables Confirm until a meeting is selected", async () => {
		listMeetingsMock.mockResolvedValue(ONE_MEETING);
		renderWithClient(
			<MeetingSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);
		const confirm = await screen.findByRole("button", {
			name: /Confirm \(0 selected\)/i,
		});
		expect(confirm).toBeDisabled();
	});

	it("shows the empty state when there are no meetings", async () => {
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		renderWithClient(
			<MeetingSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);
		expect(
			await screen.findByText(/No meetings with transcripts found/i),
		).toBeInTheDocument();
	});

	it("exposes a Refresh control that force-refreshes (bypassing caches)", async () => {
		const user = userEvent.setup();
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		renderWithClient(
			<MeetingSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);
		await user.click(
			await screen.findByRole("button", { name: /Refresh meetings/i }),
		);
		await waitFor(() =>
			expect(listMeetingsMock).toHaveBeenCalledWith(
				expect.objectContaining({ forceRefresh: true }),
			),
		);
	});
});
