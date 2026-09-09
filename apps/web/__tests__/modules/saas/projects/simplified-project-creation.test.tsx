/**
 * Component tests for `SimplifiedProjectCreationForm` (Fizzy #2247).
 *
 * The form replaces the five-step wizard when SIMPLIFIED_PROJECT_CREATION is
 * on. Three things are worth pinning, because each one is a way the change
 * could silently destroy a user's data or their work:
 *
 *  (a) The description floor. The wizard's live predicate is
 *      `trim().length > MIN_DESCRIPTION_LENGTH`, so the effective floor is 51
 *      characters, not 50. Porting it as `>=` would re-open the gap #2165
 *      closed, and no other test in the repo pins the boundary.
 *  (b) Resuming a DRAFT submits through `projects.update`, never
 *      `projects.create({ draftKey })`. Create's activation branch writes
 *      `techStack: input.techStack || []` (and the same for features,
 *      projectTypes and tags), so a four-field payload would blank whatever a
 *      draft abandoned in the old wizard had saved.
 *  (c) A resumed DRAFT autosaves under the draftKey already on the row, and a
 *      draft that has none (written by the v1 API or the agent tool) does not
 *      autosave at all. Minting a fresh key in either case would upsert a
 *      SECOND draft beside the one being resumed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills (Radix Select needs these) ───────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const {
	createProjectMock,
	updateProjectMock,
	saveDraftMock,
	projectGetMock,
	listDraftsMock,
	checkNameMock,
	pushMock,
} = vi.hoisted(() => ({
	createProjectMock: vi.fn(),
	updateProjectMock: vi.fn(),
	saveDraftMock: vi.fn(),
	projectGetMock: vi.fn(),
	listDraftsMock: vi.fn(),
	checkNameMock: vi.fn(),
	pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/projects/new",
	useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			create: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async (input: unknown) =>
						createProjectMock(input),
					...opts,
				}),
			},
			update: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async (input: unknown) =>
						updateProjectMock(input),
					...opts,
				}),
			},
			saveDraft: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async (input: unknown) => saveDraftMock(input),
					...opts,
				}),
			},
			listDrafts: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.listDrafts", input] as const,
					queryFn: () => listDraftsMock(input),
				}),
			},
			get: {
				call: (input: unknown) => projectGetMock(input),
			},
			checkName: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.checkName", input] as const,
					queryFn: () => checkNameMock(input),
				}),
			},
		},
	},
}));

import { SimplifiedProjectCreationForm } from "@saas/projects/components/SimplifiedProjectCreationForm";

function renderForm(props: { projectId?: string } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<SimplifiedProjectCreationForm
				organizationId="org_1"
				projectId={props.projectId}
			/>
		</QueryClientProvider>,
	);
}

/** 51 characters — one past the floor, so it is accepted. */
const BRIEF_51 = "x".repeat(51);
/** 50 characters — exactly the threshold, so it is rejected. */
const BRIEF_50 = "x".repeat(50);

function tomorrowIso(): string {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	return d.toLocaleDateString("en-CA");
}

async function chooseDevelopmentPhase(
	user: ReturnType<typeof userEvent.setup>,
) {
	await user.click(screen.getByTestId("simplified-project-phase"));
	await user.click(
		await screen.findByRole("option", { name: /Development \/ Execution/ }),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	createProjectMock.mockResolvedValue({ project: { id: "proj_new" } });
	updateProjectMock.mockResolvedValue({ project: { id: "proj_draft" } });
	saveDraftMock.mockResolvedValue({
		created: true,
		project: { id: "proj_draft", draftKey: "key" },
	});
	listDraftsMock.mockResolvedValue({ drafts: [] });
	checkNameMock.mockResolvedValue({ available: true });
});

describe("SimplifiedProjectCreationForm — the fields it asks for", () => {
	it("asks for the start date only while the project is in Discovery", async () => {
		const user = userEvent.setup();
		renderForm();

		expect(
			screen.queryByTestId("simplified-expected-dev-start"),
		).not.toBeInTheDocument();

		await user.click(screen.getByTestId("simplified-project-phase"));
		await user.click(
			await screen.findByRole("option", {
				name: /Discovery \/ Planning/,
			}),
		);

		expect(
			await screen.findByTestId("simplified-expected-dev-start"),
		).toBeInTheDocument();
	});

	// The card's Data Rules say only "non-empty", but creation has enforced a
	// real floor since #2165 so the readiness checklist and the form agree
	// about what counts as a brief. The boundary is the whole assertion.
	it("rejects a 50-character brief and accepts a 51-character one", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await chooseDevelopmentPhase(user);

		const description = screen.getByTestId(
			"simplified-project-description",
		);
		await user.clear(description);
		await user.type(description, BRIEF_50);

		await waitFor(() => {
			expect(
				screen.getByTestId("simplified-create-project"),
			).toBeDisabled();
		});

		await user.type(description, "x");

		await waitFor(() => {
			expect(
				screen.getByTestId("simplified-create-project"),
			).toBeEnabled();
		});
	});

	// FR11: the picker's `min` stops the calendar offering a past day, but a
	// typed one still gets through, and a start date already in the past would
	// immediately un-quiet the codebase items the date exists to quiet.
	it("holds a Discovery project until it has a future start date", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await user.type(
			screen.getByTestId("simplified-project-description"),
			BRIEF_51,
		);
		await user.click(screen.getByTestId("simplified-project-phase"));
		await user.click(
			await screen.findByRole("option", {
				name: /Discovery \/ Planning/,
			}),
		);

		// No date yet.
		expect(screen.getByTestId("simplified-create-project")).toBeDisabled();

		const dateInput = await screen.findByTestId(
			"simplified-expected-dev-start",
		);
		expect(dateInput).toHaveAttribute(
			"min",
			new Date().toLocaleDateString("en-CA"),
		);

		await user.type(dateInput, "2020-01-01");
		await waitFor(() => {
			expect(
				screen.getByTestId("simplified-create-project"),
			).toBeDisabled();
		});

		await user.clear(dateInput);
		await user.type(dateInput, tomorrowIso());
		await waitFor(() => {
			expect(
				screen.getByTestId("simplified-create-project"),
			).toBeEnabled();
		});
	});

	it("will not submit without a phase", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await user.type(
			screen.getByTestId("simplified-project-description"),
			BRIEF_51,
		);

		expect(screen.getByTestId("simplified-create-project")).toBeDisabled();
	});
});

describe("SimplifiedProjectCreationForm — creating a new project", () => {
	it("creates the project and generates nothing", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await user.type(
			screen.getByTestId("simplified-project-description"),
			BRIEF_51,
		);
		await chooseDevelopmentPhase(user);
		await user.click(screen.getByTestId("simplified-create-project"));

		await waitFor(() => {
			expect(createProjectMock).toHaveBeenCalledTimes(1);
		});

		const payload = createProjectMock.mock.calls[0]?.[0];
		expect(payload).toMatchObject({
			name: "Portal",
			projectPhase: "DEVELOPMENT_EXECUTION",
			organizationId: "org_1",
		});
		// A Development project has no expected start date to give.
		expect(payload.expectedDevelopmentStartDate).toBeUndefined();
		// The four fields on the form and nothing that would start a job:
		// no repository, no backlog, no document selection or prompts.
		expect(payload).not.toHaveProperty("selectedDocumentTypes");
		expect(payload).not.toHaveProperty("documentPrompts");
		expect(payload).not.toHaveProperty("repositoryUrl");

		// Lands on the project, where the readiness checklist takes over.
		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/proj_new",
		);
	});

	// The form autosaves a DRAFT as the user types, so the create call must
	// activate that row rather than leaving it behind as a second project.
	it("submits the draftKey it has been autosaving under", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await user.type(
			screen.getByTestId("simplified-project-description"),
			BRIEF_51,
		);
		await chooseDevelopmentPhase(user);

		await waitFor(() => {
			expect(saveDraftMock).toHaveBeenCalled();
		});
		const autosavedKey = saveDraftMock.mock.calls[0]?.[0]?.draftKey;
		expect(autosavedKey).toBeTruthy();

		await user.click(screen.getByTestId("simplified-create-project"));

		await waitFor(() => {
			expect(createProjectMock).toHaveBeenCalledTimes(1);
		});
		expect(createProjectMock.mock.calls[0]?.[0]?.draftKey).toBe(
			autosavedKey,
		);
	});

	// The autosave must not skip a save because a previous one is still in
	// flight: the debounce fires only on a CHANGE, so a dropped save is never
	// retried and the edit is lost the moment the tab closes. Asserting that
	// saveDraft was called at all would not catch it — the assertion has to be
	// that the LAST call carries the final text.
	it("sends the last edit even when saves overlap", async () => {
		const user = userEvent.setup();
		// Never resolves, so every save after the first one overlaps it.
		saveDraftMock.mockImplementation(() => new Promise(() => {}));
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await waitFor(() => {
			expect(saveDraftMock).toHaveBeenCalled();
		});

		await user.type(
			screen.getByTestId("simplified-project-name"),
			" rewrite",
		);

		await waitFor(() => {
			const calls = saveDraftMock.mock.calls;
			expect(calls[calls.length - 1]?.[0]?.name).toBe("Portal rewrite");
		});
	});

	// FR34: neither field was persisted to a draft before this change, so a
	// draft resumed after a browser restart lost the two fields the form makes
	// required.
	it("persists the phase and start date to the draft", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.type(
			screen.getByTestId("simplified-project-name"),
			"Portal",
		);
		await chooseDevelopmentPhase(user);

		await waitFor(() => {
			expect(saveDraftMock).toHaveBeenCalled();
		});
		const lastCall =
			saveDraftMock.mock.calls[saveDraftMock.mock.calls.length - 1]?.[0];
		expect(lastCall).toMatchObject({
			projectPhase: "DEVELOPMENT_EXECUTION",
			// Cleared rather than left stale — a Development project has no
			// expected start date.
			expectedDevelopmentStartDate: null,
		});
	});
});

describe("SimplifiedProjectCreationForm — resuming a draft", () => {
	const draft = {
		project: {
			id: "proj_draft",
			name: "Half-finished",
			description: BRIEF_51,
			status: "DRAFT",
			draftKey: "draft-key-from-server",
			projectPhase: "DEVELOPMENT_EXECUTION",
			expectedDevelopmentStartDate: null,
		},
	};

	it("prepopulates from the saved draft", async () => {
		projectGetMock.mockResolvedValue(draft);
		renderForm({ projectId: "proj_draft" });

		await waitFor(() => {
			expect(screen.getByTestId("simplified-project-name")).toHaveValue(
				"Half-finished",
			);
		});
		expect(
			screen.getByTestId("simplified-project-description"),
		).toHaveValue(BRIEF_51);
	});

	// The load-bearing assertion. `projects.create({ draftKey })` would take
	// the activation branch, which writes `techStack: input.techStack || []`
	// and blanks the arrays a draft abandoned at the old step 2/3 had saved.
	it("activates through update, never through create", async () => {
		const user = userEvent.setup();
		projectGetMock.mockResolvedValue(draft);
		renderForm({ projectId: "proj_draft" });

		await waitFor(() => {
			expect(screen.getByTestId("simplified-project-name")).toHaveValue(
				"Half-finished",
			);
		});

		await user.click(screen.getByTestId("simplified-create-project"));

		await waitFor(() => {
			expect(updateProjectMock).toHaveBeenCalledTimes(1);
		});
		expect(createProjectMock).not.toHaveBeenCalled();
		expect(updateProjectMock.mock.calls[0]?.[0]).toMatchObject({
			id: "proj_draft",
			status: "ACTIVE",
		});
		// Absent, not empty — Prisma ignores `undefined`, so whatever the draft
		// had saved survives activation.
		const payload = updateProjectMock.mock.calls[0]?.[0];
		expect(payload).not.toHaveProperty("techStack");
		expect(payload).not.toHaveProperty("features");
		expect(payload).not.toHaveProperty("projectTypes");
	});

	it("autosaves under the draftKey already on the row", async () => {
		const user = userEvent.setup();
		projectGetMock.mockResolvedValue(draft);
		renderForm({ projectId: "proj_draft" });

		await waitFor(() => {
			expect(screen.getByTestId("simplified-project-name")).toHaveValue(
				"Half-finished",
			);
		});

		await user.type(screen.getByTestId("simplified-project-name"), " v2");

		await waitFor(() => {
			expect(saveDraftMock).toHaveBeenCalled();
		});
		for (const call of saveDraftMock.mock.calls) {
			expect(call[0].draftKey).toBe("draft-key-from-server");
		}
	});

	// A DRAFT written by the v1 API or the agent tool has no draftKey. Minting
	// one here would upsert a second draft beside the one being resumed; the
	// row still activates through `update`, so nothing is lost by not saving.
	it("does not autosave a draft that has no draftKey", async () => {
		const user = userEvent.setup();
		projectGetMock.mockResolvedValue({
			project: { ...draft.project, draftKey: null },
		});
		renderForm({ projectId: "proj_draft" });

		await waitFor(() => {
			expect(screen.getByTestId("simplified-project-name")).toHaveValue(
				"Half-finished",
			);
		});

		await user.type(screen.getByTestId("simplified-project-name"), " v2");
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(saveDraftMock).not.toHaveBeenCalled();

		await user.click(screen.getByTestId("simplified-create-project"));
		await waitFor(() => {
			expect(updateProjectMock).toHaveBeenCalledTimes(1);
		});
	});
});
