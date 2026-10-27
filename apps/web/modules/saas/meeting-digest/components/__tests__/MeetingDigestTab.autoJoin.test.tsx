import { ORPCError } from "@orpc/client";
import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingDigestTab } from "../MeetingDigestTab";

const mocks = vi.hoisted(() => ({
	setParlumeAutoJoin: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("../../hooks/use-meeting-digest", () => ({
	useMeetingDigest: () => ({
		meetings: [],
		configMeetings: [
			{
				linkedMeetingId: "lm-1",
				subject: "Weekly sync",
				includedInDigest: true,
				lastMeetingDate: null,
				parlumeAutoJoin: {
					enabled: false,
					toolsReadOnly: true,
					suggestionsEnabled: true,
					enabledBy: null,
					error: null,
					errorAt: null,
					syncStopped: false,
				},
			},
		],
		seriesWithoutTranscripts: [],
		awaitingOccurrences: [],
		isLoading: false,
		isError: false,
		setIncluded: vi.fn(),
		setParlumeAutoJoin: mocks.setParlumeAutoJoin,
		onActionItemToggled: vi.fn(),
		generateSummary: vi.fn(),
		generatingRefs: new Set(),
		summaryErrors: {},
		unlinkMeeting: vi.fn(),
		refreshAfterLink: vi.fn(),
	}),
}));

vi.mock("../../hooks/use-linked-meeting-join-urls", () => ({
	useLinkedMeetingJoinUrls: () => ({ joinUrls: [] }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				getMeeting: vi.fn(),
				getPersonalTranscript: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));

vi.mock("sonner", () => ({
	toast: { error: mocks.toastError, success: vi.fn() },
}));

function renderTab(flags: { parlume: boolean; agenda: boolean }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<FeatureFlagProvider
				value={
					{
						PERSONAL_MEETINGS: false,
						MEETING_AGENDA: flags.agenda,
						PARLUME_MEETINGS: flags.parlume,
					} as Record<FeatureFlagKey, boolean>
				}
			>
				{children}
			</FeatureFlagProvider>
		</QueryClientProvider>
	);
	return render(
		<MeetingDigestTab projectId="p1" organizationId="o1" canEdit />,
		{ wrapper },
	);
}

async function openConfigure() {
	await userEvent.click(
		screen.getByRole("button", { name: "Configure meetings" }),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.setParlumeAutoJoin.mockResolvedValue(undefined);
});

describe("MeetingDigestTab — Parlume auto-join", () => {
	it("offers the switch on each series while both flags are on", async () => {
		renderTab({ parlume: true, agenda: true });
		await openConfigure();

		expect(
			screen.getByRole("switch", {
				name: /Parlume joins automatically/,
			}),
		).not.toBeChecked();
	});

	it.each([
		{ parlume: false, agenda: true },
		{ parlume: true, agenda: false },
	])("hides the switch when a flag is off (%o)", async (flags) => {
		renderTab(flags);
		await openConfigure();

		expect(screen.getByText("Weekly sync")).toBeInTheDocument();
		expect(
			screen.queryByRole("switch", {
				name: /Parlume joins automatically/,
			}),
		).not.toBeInTheDocument();
	});

	it("turns auto-join on with the default read-only mode and suggestions", async () => {
		renderTab({ parlume: true, agenda: true });
		await openConfigure();

		await userEvent.click(
			screen.getByRole("switch", { name: /Parlume joins automatically/ }),
		);

		expect(mocks.setParlumeAutoJoin).toHaveBeenCalledWith("lm-1", {
			enabled: true,
			toolsReadOnly: true,
			suggestionsEnabled: true,
		});
	});

	it("shows the server's reason when turning it on is refused", async () => {
		mocks.setParlumeAutoJoin.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message:
					"Connect your Microsoft account in Settings → Integrations first.",
			}),
		);
		renderTab({ parlume: true, agenda: true });
		await openConfigure();

		await userEvent.click(
			screen.getByRole("switch", { name: /Parlume joins automatically/ }),
		);

		await waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Parlume auto-join was not changed",
				{
					description:
						"Connect your Microsoft account in Settings → Integrations first.",
				},
			),
		);
	});
});
