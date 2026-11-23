/**
 * A re-routed item's merge preview is read only while the item is open.
 * Once it is applied, the ticket holds what was written, and a merge into
 * the ticket as it is now would show text the ticket does not have.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ProposalRoutingControl,
	type RoutingAnnotation,
	type RoutingOverride,
} from "../ProposalRoutingControl";

const h = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				board: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.board", opts],
						queryFn: async () => ({ statuses: [], stories: [] }),
					}),
				},
				previewEnrichment: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.previewEnrichment", opts],
						queryFn: h.preview,
					}),
				},
			},
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/example-org",
}));

const ROUTING: RoutingAnnotation = {
	decision: "create",
	confidence: 0.6,
	reasoning: "No close match on the roadmap.",
	proposedTitle: "Per-project notification digest",
	proposedDescription: "Send one digest per project.",
	alternatives: [],
};

const TO_TICKET_10: RoutingOverride = {
	decision: "enrich",
	target: {
		storyId: "story-10",
		identifier: "10",
		title: "Notification preferences per project",
		closed: false,
	},
};

function renderControl(resolved: boolean) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProposalRoutingControl
				routing={ROUTING}
				override={TO_TICKET_10}
				onOverrideChange={vi.fn()}
				projectId="example-project"
				organizationId="example-org"
				resolved={resolved}
				itemTitle="Per-project notification digest"
			/>
		</QueryClientProvider>,
	);
}

describe("ProposalRoutingControl merge preview", () => {
	it("previews the merge into the chosen ticket while the item is open", async () => {
		h.preview.mockResolvedValue({
			targetId: "story-10",
			targetIdentifier: "10",
			targetTitle: "Notification preferences per project",
			targetClosed: false,
			currentDescription: "Choose project notifications.",
			currentAcceptanceCriteria: "",
			currentPriority: "P3_LOW",
			currentSize: null,
			mergedDescription:
				"Choose project notifications.\nSend one digest per project.",
			mergedAcceptanceCriteria: "",
			fallbackUsed: false,
		});

		renderControl(false);

		await waitFor(() => expect(h.preview).toHaveBeenCalled());
	});

	it("previews no merge for an applied item", async () => {
		h.preview.mockClear();

		renderControl(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(h.preview).not.toHaveBeenCalled();
		expect(screen.queryByText(/Working out what would change/)).toBeNull();
	});
});
