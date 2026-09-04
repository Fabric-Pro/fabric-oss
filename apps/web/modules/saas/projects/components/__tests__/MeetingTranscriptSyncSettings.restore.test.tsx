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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
	toastErrorMock: vi.fn(),
	toastSuccessMock: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, success: toastSuccessMock },
}));

const confirmMock = vi.fn();
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
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
const repairSyncMock = vi.fn();

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
				repairSync: (...a: unknown[]) => repairSyncMock(...a),
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
		confirmMock.mockImplementation(
			async (opts: { onConfirm: () => Promise<void> }) =>
				await opts.onConfirm(),
		);
		repairSyncMock.mockImplementation(
			async (args: { preflightOnly: boolean }) =>
				args.preflightOnly
					? {
							mode: "preflight",
							totalMeetings: 1,
							reachableCount: 1,
							unreachableSubjects: [],
							currentlyBoundTo: "someone_else",
						}
					: { mode: "repaired", workflowStatus: "RUNNING" },
		);
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

describe("MeetingTranscriptSyncSettings — reconnect entry point", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listTranscriptsMock.mockResolvedValue([]);
		enableMock.mockResolvedValue({});
		disableMock.mockResolvedValue({});
		setAutoAnalyzeMock.mockResolvedValue({});
		triggerSyncMock.mockResolvedValue({});
		unlinkMeetingMock.mockResolvedValue({});
		setMeetingSyncActiveMock.mockResolvedValue({ success: true });
		listDeletedMeetingsMock.mockResolvedValue([]);
		confirmMock.mockImplementation(
			async (opts: { onConfirm: () => Promise<void> }) =>
				await opts.onConfirm(),
		);
		repairSyncMock.mockImplementation(
			async (args: { preflightOnly: boolean }) =>
				args.preflightOnly
					? {
							mode: "preflight",
							totalMeetings: 1,
							reachableCount: 1,
							unreachableSubjects: [],
							currentlyBoundTo: "someone_else",
						}
					: { mode: "repaired", workflowStatus: "RUNNING" },
		);
	});

	async function openSyncOptions(user: ReturnType<typeof userEvent.setup>) {
		await user.click(
			await screen.findByRole("button", { name: "Sync options" }),
		);
	}

	it("offers reconnect on a HEALTHY sync, not only a failing one", async () => {
		// The whole point. The failure counter only reflects what the app can
		// detect, and a token that still works but has lost access to some
		// meetings returns an empty list rather than an error — so the person
		// who suspects it needs a route that does not wait for the app to agree.
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		const user = userEvent.setup();
		renderSettings();

		// No failure anywhere: the banner is absent.
		expect(
			screen.queryByText(/meeting sync is not running/i),
		).not.toBeInTheDocument();

		await openSyncOptions(user);

		expect(
			await screen.findByRole("menuitem", {
				name: /Reconnect sync to me/,
			}),
		).toBeInTheDocument();
	});

	it("checks coverage before it rebinds anything", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		const user = userEvent.setup();
		renderSettings();

		await openSyncOptions(user);
		await user.click(
			await screen.findByRole("menuitem", {
				name: /Reconnect sync to me/,
			}),
		);

		// Preflight first, and it must be the read-only call.
		await waitFor(() => {
			expect(repairSyncMock).toHaveBeenCalledWith(
				expect.objectContaining({ preflightOnly: true }),
			);
		});
		expect(confirmMock).toHaveBeenCalled();
	});

	it("says why it cannot run when nothing is syncing", async () => {
		// The procedure refuses outright in this state; saying so beats
		// offering an action whose only outcome is an error toast.
		listLinkedMeetingsMock.mockResolvedValue([stoppedMeeting]);
		const user = userEvent.setup();
		renderSettings();

		await openSyncOptions(user);

		const item = await screen.findByRole("menuitem", {
			name: /Reconnect sync to me/,
		});
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(
			within(item).getByText("No meetings are syncing right now"),
		).toBeInTheDocument();
	});

	it("stays hidden from someone who cannot manage the sync", async () => {
		listLinkedMeetingsMock.mockResolvedValue([syncingMeeting]);
		const user = userEvent.setup();
		renderSettings({ canEdit: false });

		await openSyncOptions(user);

		// The backfill options are ungated today; rebinding whose account the
		// WHOLE project collects under is not.
		expect(
			await screen.findByText("Sync last 30 days"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /Reconnect sync to me/ }),
		).not.toBeInTheDocument();
	});
});
