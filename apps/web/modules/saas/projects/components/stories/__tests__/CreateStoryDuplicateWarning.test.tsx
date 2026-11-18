/**
 * CreateStoryDuplicateWarning — the roadmap "Add" dialog's duplicate-warning
 * step (Fizzy #2180), shown in place of the create form when
 * `checkDuplicate` returns an "enrich" decision.
 *
 * Overrides the global next-intl passthrough mock with one that resolves the
 * REAL `projects.stories.create.duplicateWarning.*` English strings (mirrors
 * `AttachmentsField.test.tsx`'s pattern), so assertions match what a reviewer
 * actually reads rather than raw i18n keys.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const EN = {
	title: "This may already be tracked",
	body: "A similar work item may already exist. Review it below before creating a new one.",
	whichItem: "Which item is this about?",
	openInNewTab: "Open {identifier} in a new tab",
	workingOutChange: "Working out what would change on {identifier}…",
	previewError:
		"Could not preview this update. Try again, or create a new item instead.",
	targetClosed:
		"{identifier} is closed or archived. Adding to it changes an item the team has already finished.",
	fallbackUsed:
		"The description of {identifier} would be kept as-is — this detail could not be merged into it safely. Attachments will still be added.",
	fallbackUsedNothingToAdd:
		"The description of {identifier} would be kept as-is — this detail could not be merged into it safely, and there are no attachments to add.",
	descriptionLabel: "Description",
	acceptanceCriteriaLabel: "Acceptance criteria",
	back: "Back",
	createAnyway: "Create new anyway",
	addTo: "Add to {identifier}",
	updateTo: "Update {identifier}",
	updateError:
		"Could not update the item. Try again, or create a new one instead.",
};

/** `duplicateWarning.inbox.*`, the Proposal Inbox section. */
const EN_INBOX = {
	title: "Similar items waiting in the Proposal Inbox",
	body: "These items have not been reviewed yet. Nothing changes unless you choose an action.",
	similarity: "{percent}% similar",
	merge: "Merge into this proposal",
	mergeLabel: "Merge your text into the proposal item {title}",
	mergedToast:
		"Added your text to {title} in the Proposal Inbox. It is waiting for review.",
	mergeError:
		"Could not merge into this proposal item. It may have been reviewed already. Try again, or create a new item instead.",
	reject: "Move proposal item to Rejected",
	rejectLabel: "Move the proposal item {title} to Rejected",
	rejectedStatus:
		"Moved {title} to Rejected. You can restore it from the Rejected list.",
	rejectError:
		"Could not move this proposal item. It may have been reviewed already.",
};

const EN_INBOX_ONLY = {
	inboxOnlyTitle: "This may already be waiting for review",
	inboxOnlyBody:
		"Similar work is waiting in the Proposal Inbox. Review it below before creating a new item.",
};

function interpolate(template: string, params?: Record<string, unknown>) {
	if (!params) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
		params[k] !== undefined ? String(params[k]) : `{${k}}`,
	);
}

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace?: string) =>
		(key: string, params?: Record<string, unknown>) => {
			const strings: Record<string, string> = namespace?.endsWith(
				".inbox",
			)
				? EN_INBOX
				: { ...EN, ...EN_INBOX_ONLY };
			return interpolate(strings[key] ?? key, params);
		},
	useLocale: () => "en",
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

const previewEnrichment = vi.fn();
const mergeIntoItem = vi.fn();
const rejectItem = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				previewEnrichment: (...args: unknown[]) =>
					previewEnrichment(...args),
			},
			backlog: {
				proposals: {
					mergeIntoItem: (...args: unknown[]) =>
						mergeIntoItem(...args),
					rejectItem: (...args: unknown[]) => rejectItem(...args),
				},
			},
		},
	},
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
		warning: (...a: unknown[]) => toastWarning(...a),
	},
}));

import {
	CreateStoryDuplicateWarning,
	type DuplicateWarningResult,
} from "../CreateStoryDuplicateWarning";

const MATCH: Extract<DuplicateWarningResult, { decision: "enrich" }> = {
	decision: "enrich",
	confidence: 0.92,
	matchedStoryId: "story-1",
	matchedIdentifier: "F-12",
	matchedTitle: "Export throttling",
	reasoning: "Same export throttling work.",
	alternatives: [
		{
			storyId: "story-1",
			identifier: "F-12",
			title: "Export throttling",
			similarity: 0.91,
		},
	],
};

function makeFile(name: string): File {
	return new File([new Uint8Array(8)], name, { type: "image/png" });
}

function makeDeps(
	overrides?: Partial<{
		uploadStoryImage: ReturnType<typeof vi.fn>;
		uploadStoryAttachment: ReturnType<typeof vi.fn>;
		updateStoryMutateAsync: ReturnType<typeof vi.fn>;
	}>,
) {
	return {
		uploadStoryImage: overrides?.uploadStoryImage ?? vi.fn(),
		uploadStoryAttachment: overrides?.uploadStoryAttachment ?? vi.fn(),
		updateStoryMutateAsync:
			overrides?.updateStoryMutateAsync ??
			vi.fn().mockResolvedValue(undefined),
	};
}

function renderWarning(
	props: Partial<
		React.ComponentProps<typeof CreateStoryDuplicateWarning>
	> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const onBack = props.onBack ?? vi.fn();
	const onCreateAnyway = props.onCreateAnyway ?? vi.fn();
	const onEnriched = props.onEnriched ?? vi.fn();
	const onMergedIntoProposal = props.onMergedIntoProposal ?? vi.fn();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<CreateStoryDuplicateWarning
				result={props.result ?? MATCH}
				projectId="proj-1"
				organizationId={null}
				basePath="/app/org-1"
				description={
					props.description ?? "Large exports lock the worker."
				}
				files={props.files ?? []}
				docAttachments={props.docAttachments ?? []}
				deps={props.deps ?? makeDeps()}
				onBack={onBack}
				onCreateAnyway={onCreateAnyway}
				onEnriched={onEnriched}
				onMergedIntoProposal={onMergedIntoProposal}
			/>
		</QueryClientProvider>,
	);
	return {
		...utils,
		onBack,
		onCreateAnyway,
		onEnriched,
		onMergedIntoProposal,
	};
}

const INBOX_MATCH = {
	proposalId: "prop-1",
	changeIndex: 2,
	title: "Queue exports",
	summary: "Export follow-ups",
	source: "SLACK_CHANNEL",
	similarity: 0.923,
};

const INBOX_ONLY: DuplicateWarningResult = {
	decision: "create",
	proposalMatches: [INBOX_MATCH],
	storyCheckFailed: false,
};

beforeEach(() => {
	mergeIntoItem.mockReset();
	rejectItem.mockReset();
	previewEnrichment.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
	toastWarning.mockReset();
});

describe("CreateStoryDuplicateWarning", () => {
	it("renders the matched ticket, the confidence band, and the reasoning", () => {
		renderWarning();

		expect(
			screen.getByText("This may already be tracked"),
		).toBeInTheDocument();
		expect(screen.getAllByText(/F-12/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Export throttling/).length).toBeGreaterThan(
			0,
		);
		expect(screen.getByText("High confidence")).toBeInTheDocument();
		expect(
			screen.getByText("Same export throttling work."),
		).toBeInTheDocument();
	});

	it("has no obvious accessibility violations", async () => {
		const { container } = renderWarning();
		expect(await axe(container)).toHaveNoViolations();
	});

	it("Create new anyway calls onCreateAnyway and never previews or updates", async () => {
		const { onCreateAnyway } = renderWarning();

		await userEvent.click(
			screen.getByRole("button", { name: "Create new anyway" }),
		);

		expect(onCreateAnyway).toHaveBeenCalledOnce();
		expect(previewEnrichment).not.toHaveBeenCalled();
	});

	it("Back calls onBack", async () => {
		const { onBack } = renderWarning();

		await userEvent.click(screen.getByRole("button", { name: "Back" }));

		expect(onBack).toHaveBeenCalledOnce();
	});

	it("Add to <ID> previews the merge, then Update <ID> commits it and reports success", async () => {
		previewEnrichment.mockResolvedValue({
			targetId: "story-1",
			targetIdentifier: "F-12",
			targetTitle: "Export throttling",
			targetClosed: false,
			currentDescription: "Exports need a queue.",
			currentAcceptanceCriteria: "",
			mergedDescription:
				"Exports need a queue.\n\nAlso rate limit the endpoint.",
			mergedAcceptanceCriteria: "",
			fallbackUsed: false,
		});
		const updateStoryMutateAsync = vi.fn().mockResolvedValue(undefined);
		const { onEnriched } = renderWarning({
			deps: makeDeps({ updateStoryMutateAsync }),
		});

		await userEvent.click(
			screen.getByRole("button", { name: "Add to F-12" }),
		);

		await waitFor(() => {
			expect(previewEnrichment).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					targetStoryId: "story-1",
					proposedDescription: "Large exports lock the worker.",
				}),
			);
		});
		expect(
			await screen.findByRole("button", { name: "Update F-12" }),
		).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: "Update F-12" }),
		);

		await waitFor(() => {
			expect(updateStoryMutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					storyId: "story-1",
					description:
						"Exports need a queue.\n\nAlso rate limit the endpoint.",
				}),
			);
		});
		await waitFor(() => {
			expect(onEnriched).toHaveBeenCalledWith("story-1");
		});
	});

	it("disables Update and says there is nothing to add when the merge fell back with no attachments", async () => {
		previewEnrichment.mockResolvedValue({
			targetId: "story-1",
			targetIdentifier: "F-12",
			targetTitle: "Export throttling",
			targetClosed: false,
			currentDescription: "Exports need a queue.",
			currentAcceptanceCriteria: "",
			mergedDescription: "Exports need a queue.",
			mergedAcceptanceCriteria: "",
			fallbackUsed: true,
		});
		renderWarning({ files: [], docAttachments: [] });

		await userEvent.click(
			screen.getByRole("button", { name: "Add to F-12" }),
		);

		expect(
			await screen.findByText(/there are no attachments to add/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Update F-12" }),
		).toBeDisabled();
	});

	it("keeps Update enabled with the attachments copy when the merge fell back but attachments exist", async () => {
		previewEnrichment.mockResolvedValue({
			targetId: "story-1",
			targetIdentifier: "F-12",
			targetTitle: "Export throttling",
			targetClosed: false,
			currentDescription: "Exports need a queue.",
			currentAcceptanceCriteria: "",
			mergedDescription: "Exports need a queue.",
			mergedAcceptanceCriteria: "",
			fallbackUsed: true,
		});
		renderWarning({ files: [makeFile("diagram.png")] });

		await userEvent.click(
			screen.getByRole("button", { name: "Add to F-12" }),
		);

		expect(
			await screen.findByText(/Attachments will still be added/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Update F-12" }),
		).not.toBeDisabled();
	});

	it("a preview failure shows an inline error and never crashes the step", async () => {
		previewEnrichment.mockRejectedValue(new Error("network error"));
		renderWarning();

		await userEvent.click(
			screen.getByRole("button", { name: "Add to F-12" }),
		);

		expect(
			await screen.findByText(
				"Could not preview this update. Try again, or create a new item instead.",
			),
		).toBeInTheDocument();
	});

	it("choosing another alternative changes the preview target", async () => {
		const twoAlternatives: DuplicateWarningResult = {
			...MATCH,
			alternatives: [
				...MATCH.alternatives,
				{
					storyId: "story-2",
					identifier: "F-13",
					title: "Sign-in rate limiting",
					similarity: 0.8,
				},
			],
		};
		previewEnrichment.mockImplementation(
			async (input: { targetStoryId: string }) => ({
				targetId: input.targetStoryId,
				targetIdentifier:
					input.targetStoryId === "story-1" ? "F-12" : "F-13",
				targetTitle: "x",
				targetClosed: false,
				currentDescription: "current",
				currentAcceptanceCriteria: "",
				mergedDescription: "merged",
				mergedAcceptanceCriteria: "",
				fallbackUsed: false,
			}),
		);
		renderWarning({ result: twoAlternatives });

		const radiogroup = screen.getByRole("radiogroup");
		await userEvent.click(
			within(radiogroup).getByRole("radio", { name: /F-13/ }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Add to F-13" }),
		);

		await waitFor(() => {
			expect(previewEnrichment).toHaveBeenCalledWith(
				expect.objectContaining({ targetStoryId: "story-2" }),
			);
		});
	});
});

describe("CreateStoryDuplicateWarning — Proposal Inbox matches", () => {
	it("shows inbox matches with their similarity when no work item matched", () => {
		renderWarning({ result: INBOX_ONLY });

		expect(
			screen.getByText("This may already be waiting for review"),
		).toBeInTheDocument();
		const section = screen.getByRole("region", {
			name: "Similar items waiting in the Proposal Inbox",
		});
		expect(within(section).getByText("Queue exports")).toBeInTheDocument();
		expect(within(section).getByText("92% similar")).toBeInTheDocument();
		expect(
			within(section).getByText("Slack channel · Export follow-ups"),
		).toBeInTheDocument();
		expect(screen.queryByText("High confidence")).not.toBeInTheDocument();
	});

	it("has no obvious accessibility violations", async () => {
		const { container } = renderWarning({ result: INBOX_ONLY });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("shows the inbox matches under a matched work item", () => {
		renderWarning({ result: { ...MATCH, proposalMatches: [INBOX_MATCH] } });

		expect(
			screen.getByText("This may already be tracked"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("region", {
				name: "Similar items waiting in the Proposal Inbox",
			}),
		).toBeInTheDocument();
	});

	it("Create new anyway still creates, without touching the inbox", async () => {
		const { onCreateAnyway } = renderWarning({ result: INBOX_ONLY });

		await userEvent.click(
			screen.getByRole("button", { name: "Create new anyway" }),
		);

		expect(onCreateAnyway).toHaveBeenCalledOnce();
		expect(mergeIntoItem).not.toHaveBeenCalled();
		expect(rejectItem).not.toHaveBeenCalled();
	});

	it("merges the typed text into the chosen item and closes without creating", async () => {
		mergeIntoItem.mockResolvedValue({ id: "prop-1", changeIndex: 2 });
		const { onMergedIntoProposal, onCreateAnyway } = renderWarning({
			result: INBOX_ONLY,
			description: "Cap export size.",
		});

		await userEvent.click(
			screen.getByRole("button", {
				name: "Merge your text into the proposal item Queue exports",
			}),
		);

		await waitFor(() =>
			expect(onMergedIntoProposal).toHaveBeenCalledOnce(),
		);
		expect(mergeIntoItem).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			proposalId: "prop-1",
			changeIndex: 2,
			description: "Cap export size.",
		});
		expect(toastSuccess).toHaveBeenCalled();
		expect(onCreateAnyway).not.toHaveBeenCalled();
	});

	it("keeps the step open with an error when the merge is refused", async () => {
		mergeIntoItem.mockRejectedValue(new Error("conflict"));
		const { onMergedIntoProposal } = renderWarning({ result: INBOX_ONLY });

		await userEvent.click(
			screen.getByRole("button", {
				name: "Merge your text into the proposal item Queue exports",
			}),
		);

		expect(
			await screen.findByText(EN_INBOX.mergeError),
		).toBeInTheDocument();
		expect(onMergedIntoProposal).not.toHaveBeenCalled();
	});

	it("moves the inbox item to Rejected through the per-item procedure and drops it from the list", async () => {
		rejectItem.mockResolvedValue({ success: true, updated: true });
		renderWarning({ result: INBOX_ONLY });

		await userEvent.click(
			screen.getByRole("button", {
				name: "Move the proposal item Queue exports to Rejected",
			}),
		);

		expect(
			await screen.findByText(
				"Moved Queue exports to Rejected. You can restore it from the Rejected list.",
			),
		).toBeInTheDocument();
		expect(rejectItem).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			proposalId: "prop-1",
			changeIndex: 2,
		});
		expect(
			screen.queryByRole("button", {
				name: "Move the proposal item Queue exports to Rejected",
			}),
		).not.toBeInTheDocument();
	});
});
