/**
 * Restoring a deleted meeting from the 7-day recovery window (Fizzy #2355).
 *
 * The property that matters most here is WHERE the recycle bin lives. It used
 * to be nested inside the branch that renders the linked-meetings list, so
 * deleting the LAST meeting in a project flipped `hasLinkedMeetings` to false,
 * swapped in the empty state, and took the only route back with it — the
 * archive was still there, still inside its window, and completely unreachable.
 * The one case where recovery matters most was the one case it was missing.
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
const listDeletedMeetingsMock = vi.fn();
const restoreMeetingMock = vi.fn();

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
				listDeletedMeetings: (...a: unknown[]) =>
					listDeletedMeetingsMock(...a),
				restoreMeeting: (...a: unknown[]) => restoreMeetingMock(...a),
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

const archive = {
	id: "arch_1",
	subject: "Weekly sync",
	transcriptCount: 12,
	deletedAt: new Date().toISOString(),
	scheduledPurgeAt: new Date(Date.now() + 6 * 864e5).toISOString(),
	payloadTruncated: false,
	deletedByName: "Test User",
	deletedByYou: true,
};

describe("MeetingTranscriptSyncSettings — restore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listTranscriptsMock.mockResolvedValue([]);
		enableMock.mockResolvedValue({});
		disableMock.mockResolvedValue({});
		setAutoAnalyzeMock.mockResolvedValue({});
		triggerSyncMock.mockResolvedValue({});
		unlinkMeetingMock.mockResolvedValue({});
		setMeetingSyncActiveMock.mockResolvedValue({ success: true });
		listDeletedMeetingsMock.mockResolvedValue([archive]);
		restoreMeetingMock.mockResolvedValue({
			success: true,
			transcriptsRestored: 12,
			reindexing: 12,
		});
	});

	it("offers the way back after the LAST meeting is deleted", async () => {
		// Nothing linked any more — the empty state renders. The archive is
		// still inside its window, so the recycle bin has to survive that
		// switch or the deletion is effectively permanent.
		listLinkedMeetingsMock.mockResolvedValue([]);
		renderSettings();

		expect(
			await screen.findByText("No meetings linked to this project"),
		).toBeInTheDocument();

		expect(await screen.findByText("Recently deleted")).toBeInTheDocument();
		expect(
			await screen.findByRole("button", { name: /Restore/ }),
		).toBeInTheDocument();
	});

	it("restores from the empty state, not just alongside a populated list", async () => {
		listLinkedMeetingsMock.mockResolvedValue([]);
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: /Restore/ }),
		);

		await waitFor(() => {
			expect(restoreMeetingMock).toHaveBeenCalledTimes(1);
		});
		expect(restoreMeetingMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: null,
				archiveId: "arch_1",
			}),
		);
	});

	it("still shows the bin next to a populated list", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		renderSettings();

		expect(await screen.findByText("Recently deleted")).toBeInTheDocument();

		// The subject appears twice on purpose — once as the live meeting, once
		// as the archived one. Asserting a single match would be asserting that
		// the bin is absent.
		expect(await screen.findAllByText("Weekly sync")).toHaveLength(2);
	});

	it("stays hidden from someone who cannot manage context sources", async () => {
		listLinkedMeetingsMock.mockResolvedValue([]);
		renderSettings({ canEdit: false });

		await screen.findByText("No meetings linked to this project");

		expect(screen.queryByText("Recently deleted")).not.toBeInTheDocument();
	});

	it("shows nothing when the window holds no archives", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		listDeletedMeetingsMock.mockResolvedValue([]);
		renderSettings();

		await screen.findByText("Weekly sync");

		// A recycle bin that is always on screen is permanent chrome, not a
		// recovery affordance.
		expect(screen.queryByText("Recently deleted")).not.toBeInTheDocument();
	});
});
