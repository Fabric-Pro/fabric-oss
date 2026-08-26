/**
 * Huddle-notes ingest toggle in SlackChannelMonitorSettings.
 *
 * The "Ingest huddle notes" switch is a SEPARATE opt-in from the channel
 * monitor's "Auto-monitor" switch (decision #5). It wires to
 * `orpcClient.projects.slackHuddleIngest.{enable,disable,triggerNow}` via
 * `getSlackHuddleIngestClient()`. These tests pin:
 *   1. toggling on → calls `enable` with the chosen interval,
 *   2. toggling off → calls `disable`,
 *   3. a missing-scope enable error → shows the "Reconnect Slack" toast
 *      (decision #7: minimal surfacing, no banner/gating).
 *
 * The huddle sub-section only renders once channels are linked, so the
 * linked-channels query is mocked to return one channel.
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

vi.mock("../SlackChannelPickerDialog", () => ({
	SlackChannelPickerDialog: () => <div data-testid="stub-picker" />,
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

const listLinkedChannelsMock = vi.fn();
const huddleEnableMock = vi.fn();
const huddleDisableMock = vi.fn();
const huddleTriggerNowMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			slackChannelMonitor: {
				listLinkedChannels: (...a: unknown[]) =>
					listLinkedChannelsMock(...a),
				enable: vi.fn(),
				disable: vi.fn(),
				triggerMonitor: vi.fn(),
				unlinkChannel: vi.fn(),
			},
			slackHuddleIngest: {
				enable: (...a: unknown[]) => huddleEnableMock(...a),
				disable: (...a: unknown[]) => huddleDisableMock(...a),
				triggerNow: (...a: unknown[]) => huddleTriggerNowMock(...a),
			},
		},
	},
}));

import { SlackChannelMonitorSettings } from "../SlackChannelMonitorSettings";

const linkedChannel = {
	id: "linked_1",
	projectId: "proj_1",
	slackTeamId: "T1",
	channelId: "C1",
	teamName: "Acme",
	channelName: "general",
	channelWebUrl: null,
	linkedAt: new Date().toISOString(),
	monitorEnabledAt: null,
	backfillCompleteAt: null,
	lastMessageTs: null,
	consecutiveFailures: 0,
	lastErrorMessage: null,
	lastErrorAt: null,
	userId: "user_1",
	organizationId: null,
	_count: { seenMessages: 0 },
};

function renderSettings(projectOverrides: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<SlackChannelMonitorSettings
				projectId="proj_1"
				organizationId={null}
				project={{
					slackChannelMonitorEnabled: false,
					slackHuddleIngestEnabled: false,
					...projectOverrides,
				}}
			/>
		</QueryClientProvider>,
	);
}

async function findHuddleSwitch() {
	return await screen.findByRole("switch", {
		name: "Ingest Slack huddle notes",
	});
}

describe("SlackChannelMonitorSettings — huddle ingest toggle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listLinkedChannelsMock.mockResolvedValue([linkedChannel]);
		huddleEnableMock.mockResolvedValue({});
		huddleDisableMock.mockResolvedValue({});
		huddleTriggerNowMock.mockResolvedValue({});
	});

	it("toggling on calls enable with the default interval", async () => {
		const user = userEvent.setup();
		renderSettings();

		const toggle = await findHuddleSwitch();
		await user.click(toggle);

		await waitFor(() => {
			expect(huddleEnableMock).toHaveBeenCalledTimes(1);
		});
		expect(huddleEnableMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				organizationId: null,
				intervalMinutes: 15,
			}),
		);
		expect(toastSuccessMock).toHaveBeenCalledWith(
			"Huddle notes ingest enabled",
		);
	});

	it("toggling off calls disable", async () => {
		const user = userEvent.setup();
		renderSettings({ slackHuddleIngestEnabled: true });

		const toggle = await findHuddleSwitch();
		await user.click(toggle);

		await waitFor(() => {
			expect(huddleDisableMock).toHaveBeenCalledTimes(1);
		});
		expect(huddleDisableMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				organizationId: null,
			}),
		);
	});

	it("surfaces a reconnect toast on a missing-scope enable error", async () => {
		huddleEnableMock.mockRejectedValueOnce(
			new Error("missing_scope: files:read"),
		);
		const user = userEvent.setup();
		renderSettings();

		const toggle = await findHuddleSwitch();
		await user.click(toggle);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Reconnect Slack to grant huddle-notes access",
				expect.objectContaining({ description: expect.any(String) }),
			);
		});
	});
});
