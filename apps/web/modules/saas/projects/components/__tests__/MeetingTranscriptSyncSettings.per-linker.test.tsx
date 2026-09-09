/**
 * Whose Microsoft account each meeting is read under (Fizzy #2354).
 *
 * A project used to read ONE calendar — the account that switched sync on —
 * and nothing on this panel said so. Meetings linked by anyone else were never
 * found, Microsoft calls an unmatched calendar query "no meetings" rather than
 * an error, and the panel reported a healthy sync throughout. These tests pin
 * the three things that make that visible and fixable from here: every row
 * names the account it is read from, a stalled sync names whose connection
 * needs attention, and one meeting can be taken over without touching the
 * rest of the project.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user_me", name: "Current User" } }),
}));

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

const myMeeting = {
	id: "linked_mine",
	projectId: PROJECT_ID,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/mine",
	subject: "Weekly sync",
	organizer: "organizer@example.com",
	linkedAt: new Date().toISOString(),
	deactivatedAt: null,
	consecutiveFailures: 0,
	lastErrorMessage: null,
	lastErrorAt: null,
	userId: "user_me",
	user: { id: "user_me", name: "Current User", email: "me@example.com" },
	organizationId: null,
	_count: { transcripts: 12 },
};

const theirMeeting = {
	...myMeeting,
	id: "linked_theirs",
	joinUrl: "https://teams.microsoft.com/l/meetup-join/theirs",
	subject: "Client call",
	userId: "user_them",
	user: {
		id: "user_them",
		name: "Project Member",
		email: "member@example.com",
	},
	_count: { transcripts: 1 },
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

async function openRowMenu(
	user: ReturnType<typeof userEvent.setup>,
	subject: string,
) {
	await user.click(
		await screen.findByRole("button", { name: `Options for ${subject}` }),
	);
}

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
	listLinkedMeetingsMock.mockResolvedValue([myMeeting, theirMeeting]);
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
						currentlyBoundTo: "user_them",
					}
				: { mode: "repaired", workflowStatus: null },
	);
});

describe("MeetingTranscriptSyncSettings — whose account a meeting syncs under", () => {
	it("names the account behind every row", async () => {
		renderSettings();

		expect(await screen.findByText("Syncs as you")).toBeInTheDocument();
		expect(
			await screen.findByText("Syncs as Project Member"),
		).toBeInTheDocument();
	});

	it("says so plainly when a row predates the linker column", async () => {
		listLinkedMeetingsMock.mockResolvedValue([
			{ ...myMeeting, userId: null, user: null },
		]);
		renderSettings();

		expect(
			await screen.findByText(/Syncs under the project.s connection/),
		).toBeInTheDocument();
	});

	it("offers a takeover only where the account is somebody else's", async () => {
		const user = userEvent.setup();
		renderSettings();

		await openRowMenu(user, "Client call");
		expect(
			await screen.findByRole("menuitem", { name: /Sync as me/ }),
		).toBeInTheDocument();

		await user.keyboard("{Escape}");

		await openRowMenu(user, "Weekly sync");
		await screen.findByRole("menuitem", { name: /Stop syncing/ });
		expect(
			screen.queryByRole("menuitem", { name: /Sync as me/ }),
		).not.toBeInTheDocument();
	});

	it("takes over that one meeting, and no others", async () => {
		const user = userEvent.setup();
		renderSettings();

		await openRowMenu(user, "Client call");
		await user.click(
			await screen.findByRole("menuitem", { name: /Sync as me/ }),
		);

		// Preflight first — moving a meeting onto an account that cannot see it
		// trades a visibly broken sync for a quietly empty one.
		await waitFor(() => {
			expect(repairSyncMock).toHaveBeenCalledWith(
				expect.objectContaining({
					preflightOnly: true,
					linkedMeetingIds: ["linked_theirs"],
				}),
			);
		});
		expect(repairSyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				preflightOnly: false,
				linkedMeetingIds: ["linked_theirs"],
			}),
		);
	});
});

describe("MeetingTranscriptSyncSettings — a stalled connection", () => {
	const stalled = {
		...theirMeeting,
		consecutiveFailures: 5,
		lastErrorMessage:
			"Microsoft is not connected for the account these meetings sync under. Reconnect it, or take the meetings over, to resume.",
		lastErrorAt: new Date().toISOString(),
	};

	it("names whose connection needs attention, not just that something failed", async () => {
		listLinkedMeetingsMock.mockResolvedValue([myMeeting, stalled]);
		renderSettings();

		const banner = await screen.findByRole("status");
		// The rest of the project is still collecting, so "the sync is broken"
		// would send the wrong person looking.
		expect(
			within(banner).getByText("1 of 2 meetings are not syncing"),
		).toBeInTheDocument();
		expect(banner).toHaveTextContent("They sync as Project Member.");
	});

	it("scopes its fix to the meetings that actually stalled", async () => {
		listLinkedMeetingsMock.mockResolvedValue([myMeeting, stalled]);
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("button", { name: "Sync these as me" }),
		);

		await waitFor(() => {
			expect(repairSyncMock).toHaveBeenCalledWith(
				expect.objectContaining({
					preflightOnly: true,
					linkedMeetingIds: ["linked_theirs"],
				}),
			);
		});
	});
});
