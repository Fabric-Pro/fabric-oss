/**
 * BacklogChangeProposal — the Create-vs-Enrich routing row.
 *
 * Covers what the reviewer actually sees and can do:
 *  - the classification, the matched ticket and a confidence indicator on an
 *    enrichment row,
 *  - the Create/Enrich toggle, and Apply refusing to run while a row has been
 *    switched to Enrich with no target chosen,
 *  - a failed evaluation saying so rather than passing its fallback Create off
 *    as a considered decision,
 *  - rows from every other proposal source rendering exactly as before.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi
					.fn()
					.mockResolvedValue({ results: [] }),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi.fn(),
			},
		},
	},
}));

/** Lets one test close the system-matched ticket out from under the proposal. */
const storyStages: Record<string, string> = {
	"story-1": "READY",
	"story-2": "READY",
};

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				list: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.list", opts],
						queryFn: async () => ({
							statuses: [],
							stories: [
								{
									id: "story-1",
									identifier: "F-12",
									title: "Export throttling",
									draftingStage: storyStages["story-1"],
								},
								{
									id: "story-2",
									identifier: "F-20",
									title: "Bulk export UX",
									draftingStage: storyStages["story-2"],
								},
							],
						}),
					}),
				},
				previewEnrichment: {
					queryOptions: (opts: Record<string, unknown>) => ({
						queryKey: ["stories.previewEnrichment", opts],
						queryFn: async () => ({
							targetId: "story-2",
							targetIdentifier: "F-20",
							targetTitle: "Bulk export UX",
							targetClosed: false,
							currentDescription: "Bulk export needs work.",
							currentAcceptanceCriteria: "",
							mergedDescription:
								"Bulk export needs work.\n\nAlso rate limit it.",
							mergedAcceptanceCriteria: "",
							fallbackUsed: false,
						}),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/acme",
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
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

function enrichChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "update",
		existingId: "story-1",
		existingIdentifier: "F-12",
		title: { from: "Export throttling", to: "Export throttling" },
		description: {
			from: "Exports need a queue.",
			to: "Exports need a queue.\n\nAlso rate limit the endpoint.",
		},
		reasoning: "Same export throttling work.",
		sourceContext: "meeting_transcript",
		routing: {
			decision: "enrich",
			confidence: 0.91,
			matchedStoryId: "story-1",
			matchedIdentifier: "F-12",
			matchedTitle: "Export throttling",
			reasoning: "Same export throttling work.",
			proposedTitle: "Rate limit the export endpoint",
			proposedDescription: "Large exports lock the worker.",
			alternatives: [
				{
					storyId: "story-1",
					identifier: "F-12",
					title: "Export throttling",
					similarity: 0.91,
				},
			],
		},
		...overrides,
	};
}

function createChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Rate limit the export endpoint" },
		description: { to: "Large exports lock the worker." },
		reasoning: "Nothing similar in the backlog.",
		sourceContext: "meeting_transcript",
		routing: {
			decision: "create",
			confidence: 0.88,
			reasoning: "Nothing similar in the backlog.",
			proposedTitle: "Rate limit the export endpoint",
			proposedDescription: "Large exports lock the worker.",
			alternatives: [],
		},
		...overrides,
	};
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onApprove = vi.fn();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<BacklogChangeProposal
				summary="Captured from a meeting"
				contextSummary="Weekly planning"
				changes={props.changes ?? [enrichChange()]}
				hasPMTool={false}
				projectId="proj-1"
				organizationId="org-1"
				onApprove={onApprove}
				onReject={vi.fn()}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onApprove };
}

describe("BacklogChangeProposal — Create/Enrich routing row", () => {
	it("shows the matched ticket and a confidence indicator on an enrichment", () => {
		renderProposal();

		expect(screen.getByText(/High confidence/i)).toBeInTheDocument();
		// The matched ticket's identifier and title are both on the row.
		expect(screen.getAllByText(/F-12/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Export throttling/).length).toBeGreaterThan(
			0,
		);
	});

	it("offers a Create/Enrich toggle reflecting the system's decision", () => {
		renderProposal();

		const enrich = screen.getByRole("button", { name: "Enrich existing" });
		const create = screen.getByRole("button", { name: "New ticket" });
		expect(enrich).toHaveAttribute("aria-pressed", "true");
		expect(create).toHaveAttribute("aria-pressed", "false");
	});

	it("renders no routing control for a proposal source that has none", () => {
		renderProposal({
			changes: [
				{
					type: "feature",
					action: "create",
					title: { to: "Plain proposal" },
					reasoning: "",
					sourceContext: "teams_messages",
				},
			],
		});

		expect(
			screen.queryByRole("button", { name: "Enrich existing" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeEnabled();
	});

	it("blocks Apply when a row is switched to Enrich with no target chosen", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [createChange()] });

		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeEnabled();

		await user.click(
			screen.getByRole("button", { name: "Enrich existing" }),
		);

		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeDisabled();
		// Names the item, so a reviewer with a scrolled list (or no visual scan
		// at all) knows which row is holding up Apply.
		expect(
			screen.getByText(
				/Choose a ticket to enrich for "Rate limit the export endpoint" before applying/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Select the ticket to enrich before approving/i),
		).toBeInTheDocument();
	});

	it("re-enables Apply once the reviewer switches back to a new ticket", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [createChange()] });

		await user.click(
			screen.getByRole("button", { name: "Enrich existing" }),
		);
		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "New ticket" }));
		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeEnabled();
	});

	it("submits a create when the reviewer overrides an enrichment", async () => {
		const user = userEvent.setup();
		const { onApprove } = renderProposal();

		await user.click(screen.getByRole("button", { name: "New ticket" }));
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		expect(onApprove).toHaveBeenCalledOnce();
		const [approved] = onApprove.mock.calls[0] as [ChangeItem[]];
		expect(approved).toHaveLength(1);
		expect(approved[0].action).toBe("create");
		expect(approved[0].existingId).toBeUndefined();
		// The action item as captured, not the body merged for F-12.
		expect(approved[0].title.to).toBe("Rate limit the export endpoint");
		expect(approved[0].description?.to).toBe(
			"Large exports lock the worker.",
		);
	});

	it("drops the original target's badge and diff once the routing is overridden", async () => {
		const user = userEvent.setup();
		renderProposal();

		// Before the override, the row is an update against F-12 and says so.
		expect(screen.getByText(/Updates F-12/)).toBeInTheDocument();
		expect(screen.getByText(/^Description:$/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "New ticket" }));

		// Both described a ticket that is no longer the destination. Leaving
		// them up would show "Updates F-12" beside a control reading
		// "New ticket", and a diff of a body that will never be written.
		expect(screen.queryByText(/Updates F-12/)).not.toBeInTheDocument();
		expect(screen.queryByText(/^Description:$/)).not.toBeInTheDocument();
	});

	it("warns and blocks Apply when the matched ticket has been closed since the proposal was written", async () => {
		storyStages["story-1"] = "CLOSED";
		try {
			const user = userEvent.setup();
			renderProposal();

			// Routing never auto-targets a closed ticket, so this can only arise
			// from the team closing it between analysis and review — the one path
			// to a closed target that nobody chose.
			expect(
				await screen.findByText(/is closed or archived/i),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /Apply Selected/ }),
			).toBeDisabled();

			// …and it must survive a round trip through the toggle, which
			// rebuilds the target and previously reset the closed flag.
			await user.click(
				screen.getByRole("button", { name: "New ticket" }),
			);
			await user.click(
				screen.getByRole("button", { name: "Enrich existing" }),
			);

			expect(
				screen.getByText(/is closed or archived/i),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /Apply Selected/ }),
			).toBeDisabled();

			await user.click(
				screen.getByRole("button", { name: /Enrich it anyway/i }),
			);
			expect(
				screen.getByRole("button", { name: /Apply Selected/ }),
			).toBeEnabled();
		} finally {
			storyStages["story-1"] = "READY";
		}
	});

	it("stops claiming a row blocks Apply once that row is deselected", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [createChange()] });

		await user.click(
			screen.getByRole("button", { name: "Enrich existing" }),
		);
		expect(
			screen.getByRole("button", { name: /Apply Selected/ }),
		).toBeDisabled();

		// Deselecting removes the row from the gate, so its own red "fix this"
		// line must go too — otherwise the button says ready and the row says
		// not ready, at the same time.
		await user.click(
			screen.getByRole("checkbox", {
				name: /Rate limit the export endpoint/i,
			}),
		);

		expect(
			screen.queryByText(/Select the ticket to enrich before approving/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/Choose a ticket to enrich for/i),
		).not.toBeInTheDocument();
	});

	it("says the evaluation failed instead of passing the fallback off as a decision", () => {
		renderProposal({
			changes: [
				createChange({
					routing: {
						decision: "create",
						confidence: 0,
						error: "embedding outage",
						proposedTitle: "Rate limit the export endpoint",
					},
				}),
			],
		});

		expect(
			screen.getByText(/Could not check this against existing tickets/i),
		).toBeInTheDocument();
		// No confidence claim when nothing was actually evaluated.
		expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
	});
});

describe("BacklogChangeProposal — a rejected enrichment behaves like a create", () => {
	/**
	 * Rejecting a false-positive match applies the row as a CREATE, so it has to
	 * offer everything a create offers. The row's chrome used to key off the raw
	 * `change.action` — still "update" on a routed enrichment — so an overridden
	 * row silently skipped both the Bug/Feature choice and the work-item prompt
	 * that drafts a create's body. The false-positive path produced a worse
	 * ticket than simply creating one.
	 */
	it("hides the type selector while the row is still an enrichment", () => {
		renderProposal({ changes: [enrichChange()] });
		expect(
			screen.queryByRole("radiogroup", { name: /Work item type/ }),
		).not.toBeInTheDocument();
	});

	it("offers Bug/Feature once the reviewer rejects the match", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [enrichChange()] });

		await user.click(screen.getByRole("button", { name: "New ticket" }));

		const group = await screen.findByRole("radiogroup", {
			name: /Work item type/,
		});
		expect(
			within(group).getByRole("radio", { name: "Bug" }),
		).toBeInTheDocument();
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toBeInTheDocument();
	});

	it("shows the row as a create, not an update, once overridden", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [enrichChange()] });

		await user.click(screen.getByRole("button", { name: "New ticket" }));

		expect(screen.getByText("create")).toBeInTheDocument();
	});
});

describe("a rejected enrichment is drafted through the work-item prompt", () => {
	/**
	 * A create's body is drafted through the project's work-item prompt for the
	 * chosen kind. A rejected enrichment is applied as a create, so it must get
	 * the same treatment — otherwise the false-positive path ships the
	 * analyzer's raw captured text while every other create gets a drafted body,
	 * which is a worse ticket than simply creating one.
	 */
	it("drafts the body for the chosen kind once the match is rejected", async () => {
		const user = userEvent.setup();
		const { orpcClient } = await import(
			"../../../../../shared/lib/orpc-client"
		);
		const reformat = orpcClient.projects.stories
			.reformatProposalBody as unknown as ReturnType<typeof vi.fn>;
		reformat.mockReset();
		reformat.mockResolvedValue({
			kind: "BUG",
			description:
				"## Steps to Reproduce\n1. drafted by the project prompt",
			acceptanceCriteria: null,
			needsMoreInfo: false,
			aiDrafted: true,
		});

		renderProposal({ changes: [enrichChange()] });
		await user.click(screen.getByRole("button", { name: "New ticket" }));

		const group = await screen.findByRole("radiogroup", {
			name: /Work item type/,
		});
		await user.click(within(group).getByRole("radio", { name: "Bug" }));

		await waitFor(() => expect(reformat).toHaveBeenCalled());
		expect(reformat).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1", kind: "BUG" }),
		);
	});
});
