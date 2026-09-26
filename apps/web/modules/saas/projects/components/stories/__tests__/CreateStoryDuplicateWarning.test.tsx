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

function interpolate(template: string, params?: Record<string, unknown>) {
	if (!params) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
		params[k] !== undefined ? String(params[k]) : `{${k}}`,
	);
}

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, params?: Record<string, unknown>) =>
		interpolate(EN[key as keyof typeof EN] ?? key, params),
	useLocale: () => "en",
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

const previewEnrichment = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				previewEnrichment: (...args: unknown[]) =>
					previewEnrichment(...args),
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

const MATCH: DuplicateWarningResult = {
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
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onBack, onCreateAnyway, onEnriched };
}

beforeEach(() => {
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
