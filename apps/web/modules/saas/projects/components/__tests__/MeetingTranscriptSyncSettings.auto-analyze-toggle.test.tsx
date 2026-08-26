/**
 * "Auto-create feature proposals" toggle in MeetingTranscriptSyncSettings.
 *
 * This switch is a SEPARATE opt-in from the "Scheduled Auto-Sync" switch
 * (spec `ai-update-auto-scan`, D1). It wires to
 * `orpcClient.projects.meetingTranscriptSync.setAutoAnalyze({ projectId,
 * organizationId, enabled })` and flips the project-level
 * `meetingTranscriptAutoAnalyzeEnabled` flag the auto-analysis hook reads.
 *
 * These tests pin Task 6.3 (AC1 / AC7):
 *   1. toggling on (sync enabled) → calls `setAutoAnalyze` with `enabled: true`,
 *   2. the toggle is DISABLED when transcript sync is off (it has no effect
 *      without sync — a stored `true` stays inert because the activity gates
 *      on both flags).
 *
 * The auto-sync controls block (which hosts this toggle) only renders once a
 * meeting is linked, so the linked-meetings query is mocked to return one.
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

// Stub the orpc query-key builder used by the auto-analyze mutation's
// invalidate path so the test doesn't drag the whole oRPC client in.
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

// The selector dialog is heavy and irrelevant to the toggle; stub it.
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
	_count: { transcripts: 0 },
};

function renderSettings(projectOverrides: Record<string, unknown> = {}) {
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
					...projectOverrides,
				}}
			/>
		</QueryClientProvider>,
	);
}

async function findAutoAnalyzeSwitch() {
	return await screen.findByRole("switch", {
		name: "Auto-create proposals",
	});
}

describe("MeetingTranscriptSyncSettings — auto-create proposals toggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listLinkedMeetingsMock.mockResolvedValue([linkedMeeting]);
		listTranscriptsMock.mockResolvedValue([]);
		enableMock.mockResolvedValue({});
		disableMock.mockResolvedValue({});
		setAutoAnalyzeMock.mockResolvedValue({});
		triggerSyncMock.mockResolvedValue({});
		unlinkMeetingMock.mockResolvedValue({});
	});

	it("toggling on calls setAutoAnalyze with enabled: true when sync is enabled", async () => {
		const user = userEvent.setup();
		renderSettings({ meetingTranscriptSyncEnabled: true });

		const toggle = await findAutoAnalyzeSwitch();
		expect(toggle).toBeEnabled();

		await user.click(toggle);

		await waitFor(() => {
			expect(setAutoAnalyzeMock).toHaveBeenCalledTimes(1);
		});
		expect(setAutoAnalyzeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: null,
				enabled: true,
			}),
		);
		expect(toastSuccessMock).toHaveBeenCalledWith(
			"Auto-create proposals enabled",
		);
	});

	it("toggling off calls setAutoAnalyze with enabled: false", async () => {
		const user = userEvent.setup();
		renderSettings({
			meetingTranscriptSyncEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
		});

		const toggle = await findAutoAnalyzeSwitch();
		await user.click(toggle);

		await waitFor(() => {
			expect(setAutoAnalyzeMock).toHaveBeenCalledTimes(1);
		});
		expect(setAutoAnalyzeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: null,
				enabled: false,
			}),
		);
	});

	it("is disabled (and never calls setAutoAnalyze) when transcript sync is off", async () => {
		const user = userEvent.setup();
		renderSettings({ meetingTranscriptSyncEnabled: false });

		const toggle = await findAutoAnalyzeSwitch();
		expect(toggle).toBeDisabled();

		// Clicking a disabled switch must not fire the mutation.
		await user.click(toggle);
		await new Promise((r) => setTimeout(r, 0));
		expect(setAutoAnalyzeMock).not.toHaveBeenCalled();
	});
});
