/**
 * Render test for the newsletter approval-gate UI (Fizzy 1869, Task 10).
 *
 * `ProjectNewsletterSettings` fires many `useQuery`/`useMutation` calls
 * (settings, subscribers, sends, repo integrations, linked chat channels,
 * the new pending-approval list). Rather than standing up a full
 * `QueryClientProvider` and faking every procedure's network response
 * (mirroring `DocumentEditorPage.mention-org-context.test.tsx`'s approach
 * in this same directory), `@tanstack/react-query` itself is mocked: every
 * `useQuery` call resolves against a fixture keyed off the oRPC procedure
 * path baked into the mocked `orpc.*.queryOptions` call, and every
 * `useMutation` call returns an inert stub (this test never clicks
 * Approve/Reject — it only asserts the pending-review section renders).
 *
 * Scope: mock `orpc.newsletter.sends.pending` to return one draft with two
 * highlights and assert both highlight titles render alongside an
 * "Approve & send" button (per task brief Step 4).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { PENDING_SENDS } = vi.hoisted(() => ({
	PENDING_SENDS: [
		{
			id: "send-1",
			status: "PENDING_APPROVAL",
			content: {
				headline: "This week's release notes",
				intro: "Two changes shipped since the last send.",
				highlights: [
					{
						title: "Faster search",
						description: "Search results now load twice as fast.",
					},
					{
						title: "New dashboard",
						description: "A redesigned project overview page.",
					},
				],
			},
		},
	],
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[] }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (procedure === "newsletter.sends.pending") {
			return {
				data: { sends: PENDING_SENDS },
				isLoading: false,
				refetch: vi.fn(),
			};
		}
		return { data: undefined, isLoading: false, refetch: vi.fn() };
	},
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const queryOptions =
		(procedure: string) => (opts: { input?: unknown }) => ({
			queryKey: [procedure, opts?.input],
			queryFn: async () => undefined,
		});
	const mutationOptions = () => (opts: unknown) => opts;
	return {
		orpc: {
			newsletter: {
				settings: {
					get: {
						queryOptions: queryOptions("newsletter.settings.get"),
					},
					update: { mutationOptions: mutationOptions() },
					regenerateEmbedToken: {
						mutationOptions: mutationOptions(),
					},
				},
				subscribers: {
					list: {
						queryOptions: queryOptions(
							"newsletter.subscribers.list",
						),
					},
				},
				sends: {
					list: {
						queryOptions: queryOptions("newsletter.sends.list"),
					},
					pending: {
						queryOptions: queryOptions("newsletter.sends.pending"),
					},
					// Declared unconditionally by the component (the lazily
					// enabled per-channel chat delivery panel, Fizzy #2013), so
					// the stub must exist even though this test never expands a
					// history row.
					chatDeliveries: {
						queryOptions: queryOptions(
							"newsletter.sends.chatDeliveries",
						),
					},
				},
			},
			projects: {
				repositoryIntegrations: {
					list: {
						queryOptions: queryOptions(
							"projects.repositoryIntegrations.list",
						),
					},
				},
				teamsChannelMonitor: {
					listLinkedChannels: {
						queryOptions: queryOptions(
							"projects.teamsChannelMonitor.listLinkedChannels",
						),
					},
				},
				slackChannelMonitor: {
					listLinkedChannels: {
						queryOptions: queryOptions(
							"projects.slackChannelMonitor.listLinkedChannels",
						),
					},
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import { ProjectNewsletterSettings } from "@saas/projects/components/ProjectNewsletterSettings";

describe("ProjectNewsletterSettings — pending review section (Fizzy 1869)", () => {
	it("renders pending draft highlights and an Approve & send button", () => {
		render(
			<ProjectNewsletterSettings
				projectId="proj-1"
				organizationId={null}
			/>,
		);

		expect(screen.getByText("Faster search")).toBeInTheDocument();
		expect(screen.getByText("New dashboard")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Approve & send" }),
		).toBeInTheDocument();
	});

	it("selects every highlight by default and labels each checkbox 'Include' (Fizzy 1869)", () => {
		render(
			<ProjectNewsletterSettings
				projectId="proj-1"
				organizationId={null}
			/>,
		);

		// Highlights start selected (checkbox checked). Unchecking one is what
		// excludes it (and strikes it through) — the opposite of the original
		// "Remove"-labelled, unchecked-by-default control.
		const includeFaster = screen.getByRole("checkbox", {
			name: "Include Faster search",
		});
		const includeDashboard = screen.getByRole("checkbox", {
			name: "Include New dashboard",
		});
		expect(includeFaster).toBeChecked();
		expect(includeDashboard).toBeChecked();
	});
});
