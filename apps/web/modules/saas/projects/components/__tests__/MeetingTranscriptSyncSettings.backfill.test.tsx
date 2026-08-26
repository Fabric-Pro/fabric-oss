/**
 * Backfill dropdown next to "Sync now" in MeetingTranscriptSyncSettings.
 *
 * The calendar lookback used to be pinned to 30 days (the tool ignored the
 * activity's daysBack arg), so meetings linked late lost history. The dropdown
 * exposes one-shot backfills that call
 * `orpcClient.projects.meetingTranscriptSync.triggerSync({ ..., daysBack })`.
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

// The component gates unlink behind the shared confirmation dialog (#1905) and
// is rendered here outside the app's provider tree.
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
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { MeetingTranscriptSyncSettings } from "../MeetingTranscriptSyncSettings";

const PROJECT_ID = "proj_1";

const linkedMeeting = {
	id: "linked_1",
	projectId: PROJECT_ID,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
	subject: "Weekly sync",
	organizer: "alice@example.com",
	linkedAt: new Date().toISOString(),
	userId: "user_1",
	organizationId: null,
	_count: { transcripts: 0 },
};

function renderSettings() {
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
				project={{
					meetingTranscriptSyncEnabled: true,
					meetingTranscriptAutoAnalyzeEnabled: false,
				}}
			/>
		</QueryClientProvider>,
	);
}

describe("MeetingTranscriptSyncSettings — backfill dropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listLinkedMeetingsMock.mockResolvedValue([linkedMeeting]);
		listTranscriptsMock.mockResolvedValue([]);
		triggerSyncMock.mockResolvedValue({});
	});

	it("triggers a 90-day backfill from the sync options dropdown", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: /sync options/i }),
		);
		await user.click(
			await screen.findByRole("menuitem", {
				name: /backfill last 90 days/i,
			}),
		);

		await waitFor(() => {
			expect(triggerSyncMock).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: PROJECT_ID,
					daysBack: 90,
				}),
			);
		});
	});

	it("plain Sync now sends no daysBack", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", {
				name: /sync transcripts now/i,
			}),
		);

		await waitFor(() => {
			expect(triggerSyncMock).toHaveBeenCalledTimes(1);
		});
		expect(triggerSyncMock).toHaveBeenCalledWith(
			expect.not.objectContaining({ daysBack: expect.anything() }),
		);
	});
});
