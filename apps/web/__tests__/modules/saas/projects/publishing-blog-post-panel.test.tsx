import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Blog Post generation panel (Fizzy #1853, Phase 2B-3).
 *
 * Assertions are on ROLES and TEXT, never on classes: what this panel owes a
 * reader is that the saved draft is editable, that an unadopted version is
 * offered rather than applied, and that the controls a viewer must not have are
 * absent — none of which a class name can prove.
 */

const mutate = vi.hoisted(() => ({
	generate: vi.fn(),
	adopt: vi.fn(),
	saveBody: vi.fn(),
	invalidate: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	confirm: vi.fn(() => true),
}));

/** Captures each mutation's options so `onSuccess` can be driven directly. */
const captured = vi.hoisted(
	() => ({}) as Record<string, Record<string, Function>>,
);

vi.mock("sonner", () => ({
	toast: {
		info: mutate.toastInfo,
		error: mutate.toastError,
		success: mutate.toastSuccess,
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: mutate.invalidate }),
	useMutation: (
		opts: { mutationKey: string[] } & Record<string, Function>,
	) => {
		const key = opts.mutationKey[0];
		captured[key] = opts;
		const byKey: Record<string, ReturnType<typeof vi.fn>> = {
			generateBlogPost: mutate.generate,
			adoptBlogPostDraft: mutate.adopt,
			saveBlogPostBody: mutate.saveBody,
		};
		return { mutate: byKey[key], isPending: false };
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const m = (procedure: string) => ({
		mutationOptions: (opts: Record<string, unknown>) => ({
			mutationKey: [procedure],
			...opts,
		}),
	});
	return {
		orpc: {
			projects: {
				publishingSuite: {
					listTopicDrafts: {
						queryKey: ({ input }: { input?: unknown }) => [
							"listTopicDrafts",
							input,
						],
					},
					generateBlogPost: m("generateBlogPost"),
					adoptBlogPostDraft: m("adoptBlogPostDraft"),
					saveBlogPostBody: m("saveBlogPostBody"),
				},
			},
		},
	};
});

import { BlogPostPanel } from "@saas/projects/components/publishing-suite/BlogPostPanel";

const DOCUMENT = {
	title: "Faster incremental builds",
	subtitle: "How a warm cache changed the inner loop",
	body: "## Why this matters\n\nBuilds used to start cold.",
	categories: ["Toolchain"],
	keywords: ["ci-pipeline"],
	inputsNeeded: ["Adoption numbers for the rollout"],
	safetyNote: "Generalized the customer reference.",
};

const SAVED_AT = new Date("2026-09-01T12:00:00Z");

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "BLOG_POST" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "BLOG_POST" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "BLOG_POST" as const,
		hasBody: true,
		body: "# Faster incremental builds\n\nBuilds used to start cold.",
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		updatedAt: SAVED_AT,
		...over,
	};
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(
		<BlogPostPanel
			projectId="p1"
			organizationId="org1"
			topicId="t1"
			draft={null}
			working={null}
			canEdit={true}
			{...(over as never)}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(captured)) {
		delete captured[k];
	}
	vi.stubGlobal("confirm", mutate.confirm);
	mutate.confirm.mockReturnValue(true);
});

describe("BlogPostPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate blog post/i }),
		).toBeEnabled();
	});

	it("switches to Regenerate once a draft exists", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
	});

	it("stays enabled for a STRANDED run, which nothing else can free", () => {
		// The only code that reclaims a stranded row runs inside the NEXT
		// attempt, so disabling here would lock the tab permanently.
		const draft = readyDraft();
		renderPanel({
			draft: {
				...draft,
				latestAttempt: {
					...draft.latestAttempt,
					status: "GENERATING",
					isExpired: true,
				},
				latestReady: null,
			},
		});

		expect(
			screen.getByRole("button", { name: /generate blog post/i }),
		).toBeEnabled();
	});

	it("says a regeneration leaves saved work alone", () => {
		// FR35 is structural, but the reader has to be told, or the button
		// reads like it might overwrite an hour of editing.
		renderPanel({ draft: readyDraft(), working: working() });

		expect(
			screen.getByText(/blog post you have saved is not affected/i),
		).toBeInTheDocument();
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateBlogPost.onSuccess?.({
			started: false,
			reason: "unavailable",
		});

		expect(mutate.toastInfo).toHaveBeenCalled();
		expect(mutate.toastError).not.toHaveBeenCalled();
	});
});

describe("BlogPostPanel — the editor (FR21)", () => {
	it("shows the saved draft in an editable field", () => {
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		expect(box).toHaveValue(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
	});

	it("keeps Save disabled until something actually changes", () => {
		renderPanel({ working: working() });

		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeDisabled();
	});

	it("sends the edited text with the version it was edited from", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.clear(box);
		await user.type(box, "Rewritten.");
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(mutate.saveBody).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Rewritten.",
				expectedUpdatedAt: SAVED_AT,
			}),
		);
	});

	it("KEEPS the reader's text when the save loses a race", async () => {
		// Discarding it would lose work that no refresh brings back. The
		// message tells them to copy it first.
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.clear(box);
		await user.type(box, "Rewritten.");

		captured.saveBlogPostBody.onError?.({ code: "CONFLICT" });

		expect(box).toHaveValue("Rewritten.");
		expect(mutate.invalidate).not.toHaveBeenCalled();
	});

	it("offers a way back after an edit the reader does not want", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.type(box, " extra");
		await user.click(
			screen.getByRole("button", { name: /discard changes/i }),
		);

		expect(box).toHaveValue(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
	});

	it("marks unsaved work so a reader does not navigate away over it", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.type(
			screen.getByRole("textbox", { name: /working blog post/i }),
			" extra",
		);

		expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
	});
});

describe("BlogPostPanel — adopting a later version (FR34/FR35)", () => {
	it("offers the generated version when it is not the saved one", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.getByRole("button", { name: /use this version/i }),
		).toBeEnabled();
	});

	it("does NOT offer it when the saved draft already came from it", () => {
		// Otherwise every reader is invited to re-adopt what they already have.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.queryByRole("button", { name: /use this version/i }),
		).not.toBeInTheDocument();
	});

	it("warns about unsaved edits, which adopting destroys", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.type(
			screen.getByRole("textbox", { name: /working blog post/i }),
			" extra",
		);
		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.confirm).toHaveBeenCalledWith(
			expect.stringMatching(/unsaved edits/i),
		);
	});

	it("does not adopt when the reader declines the confirmation", async () => {
		const user = userEvent.setup();
		mutate.confirm.mockReturnValue(false);
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.adopt).not.toHaveBeenCalled();
	});

	it("sends the version the tab last saw, so a lost race is detected", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.adopt).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d2",
				expectedUpdatedAt: SAVED_AT,
			}),
		);
	});

	it("sends an updatedAt for a row whose body is blank, not null", async () => {
		// The row exists and has an `updatedAt` the server compares against.
		// Sending null would report every such save as stale.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ hasBody: false, body: "", sourceDraftId: null }),
		});

		await user.click(
			screen.getByRole("button", { name: /save as working draft/i }),
		);

		expect(mutate.adopt).toHaveBeenCalledWith(
			expect.objectContaining({ expectedUpdatedAt: SAVED_AT }),
		);
	});
});

describe("BlogPostPanel — what a viewer sees", () => {
	it("gives a viewer the text but no editor and no controls", () => {
		// PR2.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		// Twice over: once as the read-only saved draft, once in the generated
		// version below it. `getAllBy` rather than `getBy` because both are
		// correct — a viewer is entitled to read either.
		expect(
			screen.getAllByText(/Builds used to start cold/).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByRole("textbox", { name: /working blog post/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /generate|use this version/i,
			}),
		).not.toBeInTheDocument();
	});
});

describe("BlogPostPanel — the generated document", () => {
	it("shows the publishing suggestions beside the post, not inside it", () => {
		// The whole reason the prompt returns them as fields.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.getByText(/suggested categories/i)).toBeInTheDocument();
		expect(screen.getByText("Toolchain")).toBeInTheDocument();
		expect(screen.getByText(/suggested keywords/i)).toBeInTheDocument();

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		expect(box).not.toHaveValue(expect.stringContaining("Toolchain"));
	});

	it("surfaces what the draft still needs (FR29)", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText("Adoption numbers for the rollout"),
		).toBeInTheDocument();
	});

	it("says when the draft was generalized rather than asserted", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
	});

	it("degrades to an empty state on a document shape it cannot read", () => {
		// `content` is a JSON column. A panel that throws takes the whole Topic
		// Item Page down with it.
		renderPanel({ draft: readyDraft({ options: [{ label: "Direct" }] }) });

		expect(screen.getByText(/no blog post draft yet/i)).toBeInTheDocument();
	});

	it("shows the failure reason rather than an empty tab", () => {
		const draft = readyDraft();
		renderPanel({
			draft: {
				...draft,
				latestAttempt: {
					...draft.latestAttempt,
					status: "FAILED",
					error: "The provider timed out.",
				},
				latestReady: null,
			},
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The provider timed out.",
		);
	});
});
