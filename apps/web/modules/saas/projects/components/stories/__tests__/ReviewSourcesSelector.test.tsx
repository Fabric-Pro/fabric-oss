import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mocks declared via vi.hoisted so the (hoisted) vi.mock factories can
// reference them.
const { listMeetingsMock, listContextsMock } = vi.hoisted(() => ({
	listMeetingsMock: vi.fn(),
	listContextsMock: vi.fn(),
}));

// `orpcClient` backs ChannelsSection's contexts.list AND the meetings hook's
// force-refresh path. The component imports it via a relative path; mocking the
// `@shared` alias here resolves to the same module (Vitest dedupes by resolved
// id) — the pre-existing test relied on this too.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: { listMeetings: listMeetingsMock },
			contexts: { list: listContextsMock },
		},
	},
}));

// The meetings dropdown now reads through TanStack Query via the orpc utils.
// Mock `queryOptions` to a real { queryKey, queryFn } whose queryFn calls the
// shared mock, so React Query drives loading/caching exactly as in production.
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

// Stub TeamsChatSelectorDialog — we only need to assert the CTA opens it.
vi.mock("../../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: (props: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}) =>
		props.open ? (
			<div data-testid="teams-chat-dialog">
				<button type="button" onClick={() => props.onOpenChange(false)}>
					close-dialog
				</button>
			</div>
		) : null,
}));

// Import after the mocks so it resolves to the mocked modules.
import { ReviewSourcesSelector } from "../ReviewSourcesSelector";

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
	listContextsMock.mockReset();
});

// Basic ResizeObserver + pointer mocks for Radix primitives under jsdom.
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

describe("ReviewSourcesSelector", () => {
	it("renders meetings + empty channel state when no contexts are linked", async () => {
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		listContextsMock.mockResolvedValue({ contexts: [] });

		renderWithClient(
			<ReviewSourcesSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByText(/No Teams channels or group chats/i),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("Meetings")).toBeInTheDocument();
	});

	it("opens the link dialog from the empty-state CTA and refetches on close", async () => {
		const user = userEvent.setup();
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		listContextsMock.mockResolvedValue({ contexts: [] });

		renderWithClient(
			<ReviewSourcesSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);

		// Wait for the empty-state CTA to actually render (ChannelsSection
		// finished its async load). Asserting on the rendered button via
		// findByRole is robust against the extra render passes the meetings
		// TanStack Query introduces — keying off the mock's call count raced the
		// channels fetch resolving and was flaky under the full CI suite.
		await user.click(
			await screen.findByRole("button", {
				name: /Link a channel or chat/i,
			}),
		);
		expect(
			await screen.findByTestId("teams-chat-dialog"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "close-dialog" }));
		await waitFor(() => expect(listContextsMock).toHaveBeenCalledTimes(2));
	});

	it("disables Confirm until at least one source is selected", async () => {
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		listContextsMock.mockResolvedValue({
			contexts: [
				{
					id: "ctx-1",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType: "channel",
						teamId: "t1",
						channelId: "c1",
						chatName: "Engineering",
						teamName: "Team A",
					},
				},
			],
		});

		const user = userEvent.setup();
		const onConfirm = vi.fn();

		renderWithClient(
			<ReviewSourcesSelector
				projectId="p1"
				organizationId={null}
				onConfirm={onConfirm}
				onCancel={noop}
			/>,
		);

		await waitFor(() =>
			expect(screen.getByText("Engineering")).toBeInTheDocument(),
		);

		const confirm = screen.getByRole("button", { name: /Confirm/i });
		expect(confirm).toBeDisabled();

		await user.click(screen.getByText("Engineering"));
		await waitFor(() => expect(confirm).toBeEnabled());

		await user.click(confirm);
		expect(onConfirm).toHaveBeenCalledWith({
			selectedMeetings: [],
			selectedChannels: [{ projectContextId: "ctx-1" }],
			daysBack: 30,
		});
	});

	it("Refresh re-fetches meetings with forceRefresh (bypassing caches)", async () => {
		const user = userEvent.setup();
		listMeetingsMock.mockResolvedValue({ meetings: [] });
		listContextsMock.mockResolvedValue({ contexts: [] });

		renderWithClient(
			<ReviewSourcesSelector
				projectId="p1"
				organizationId={null}
				onConfirm={noop}
				onCancel={noop}
			/>,
		);

		const refreshBtn = await screen.findByRole("button", {
			name: /Refresh meetings/i,
		});
		await user.click(refreshBtn);

		await waitFor(() =>
			expect(listMeetingsMock).toHaveBeenCalledWith(
				expect.objectContaining({ forceRefresh: true }),
			),
		);
	});

	it("renders grouped meetings and emits the selected joinUrl on Confirm", async () => {
		const user = userEvent.setup();
		listMeetingsMock.mockResolvedValue({
			meetings: [
				{
					id: "m1a",
					subject: "Standup",
					startTime: "2026-06-12T10:00:00Z",
					organizer: "Alice",
					joinUrl: "u-standup",
				},
				{
					id: "m1b",
					subject: "Standup",
					startTime: "2026-06-11T10:00:00Z",
					organizer: "Alice",
					joinUrl: "u-standup",
				},
				{
					id: "m2",
					subject: "Retro",
					startTime: "2026-06-10T10:00:00Z",
					organizer: "Nat",
					joinUrl: "u-retro",
				},
			],
		});
		listContextsMock.mockResolvedValue({ contexts: [] });
		const onConfirm = vi.fn();

		renderWithClient(
			<ReviewSourcesSelector
				projectId="p1"
				organizationId={null}
				onConfirm={onConfirm}
				onCancel={noop}
			/>,
		);

		// Both groups render; the two same-joinUrl instances collapse into one
		// recurring group labelled "2 dates".
		expect(await screen.findByText("Standup")).toBeInTheDocument();
		expect(screen.getByText("Retro")).toBeInTheDocument();
		expect(screen.getByText(/2 dates/i)).toBeInTheDocument();

		// Selecting the Standup group emits its joinUrl + latest instance startTime.
		await user.click(screen.getByText("Standup"));
		await user.click(
			await screen.findByRole("button", {
				name: /Confirm \(1 selected\)/i,
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith({
			selectedMeetings: [
				{ joinUrl: "u-standup", startTime: "2026-06-12T10:00:00Z" },
			],
			selectedChannels: [],
			daysBack: 30,
		});
	});
});
