/**
 * The "Images in highlights" setting and the review entry point it changes:
 * a held send that takes images is reviewed in a dialog (compact row +
 * Review), every other held send keeps the inline checklist.
 *
 * React Query is mocked as in the sibling tests. `useMutation` runs the
 * component's own `mutationFn`, so the approve payload is asserted where it
 * leaves the component: the `orpcClient.newsletter.sends.approve` call.
 */
import {
	render as baseRender,
	fireEvent,
	screen,
	within,
} from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const render = (ui: ReactElement) =>
	baseRender(ui, {
		wrapper: ({ children }) => (
			<NuqsTestingAdapter>{children}</NuqsTestingAdapter>
		),
	});

const { mutateSpy, approveSpy, refetchSpy, queryData } = vi.hoisted(() => ({
	mutateSpy: vi.fn(),
	approveSpy: vi.fn(),
	refetchSpy: vi.fn(),
	queryData: {} as Record<string, unknown>,
}));

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) =>
		namespace ? `${namespace}.${key}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const queryOptions = (q: string) => (o: { input: unknown }) => ({
		__q: q,
		...o,
	});
	return {
		orpc: {
			newsletter: {
				settings: {
					get: {
						queryOptions: queryOptions("settings"),
						queryKey: (o: { input: unknown }) => [
							"settings",
							o.input,
						],
					},
					update: {
						mutationOptions: (opts: unknown) => ({
							...(opts as object),
							__m: "update",
						}),
					},
					regenerateEmbedToken: {
						mutationOptions: () => ({ __m: "regenerate" }),
					},
				},
				subscribers: {
					list: {
						queryOptions: queryOptions("subscribers"),
						queryKey: (o: { input: unknown }) => [
							"subscribers",
							o.input,
						],
					},
				},
				sends: {
					list: { queryOptions: queryOptions("sends") },
					pending: { queryOptions: queryOptions("pending") },
					recipientPreview: {
						queryOptions: queryOptions("recipientPreview"),
					},
					chatDeliveries: {
						queryOptions: queryOptions("chatDeliveries"),
					},
				},
			},
			projects: {
				environments: {
					list: { queryOptions: queryOptions("environments") },
				},
				repositoryIntegrations: {
					list: { queryOptions: queryOptions("repos") },
				},
				teamsChannelMonitor: {
					listLinkedChannels: {
						queryOptions: queryOptions("teamsLinked"),
					},
				},
				slackChannelMonitor: {
					listLinkedChannels: {
						queryOptions: queryOptions("slackLinked"),
					},
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		newsletter: {
			sends: {
				approve: (input: unknown) => approveSpy(input),
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: <T,>(data: T) => data,
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
		refetch: refetchSpy,
	}),
	useMutation: (opts: { mutationFn?: (variables: unknown) => unknown }) => ({
		isPending: false,
		mutate: (variables: unknown) => {
			mutateSpy(variables);
			opts.mutationFn?.(variables);
		},
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProjectNewsletterSettings } from "../ProjectNewsletterSettings";

function setSettings(over: Record<string, unknown> = {}) {
	queryData.settings = {
		settings: {
			enabled: true,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lookbackDays: null,
			requireApproval: true,
			screenshotsEnabled: false,
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

function pendingSend(over: Record<string, unknown> = {}) {
	return {
		id: "send-1",
		status: "PENDING_APPROVAL",
		createdAt: "2026-11-10T09:00:00.000Z",
		screenshotsEnabled: true,
		content: {
			headline: "This week's release notes",
			intro: "Two changes shipped since the last send.",
			highlights: [
				{
					title: "Faster search",
					description: "Search results now load twice as fast.",
					releaseTag: "v2.1.0",
				},
				{
					title: "New dashboard",
					description: "A redesigned project overview page.",
					releaseTag: "v2.1.0",
				},
			],
		},
		images: [
			{
				id: "img-1",
				sendId: "send-1",
				highlightIndex: 0,
				position: 0,
				captureState: "READY",
				included: true,
				source: "UPLOAD",
				altText: "Search results page",
				width: 1200,
				height: 680,
				bytes: 120_000,
				errorMessage: null,
				createdAt: "2026-11-10T09:00:00.000Z",
				updatedAt: "2026-11-10T09:00:00.000Z",
				url: "https://storage.example.com/signed/img-1.png",
				downloadUrl:
					"https://storage.example.com/signed/img-1.png?download",
			},
		],
		...over,
	};
}

function renderSettings() {
	return render(
		<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	setSettings();
	queryData.subscribers = { subscribers: [] };
	queryData.sends = { sends: [], total: 0 };
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
	queryData.environments = [
		{ id: "env-1", name: "Staging", type: "STAGING" },
	];
	approveSpy.mockResolvedValue({ outcome: "approved", notice: null });
});

describe("ProjectNewsletterSettings — Images in highlights setting", () => {
	it("saves screenshotsEnabled when the switch is turned on", () => {
		renderSettings();

		fireEvent.click(
			screen.getByRole("switch", { name: "Images in highlights" }),
		);

		expect(mutateSpy).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			screenshotsEnabled: true,
		});
	});

	it("explains that images need review when review is off and nothing is captured", () => {
		setSettings({ screenshotsEnabled: true, requireApproval: false });
		renderSettings();

		expect(
			screen.getByText("Turn on review to add images yourself."),
		).toBeInTheDocument();
	});

	it("says captured screenshots go out without review when review is off", () => {
		setSettings({
			screenshotsEnabled: true,
			requireApproval: false,
			screenshotEnvironmentId: "env-1",
		});
		renderSettings();

		expect(
			screen.getByText(
				"Review is off, so screenshots are captured and sent without review.",
			),
		).toBeInTheDocument();
	});

	it("shows no review hint while review is on", () => {
		setSettings({
			screenshotsEnabled: true,
			requireApproval: true,
			screenshotEnvironmentId: "env-1",
		});
		renderSettings();

		expect(
			screen.queryByText(/Turn on review to add images/),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/captured and sent without review/),
		).not.toBeInTheDocument();
	});

	it("hides the capture environment while images are off", () => {
		renderSettings();

		expect(screen.queryByText("Capture from")).not.toBeInTheDocument();
	});
});

describe("ProjectNewsletterSettings — reviewing a send", () => {
	it("keeps the inline checklist for a send that takes no images", () => {
		queryData.pending = {
			sends: [pendingSend({ screenshotsEnabled: false, images: [] })],
		};
		renderSettings();

		expect(
			screen.getByRole("checkbox", { name: "Include Faster search" }),
		).toBeChecked();
		expect(
			screen.getByRole("button", { name: "Approve & send" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Review" }),
		).not.toBeInTheDocument();
	});

	it("shows a compact row for a send that takes images", () => {
		queryData.pending = { sends: [pendingSend()] };
		renderSettings();

		expect(screen.getByText("2 highlights · 1 image")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Review" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "Include Faster search" }),
		).not.toBeInTheDocument();
	});

	it("opens the review dialog with fresh image URLs", () => {
		queryData.pending = { sends: [pendingSend()] };
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Review" }));

		expect(refetchSpy).toHaveBeenCalled();
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText(
				"Tick what should go out. Drag to change the order within a release.",
			),
		).toBeInTheDocument();
		expect(within(dialog).getByText("v2.1.0")).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", {
				name: "Open image: Search results page",
			}),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", {
				name: "Reorder Faster search",
			}),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText("1 of 1 image included"),
		).toBeInTheDocument();
	});

	it("approves with the removed highlights and the reviewer's order", () => {
		queryData.pending = { sends: [pendingSend()] };
		renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const dialog = screen.getByRole("dialog");

		fireEvent.click(
			within(dialog).getByRole("checkbox", {
				name: "Include New dashboard",
			}),
		);
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Approve & send with 1 image",
			}),
		);

		expect(approveSpy).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			sendId: "send-1",
			removedHighlightIndexes: [1],
			highlightOrder: [0, 1],
		});
	});

	it("labels approval as text-only once the only image's highlight is left out", () => {
		queryData.pending = { sends: [pendingSend()] };
		renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const dialog = screen.getByRole("dialog");

		fireEvent.click(
			within(dialog).getByRole("checkbox", {
				name: "Include Faster search",
			}),
		);

		expect(
			within(dialog).getByRole("button", {
				name: "Approve & send as text",
			}),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", {
				name: "Open image: Search results page",
			}),
		).not.toBeInTheDocument();
	});
});
