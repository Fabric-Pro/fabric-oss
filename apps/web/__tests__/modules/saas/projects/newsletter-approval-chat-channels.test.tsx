/**
 * Render tests for the review-alert chat channel picker (Fizzy #2203, Task 11).
 *
 * Follows the `__q`-keyed mock convention established by
 * `ProjectNewsletterSettings.deliveryDestination.test.tsx`: every `useQuery`
 * call is stubbed by the marker `queryOptions()` stamps into its options, and
 * `useMutation` routes its `mutate` call by the shape of the argument (a
 * string means `sendNow`, an object means `updateSettings`).
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) =>
		namespace ? `${namespace}.${key}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));

const updateMutate = vi.fn();
const sendNowMutate = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		newsletter: {
			settings: {
				get: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "settings",
						...o,
					}),
					queryKey: (o: { input: unknown }) => ["settings", o.input],
				},
				update: {
					mutationOptions: () => ({ __m: "update" }),
				},
				regenerateEmbedToken: {
					mutationOptions: () => ({ __m: "regenerate" }),
				},
			},
			subscribers: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "subscribers",
						...o,
					}),
					queryKey: (o: { input: unknown }) => [
						"subscribers",
						o.input,
					],
				},
			},
			sends: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "sends",
						...o,
					}),
				},
				pending: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "pending",
						...o,
					}),
				},
				chatDeliveries: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "chatDeliveries",
						...o,
					}),
				},
			},
		},
		projects: {
			repositoryIntegrations: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "repos",
						...o,
					}),
				},
			},
			teamsChannelMonitor: {
				listLinkedChannels: {
					queryOptions: (o: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						__q: "teamsLinked",
						...o,
					}),
				},
			},
			slackChannelMonitor: {
				listLinkedChannels: {
					queryOptions: (o: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						__q: "slackLinked",
						...o,
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

const queryData: Record<string, unknown> = {};
// The options each `useQuery` was actually called with, keyed by the `__q`
// marker. The mock deliberately still returns data regardless of `enabled` —
// that keeps every other test in this file shaped as it was — so `enabled` is
// only observable by inspecting what the component ASKED for, which is what
// this map is for.
type SeenQueryOptions = {
	enabled?: boolean;
	refetchInterval?: unknown;
};
const seenQueryOptions: Record<string, SeenQueryOptions> = {};
vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: {
		__q?: string;
		enabled?: boolean;
		refetchInterval?: unknown;
	}) => {
		if (opts.__q) {
			seenQueryOptions[opts.__q] = opts;
		}
		return {
			data: queryData[opts.__q ?? ""],
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		};
	},
	useMutation: () => ({
		isPending: false,
		mutate: (...args: unknown[]) => {
			const [arg] = args;
			if (typeof arg === "string") {
				sendNowMutate(...args);
			} else if (typeof arg === "object" && arg !== null) {
				updateMutate(...args);
			}
		},
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProjectNewsletterSettings } from "@saas/projects/components/ProjectNewsletterSettings";

function setSettings(over: Record<string, unknown> = {}) {
	queryData.settings = {
		settings: {
			enabled: false,
			requireApproval: false,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lookbackDays: null,
			detailLevel: "STANDARD",
			deliveryDestination: "EMAIL",
			chatChannels: [],
			approvalChatChannels: [],
			publicWidgetEnabled: false,
			publicEmbedToken: null,
			publicEmbedTokenVersion: 1,
			publicWidgetTheme: null,
			publicWidgetAccent: null,
			publicWidgetConfig: null,
			...over,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(seenQueryOptions)) {
		delete seenQueryOptions[k];
	}
	setSettings();
	queryData.subscribers = { subscribers: [] };
	queryData.sends = { sends: [], total: 0 };
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
	queryData.chatDeliveries = { deliveries: [] };
});

describe("ProjectNewsletterSettings — review-alert chat channel picker", () => {
	it("hides the alert channel picker while review is off", () => {
		setSettings({ requireApproval: false });
		queryData.slackLinked = [
			{
				slackTeamId: "T1",
				channelId: "C1",
				channelName: "releases",
			},
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.queryByText("Review alert channels"),
		).not.toBeInTheDocument();
	});

	// The linked-channel queries were widened from `enabled: chatSelected` to
	// `enabled: chatSelected || requireApproval`. That widening is the whole
	// reason the picker works for this feature's PRIMARY audience: a
	// review-gated project that delivers by email has deliveryDestination EMAIL
	// and therefore chatSelected false, so under the old condition the two
	// queries never ran and the picker showed "connect a channel" forever, even
	// with channels linked. Nothing else in this file can catch a revert — the
	// useQuery mock returns data whether or not the query is enabled — so this
	// asserts the condition the component actually passed.
	it("fetches the linked-channel lists for a review-gated EMAIL-delivery project", async () => {
		setSettings({ requireApproval: true, deliveryDestination: "EMAIL" });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(seenQueryOptions.slackLinked?.enabled).toBe(true);
		expect(seenQueryOptions.teamsLinked?.enabled).toBe(true);
	});

	it("does not fetch them when neither review nor chat delivery wants them", async () => {
		setSettings({ requireApproval: false, deliveryDestination: "EMAIL" });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(seenQueryOptions.slackLinked?.enabled).toBe(false);
		expect(seenQueryOptions.teamsLinked?.enabled).toBe(false);
	});

	it("shows the picker when review is on", async () => {
		setSettings({ requireApproval: true });
		queryData.slackLinked = [
			{
				slackTeamId: "T1",
				channelId: "C1",
				channelName: "releases",
			},
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByText("Review alert channels"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "SLACK: releases" }),
		).toBeInTheDocument();
	});

	it("sends the full recomputed array when a channel is ticked", async () => {
		setSettings({ requireApproval: true, approvalChatChannels: [] });
		queryData.slackLinked = [
			{
				slackTeamId: "T1",
				channelId: "C1",
				channelName: "releases",
			},
		];
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		await user.click(
			await screen.findByRole("checkbox", { name: "SLACK: releases" }),
		);

		expect(updateMutate).toHaveBeenCalledTimes(1);
		const call = updateMutate.mock.calls[0][0];
		expect(call.approvalChatChannels).toEqual([
			{
				platform: "SLACK",
				teamId: "T1",
				channelId: "C1",
				channelName: "releases",
			},
		]);
		// The two lists are independent — ticking the alert-channel checkbox
		// must not also rewrite the audience chatChannels list.
		expect(call).not.toHaveProperty("chatChannels");
	});

	// This paragraph used to say the opposite — that alerts "are not being
	// dispatched yet". That was written while FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT
	// defaulted OFF and the picker shipped ahead of dispatch. #3062 flipped the
	// default to ON without touching this file, so the sentence became false:
	// staging delivered two alerts while it was on screen. Left as it was, it
	// tells an admin that ticking a box is inert at the exact moment ticking it
	// arms a live post into a team channel.
	it("tells the admin that a ticked channel receives the alert", async () => {
		setSettings({ requireApproval: true });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByText(
				/receives the review alert as soon as a newsletter is held/i,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/not being dispatched yet/i),
		).not.toBeInTheDocument();
	});

	// The first draft of the sentence above ended "alongside the in-app
	// notification and the reviewer email", which promises a delivery this
	// panel cannot make: `sendNewsletterApprovalEmailsActivity` bails when mail
	// is unconfigured, when an organization project has no slug (no correct
	// link exists), and per recipient on the `reviewEmails` opt-out. Naming the
	// one precondition an admin can act on keeps the useful "chat is a third
	// route" framing without restating the sentence's own defect one paragraph
	// after fixing it.
	it("does not promise the reviewer email unconditionally", async () => {
		setSettings({ requireApproval: true });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByText(/needs mail configured/i),
		).toBeInTheDocument();
	});

	// A channel in BOTH lists receives the review alert AND the published notes,
	// which is supported since the contract release dropped the legacy
	// single-channel ledger index. Before it, this overlap silently broke
	// publication. The marker is informational, not a warning — the two pickers
	// are far apart and neither mentions the other, so the overlap has to be
	// visible where it is made.
	it("marks an alert channel that is also in the audience list", async () => {
		const channel = {
			platform: "SLACK",
			teamId: "T1",
			channelId: "C1",
			channelName: "releases",
		};
		// Both halves of the conjunction, which is what the name claims. This
		// fixture used to set only `chatChannels` and still passed, because the
		// badge ignored the checkbox — the test was green on the strength of
		// the defect it was meant to describe.
		setSettings({
			requireApproval: true,
			chatChannels: [channel],
			approvalChatChannels: [channel],
		});
		queryData.slackLinked = [
			{ slackTeamId: "T1", channelId: "C1", channelName: "releases" },
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.getByRole("checkbox", { name: "SLACK: releases" }),
		).toBeChecked();
		expect(
			await screen.findByText("Also receives the published notes"),
		).toBeInTheDocument();
	});

	// "Also" is a claim about a conjunction: this channel carries the review
	// alert AND the published notes. A channel that is only in the audience
	// carries one of the two, so the word is false for it — and it reads as
	// though the overlap were already in force when the admin has not asked
	// for it. The badge belongs to the ticked row, not to the audience list.
	it("does not mark an audience channel whose alert box is unticked", async () => {
		const channel = {
			platform: "SLACK",
			teamId: "T1",
			channelId: "C1",
			channelName: "releases",
		};
		setSettings({
			requireApproval: true,
			chatChannels: [channel],
			approvalChatChannels: [],
		});
		queryData.slackLinked = [
			{ slackTeamId: "T1", channelId: "C1", channelName: "releases" },
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByRole("checkbox", { name: "SLACK: releases" }),
		).not.toBeChecked();
		expect(
			screen.queryByText("Also receives the published notes"),
		).not.toBeInTheDocument();
	});

	it("does not mark a channel that only receives the alert", async () => {
		setSettings({ requireApproval: true, chatChannels: [] });
		queryData.slackLinked = [
			{ slackTeamId: "T1", channelId: "C1", channelName: "releases" },
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByRole("checkbox", { name: "SLACK: releases" }),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Also receives the published notes"),
		).not.toBeInTheDocument();
	});

	it("disables the picker when the viewer cannot edit settings", async () => {
		setSettings({ requireApproval: true });
		queryData.slackLinked = [
			{
				slackTeamId: "T1",
				channelId: "C1",
				channelName: "releases",
			},
		];
		render(
			<ProjectNewsletterSettings
				projectId="p-1"
				organizationId={null}
				canEdit={false}
			/>,
		);
		expect(
			await screen.findByRole("checkbox", { name: "SLACK: releases" }),
		).toBeDisabled();
	});

	it("opens the Channels disclosure for an email-delivery send that was review-gated", async () => {
		queryData.sends = {
			sends: [
				{
					id: "send-1",
					createdAt: new Date("2026-08-18T09:00:00Z").toISOString(),
					trigger: "SCHEDULED",
					status: "SENT",
					skipReason: null,
					requireApproval: true,
					deliveryDestination: "EMAIL",
					sentCount: 3,
					recipientCount: 3,
					failedCount: 0,
				},
			],
			total: 1,
		};
		queryData.chatDeliveries = {
			deliveries: [
				{
					kind: "APPROVAL",
					platform: "SLACK",
					externalTeamId: "T1",
					channelId: "C1",
					channelName: "releases",
					status: "SKIPPED",
					reason: "channel no longer linked to project",
				},
			],
		};
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		const channelsButton = await screen.findByRole("button", {
			name: /Channels/,
		});
		expect(channelsButton).toBeInTheDocument();
		await user.click(channelsButton);

		expect(
			await screen.findByText("channel no longer linked to project"),
		).toBeInTheDocument();
	});

	// "Approve & send" leaves the row at APPROVED with 0/0 delivered. That is
	// TRUE at that instant, not a stale read — the API records the decision and
	// the Temporal workflow delivers afterwards — and the mutation already
	// invalidates the sends list. What was missing is the second read: nothing
	// refetched once the workflow finished, so the panel kept asserting
	// "Approved · 0/0" and an open Channels disclosure kept omitting the
	// published-notes row until the admin reloaded the page.
	//
	// These assert the interval FUNCTION the component hands to react-query
	// rather than waiting for a tick. A v5 `refetchInterval` under vitest fake
	// timers needs real timers AND a focused window before it fires at all, so
	// a timing-based test here would prove far less for much more setup.
	describe("refetches while a send is still in flight", () => {
		const intervalFor = (statuses: string[]): unknown => {
			queryData.sends = {
				sends: statuses.map((status, i) => ({
					id: `send-${i}`,
					createdAt: new Date("2026-08-21T09:00:00Z").toISOString(),
					trigger: "MANUAL",
					status,
					skipReason: null,
					requireApproval: true,
					deliveryDestination: "CHAT",
					sentCount: 0,
					recipientCount: 0,
					failedCount: 0,
				})),
				total: statuses.length,
			};
			render(
				<ProjectNewsletterSettings
					projectId="p-1"
					organizationId={null}
				/>,
			);
			const interval = seenQueryOptions.sends?.refetchInterval;
			if (typeof interval !== "function") {
				return interval;
			}
			return (interval as (q: unknown) => unknown)({
				state: { data: queryData.sends },
			});
		};

		it("polls while a send is APPROVED and the workflow is still delivering", () => {
			expect(intervalFor(["APPROVED"])).toBe(5000);
		});

		it("polls while a send is PENDING", () => {
			expect(intervalFor(["PENDING"])).toBe(5000);
		});

		it("stops once every send has reached a terminal state", () => {
			expect(intervalFor(["SENT", "REJECTED", "SKIPPED_EMPTY"])).toBe(
				false,
			);
		});

		// A draft awaiting a human can sit for days. Polling it would be an
		// unbounded background request loop that no machine is going to end,
		// which is a different problem from the one above.
		it("does not poll a draft that is waiting on a reviewer", () => {
			expect(intervalFor(["PENDING_APPROVAL"])).toBe(false);
		});

		// The other half of the same symptom. An admin who approves with the
		// disclosure already open watches the channel list, not the status
		// badge — and the published-notes row appears only after the workflow
		// posts it. The deliveries payload carries no send status of its own,
		// so this interval has to be decided from the sends list.
		const deliveriesIntervalFor = async (status: string) => {
			queryData.sends = {
				sends: [
					{
						id: "send-1",
						createdAt: new Date(
							"2026-08-21T09:00:00Z",
						).toISOString(),
						trigger: "MANUAL",
						status,
						skipReason: null,
						requireApproval: true,
						deliveryDestination: "CHAT",
						sentCount: 0,
						recipientCount: 0,
						failedCount: 0,
					},
				],
				total: 1,
			};
			const user = userEvent.setup();
			render(
				<ProjectNewsletterSettings
					projectId="p-1"
					organizationId={null}
				/>,
			);
			await user.click(
				await screen.findByRole("button", { name: /Channels/ }),
			);
			return seenQueryOptions.chatDeliveries?.refetchInterval;
		};

		it("polls the open channel disclosure while its send is in flight", async () => {
			expect(await deliveriesIntervalFor("APPROVED")).toBe(5000);
		});

		it("stops polling the disclosure once its send has landed", async () => {
			expect(await deliveriesIntervalFor("SENT")).toBe(false);
		});
	});

	it("keeps an alert row and a content row for the SAME channel distinct across a re-render", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		queryData.sends = {
			sends: [
				{
					id: "send-1",
					createdAt: new Date("2026-08-18T09:00:00Z").toISOString(),
					trigger: "SCHEDULED",
					status: "SENT",
					skipReason: null,
					requireApproval: true,
					deliveryDestination: "CHAT",
					sentCount: 1,
					recipientCount: 1,
					failedCount: 0,
				},
			],
			total: 1,
		};
		queryData.chatDeliveries = {
			deliveries: [
				{
					kind: "APPROVAL",
					platform: "SLACK",
					externalTeamId: "T1",
					channelId: "C1",
					channelName: "releases",
					status: "SENT",
					reason: null,
				},
				{
					kind: "CONTENT",
					platform: "SLACK",
					externalTeamId: "T1",
					channelId: "C1",
					channelName: "releases",
					status: "FAILED",
					reason: "delivery failed",
				},
			],
		};

		const user = userEvent.setup();
		const { rerender } = render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		await user.click(
			await screen.findByRole("button", { name: /Channels/ }),
		);

		const assertBothRows = async () => {
			const alertRow = (await screen.findByText("Review alert")).closest(
				"li",
			) as HTMLElement;
			const contentRow = screen
				.getByText("Release notes")
				.closest("li") as HTMLElement;
			expect(within(alertRow).getByText("Delivered")).toBeInTheDocument();
			expect(within(contentRow).getByText("Failed")).toBeInTheDocument();
		};

		await assertBothRows();

		// Reverse the delivery order and re-render — this is what forces React
		// to reconcile the list rather than just mount it fresh.
		queryData.chatDeliveries = {
			deliveries: [
				...(
					queryData.chatDeliveries as {
						deliveries: Record<string, unknown>[];
					}
				).deliveries,
			].reverse(),
		};
		rerender(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		await assertBothRows();

		expect(
			errorSpy.mock.calls.some((c) => String(c[0]).includes("same key")),
		).toBe(false);
		errorSpy.mockRestore();
	});
});
