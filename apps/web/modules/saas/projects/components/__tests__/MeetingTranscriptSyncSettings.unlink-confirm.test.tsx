/**
 * Unlink confirmation gate in MeetingTranscriptSyncSettings (#1905).
 *
 * Unlink is not reversible by relinking: `unlink-meeting.ts` cascade-deletes
 * the synced transcripts, deletes the ProjectContext rows derived from them,
 * and purges the matching Qdrant vectors. The same action was already gated on
 * the Meeting Digest tab; this pins the Project Settings surface (FR1-FR5,
 * AC1-AC3) and the copy, so it cannot silently regress back to a bare mutate.
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

type CapturedConfirm = {
	title: string;
	message?: string;
	confirmLabel?: string;
	destructive?: boolean;
	secondaryAction?: { label: string; onSelect: () => Promise<void> | void };
	onConfirm: () => Promise<void> | void;
};

const { confirmMock, captured } = vi.hoisted(() => {
	const captured: { current: CapturedConfirm | null } = { current: null };
	const confirmMock = vi.fn((options: CapturedConfirm) => {
		captured.current = options;
	});
	return { confirmMock, captured };
});

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

// The component reads tooltip copy via `useTranslations("tooltips.projectSettings")`,
// calling `t(key)` for plain strings and `t.raw("unlinkMeeting")` for the
// destructive-tooltip `{ label, warning }` object.
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
const restoreMeetingMock = vi.fn();
const listDeletedMeetingsMock = vi.fn();

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
				restoreMeeting: (...a: unknown[]) => restoreMeetingMock(...a),
				listDeletedMeetings: (...a: unknown[]) =>
					listDeletedMeetingsMock(...a),
			},
		},
	},
}));

vi.mock("@saas/meetings/components", () => ({
	LinkedMeetingSelector: () => (
		<div data-testid="stub-linked-meeting-selector" />
	),
}));

// Radix tooltip needs a ResizeObserver + hasPointerCapture in jsdom.
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

const linkedMeeting = {
	id: "linked_1",
	projectId: PROJECT_ID,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
	subject: "Weekly sync",
	organizer: "alice@example.com",
	linkedAt: new Date().toISOString(),
	userId: "user_1",
	organizationId: null,
	_count: { transcripts: 12 },
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
				project={{ meetingTranscriptSyncEnabled: true }}
			/>
		</QueryClientProvider>,
	);
}

/**
 * Unlink moved behind a per-row menu in #2355: it used to be a bare icon button
 * sitting next to the expand control, which is how it got clicked by people who
 * only meant to stop a meeting syncing. Reaching it now takes two deliberate
 * steps, and the reversible "Stop syncing" action sits above it.
 */
async function clickUnlink(user: ReturnType<typeof userEvent.setup>) {
	const trigger = await screen.findByRole("button", {
		name: "Options for Weekly sync",
	});
	await user.click(trigger);
	const item = await screen.findByRole("menuitem", {
		name: /Remove and delete transcripts/,
	});
	await user.click(item);
	return item;
}

describe("MeetingTranscriptSyncSettings — unlink confirmation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		captured.current = null;
		listLinkedMeetingsMock.mockResolvedValue([linkedMeeting]);
		listTranscriptsMock.mockResolvedValue([]);
		enableMock.mockResolvedValue({});
		disableMock.mockResolvedValue({});
		setAutoAnalyzeMock.mockResolvedValue({});
		triggerSyncMock.mockResolvedValue({});
		unlinkMeetingMock.mockResolvedValue({
			success: true,
			archiveId: "arch_1",
			transcriptCount: 12,
			recoverableUntil: new Date(Date.now() + 7 * 864e5).toISOString(),
		});
		setMeetingSyncActiveMock.mockResolvedValue({ success: true });
		restoreMeetingMock.mockResolvedValue({ success: true, reindexing: 1 });
		listDeletedMeetingsMock.mockResolvedValue([]);
	});

	it("asks for confirmation and does not unlink on click (FR1/AC1)", async () => {
		const user = userEvent.setup();
		renderSettings();

		await clickUnlink(user);

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(unlinkMeetingMock).not.toHaveBeenCalled();
	});

	it("names the count at risk, offers the safe option, and is destructive (FR2/FR3)", async () => {
		const user = userEvent.setup();
		renderSettings();

		await clickUnlink(user);

		// The count, not "its context": 12 transcripts is arresting in a way
		// an abstraction is not (#2355).
		expect(captured.current?.title).toBe("Delete 12 transcripts?");
		expect(captured.current?.message).toContain("12 transcripts");
		expect(captured.current?.message).toContain("undo this for 7 days");
		expect(captured.current?.confirmLabel).toBe("Delete transcripts");
		expect(captured.current?.destructive).toBe(true);

		// The fork: the reversible option is reachable from inside the dialog,
		// because dismissing it is the reflex that loses a meeting's history.
		expect(captured.current?.secondaryAction?.label).toBe(
			"Stop syncing, keep them",
		);
	});

	it("keeps the transcripts when the safe option is taken, and never deletes", async () => {
		const user = userEvent.setup();
		renderSettings();

		await clickUnlink(user);
		await captured.current?.secondaryAction?.onSelect();

		await waitFor(() => {
			expect(setMeetingSyncActiveMock).toHaveBeenCalledWith(
				expect.objectContaining({
					linkedMeetingId: "linked_1",
					active: false,
				}),
			);
		});
		expect(unlinkMeetingMock).not.toHaveBeenCalled();
	});

	it("unlinks the right meeting once confirmed (FR5/AC3)", async () => {
		const user = userEvent.setup();
		renderSettings();

		await clickUnlink(user);
		await captured.current?.onConfirm();

		await waitFor(() => {
			expect(unlinkMeetingMock).toHaveBeenCalledTimes(1);
		});
		expect(unlinkMeetingMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: null,
				linkedMeetingId: "linked_1",
			}),
		);
	});

	it("leaves the meeting linked when the dialog is dismissed (FR4/AC2/AC4)", async () => {
		const user = userEvent.setup();
		renderSettings();

		await clickUnlink(user);
		// Cancel, Escape and outside-click all resolve to "never invoke
		// onConfirm" — the provider owns dismissal, so not calling it is
		// exactly what those paths do here.

		expect(unlinkMeetingMock).not.toHaveBeenCalled();
		expect(
			await screen.findByRole("button", {
				name: "Options for Weekly sync",
			}),
		).toBeInTheDocument();
	});
});
