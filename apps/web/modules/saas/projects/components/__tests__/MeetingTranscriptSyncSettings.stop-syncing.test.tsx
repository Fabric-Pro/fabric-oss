/**
 * "Stop syncing" — the non-destructive half of the unlink pair (Fizzy #2355).
 *
 * The point of this action is that it is NOT unlink: it stops future
 * occurrences arriving and keeps every transcript already captured. These tests
 * pin the three properties that make that true from the user's side — the
 * action exists, it never calls the destructive mutation, and a stopped meeting
 * says so and offers the way back. Plus the gate: someone who cannot manage
 * context sources gets no menu at all.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
	toastErrorMock: vi.fn(),
	toastSuccessMock: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, success: toastSuccessMock },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("next-intl", () => {
	function makeT() {
		const t = (key: string) => key;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: (args: { input: unknown }) => [
					"projects.get",
					args.input,
				],
			},
		},
	},
}));

const listLinkedMeetingsMock = vi.fn();
const listTranscriptsMock = vi.fn();
const enableMock = vi.fn();
const disableMock = vi.fn();
const setAutoAnalyzeMock = vi.fn();
const triggerSyncMock = vi.fn();
const unlinkMeetingMock = vi.fn();
const setMeetingSyncActiveMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				listLinkedMeetings: (...a: unknown[]) =>
					listLinkedMeetingsMock(...a),
				listTranscripts: (...a: unknown[]) => listTranscriptsMock(...a),
				enable: (...a: unknown[]) => enableMock(...a),
				disable: (...a: unknown[]) => disableMock(...a),
				setAutoAnalyze: (...a: unknown[]) => setAutoAnalyzeMock(...a),
				triggerSync: (...a: unknown[]) => triggerSyncMock(...a),
				unlinkMeeting: (...a: unknown[]) => unlinkMeetingMock(...a),
				setMeetingSyncActive: (...a: unknown[]) =>
					setMeetingSyncActiveMock(...a),
			},
		},
	},
}));

vi.mock("@saas/meetings/components", () => ({
	LinkedMeetingSelector: () => (
		<div data-testid="stub-linked-meeting-selector" />
	),
}));

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

import { MeetingTranscriptSyncSettings } from "../MeetingTranscriptSyncSettings";

const PROJECT_ID = "proj_1";

const syncingMeeting = {
	id: "linked_1",
	projectId: PROJECT_ID,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
	subject: "Weekly sync",
	organizer: "alice@example.com",
	linkedAt: new Date().toISOString(),
	deactivatedAt: null,
	userId: "user_1",
	organizationId: null,
	_count: { transcripts: 12 },
};

const stoppedMeeting = {
	...syncingMeeting,
	deactivatedAt: new Date().toISOString(),
};

function renderSettings({ canEdit = true }: { canEdit?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<MeetingTranscriptSyncSettings
				projectId={PROJECT_ID}
				organizationId={null}
				canEdit={canEdit}
				project={{ meetingTranscriptSyncEnabled: true }}
			/>
		</QueryClientProvider>,
	);
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
	const trigger = await screen.findByRole("button", {
		name: "Options for Weekly sync",
	});
	await user.click(trigger);
}

describe("MeetingTranscriptSyncSettings — stop syncing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listTranscriptsMock.mockResolvedValue([]);
		enableMock.mockResolvedValue({});
		disableMock.mockResolvedValue({});
		setAutoAnalyzeMock.mockResolvedValue({});
		triggerSyncMock.mockResolvedValue({});
		unlinkMeetingMock.mockResolvedValue({});
		setMeetingSyncActiveMock.mockResolvedValue({ success: true });
	});

	it("stops syncing without touching the destructive mutation", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		const user = userEvent.setup();
		renderSettings();

		await openRowMenu(user);
		await user.click(
			await screen.findByRole("menuitem", { name: /Stop syncing/ }),
		);

		await waitFor(() => {
			expect(setMeetingSyncActiveMock).toHaveBeenCalledTimes(1);
		});
		expect(setMeetingSyncActiveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: null,
				linkedMeetingId: "linked_1",
				active: false,
			}),
		);
		// The whole point of the action: nothing is deleted.
		expect(unlinkMeetingMock).not.toHaveBeenCalled();
	});

	it("tells the user what it keeps, by count", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		const user = userEvent.setup();
		renderSettings();

		await openRowMenu(user);

		expect(
			await screen.findByText("Keeps all 12 transcripts"),
		).toBeInTheDocument();
	});

	it("marks a stopped meeting and offers the way back", async () => {
		listLinkedMeetingsMock.mockResolvedValue([stoppedMeeting]);
		const user = userEvent.setup();
		renderSettings();

		// State is carried by a text label, not by the muted styling alone.
		expect(await screen.findByText("Not syncing")).toBeInTheDocument();

		await openRowMenu(user);
		await user.click(
			await screen.findByRole("menuitem", { name: /Resume syncing/ }),
		);

		await waitFor(() => {
			expect(setMeetingSyncActiveMock).toHaveBeenCalledWith(
				expect.objectContaining({
					linkedMeetingId: "linked_1",
					active: true,
				}),
			);
		});
	});

	it("hides the whole menu from someone who cannot manage context sources", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		renderSettings({ canEdit: false });

		// The meeting is still listed — read access is unaffected.
		expect(await screen.findByText("Weekly sync")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Options for Weekly sync" }),
		).not.toBeInTheDocument();
	});
});
