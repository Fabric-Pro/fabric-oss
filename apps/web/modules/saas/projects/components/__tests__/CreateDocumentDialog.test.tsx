/**
 * Unit tests for the Documents tab's `CreateDocumentDialog` (U2 — dialog
 * restructure and AI availability).
 *
 * Scenarios, as pinned by the plan:
 *   - Covers AE7. With AI reported unavailable, no Generate with AI control
 *     renders and submitting with a title alone calls the create mutation.
 *   - With AI available, the Generate with AI control renders checked on first
 *     open.
 *   - While the availability check is unresolved the toggle row is pending and
 *     submit is disabled; it does not render as available and then disappear.
 *   - An errored availability check renders the same as unavailable.
 *   - Reopening the dialog after a cancel shows defaults, not the previous
 *     entry.
 *   - Submit stays disabled while the submit chain is in flight, and a second
 *     click does not fire a second mutation.
 *   - A user lacking document creation permission cannot reach the create
 *     action.
 *
 * Supplemented with two error paths the seven above leave open:
 *   - A whitespace-only title never reaches the mutation.
 *   - No user-facing string in the component is hardcoded (U2's verification
 *     line), guarded by a source scan in the shape the sibling story-dialog
 *     test uses.
 *
 * `next-intl` is mocked so `useTranslations` echoes the key — every assertion
 * below targets a KEY, not English copy, so re-wording the translation file
 * never breaks these tests.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getAiConfigStatus,
	createDocument,
	availablePrompts,
	bindPrompt,
	createUploadUrl,
	processFile,
	routerPush,
	toastLoading,
	toastSuccess,
	toastError,
	toastWarning,
} = vi.hoisted(() => ({
	getAiConfigStatus: vi.fn(),
	createDocument: vi.fn(),
	availablePrompts: vi.fn(),
	bindPrompt: vi.fn(),
	createUploadUrl: vi.fn(),
	processFile: vi.fn(),
	routerPush: vi.fn(),
	// Sonner exposes named functions on the `toast` object. Each named branch
	// is independently mockable so the id-upgrade idiom can be asserted across
	// toast types.
	toastLoading: vi.fn(() => "toast-id-1"),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => key;
		t.raw = (key: string) => key;
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: routerPush,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: {
				getStatus: (input: unknown) => getAiConfigStatus(input),
			},
		},
		// Binding a prompt as the type's default is a deliberate admin
		// action. Spied so the tests can assert this flow never triggers it.
		prompts: {
			bind: {
				set: (input: unknown) => bindPrompt(input),
			},
		},
		// The three-step upload the file route runs after the row is created.
		projects: {
			contexts: {
				createUploadUrl: (input: unknown) => createUploadUrl(input),
				processFile: (input: unknown) => processFile(input),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				create: {
					mutationOptions: () => ({
						mutationFn: (input: unknown) => createDocument(input),
					}),
				},
				list: {
					queryKey: ({ input }: { input: unknown }) => [
						"projects.documents.list",
						input,
					],
				},
			},
		},
		// The shared prompt selector fetches the prompts bound to the agent
		// for the selected document type. Returning an empty list keeps the
		// selector on its default-prompt placeholder, which is what these
		// tests care about — prompt resolution itself is the selector's own
		// test's job, not this dialog's.
		prompts: {
			agents: {
				available: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.agents.available", input],
						queryFn: () => availablePrompts(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		loading: (...args: unknown[]) => toastLoading(...args),
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
		warning: (...args: unknown[]) => toastWarning(...args),
	},
}));

import { CreateDocumentDialog } from "../CreateDocumentDialog";

type DialogProps = React.ComponentProps<typeof CreateDocumentDialog>;

function makeProps(overrides: Partial<DialogProps> = {}): DialogProps {
	return {
		projectId: "project-1",
		open: true,
		onOpenChange: vi.fn(),
		...overrides,
	};
}

function renderDialog(props: DialogProps = makeProps()) {
	// `retry: false` makes the errored-availability branch settle on the first
	// rejection instead of sitting in the retrying (still-pending) state.
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<CreateDocumentDialog {...props} />
		</QueryClientProvider>,
	);
	return {
		...utils,
		reopenWith: (next: DialogProps) =>
			utils.rerender(
				<QueryClientProvider client={client}>
					<CreateDocumentDialog {...next} />
				</QueryClientProvider>,
			),
	};
}

const aiAvailable = () => ({ isConfigured: true });
const aiUnavailable = () => ({ isConfigured: false });

describe("CreateDocumentDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		toastLoading.mockReturnValue("toast-id-1");
		createDocument.mockResolvedValue({
			document: { id: "doc-1" },
			generation: null,
			displacedActive: false,
			suppliedTextOutcome: null,
		});
		availablePrompts.mockResolvedValue({ prompts: [] });
	});

	it("covers AE7 — with AI unavailable no Generate with AI control renders and a title alone creates the document", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);

		// R25: the control is absent, not merely disabled.
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByText("generateWithAiLabel")).toBeNull();
		expect(screen.queryByLabelText("instructionsLabel")).toBeNull();

		// R27: a title alone is enough in a tenant that cannot generate.
		await user.clear(screen.getByLabelText("titleLabel"));
		await user.type(screen.getByLabelText("titleLabel"), "Payments brief");
		const submit = screen.getByRole("button", { name: "submit" });
		expect(submit).not.toBeDisabled();
		await user.click(submit);

		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument).toHaveBeenCalledWith({
			projectId: "project-1",
			title: "Payments brief",
			type: "GENERAL",
			generateWithAi: false,
			timeZone: expect.any(String),
		});
		// Still lands in the editor — this route exists so the user can write
		// the document themselves — but with no generate flag, because
		// nothing was dispatched.
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-1",
		);
	});

	it("renders the Generate with AI control checked on first open when AI is available", async () => {
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		// R5: on when the dialog opens — no click needed.
		const toggle = await screen.findByRole("checkbox");
		expect(toggle).toBeChecked();
		expect(screen.getByText("generateWithAiLabel")).toBeInTheDocument();
		expect(screen.getByLabelText("instructionsLabel")).toBeInTheDocument();
		expect(screen.queryByTestId("ai-unavailable-notice")).toBeNull();
		// The manual content field belongs to the AI-off path only.
		expect(screen.queryByLabelText("contentLabel")).toBeNull();
		expect(
			screen.getByRole("button", { name: "submitWithAi" }),
		).toBeInTheDocument();
	});

	it("renders the toggle row pending and disables submit while the availability check is unresolved", async () => {
		const user = userEvent.setup();
		// Never settles — the dialog must not guess an answer.
		getAiConfigStatus.mockImplementation(() => new Promise(() => {}));
		renderDialog();

		expect(
			screen.getByTestId("ai-availability-pending"),
		).toBeInTheDocument();
		expect(screen.getByText("aiAvailabilityPending")).toBeInTheDocument();

		// It must not render as available and then disappear: no checkbox now,
		// and none after a title has been typed and the tree re-rendered.
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByTestId("ai-unavailable-notice")).toBeNull();

		await user.type(screen.getByLabelText("titleLabel"), "Payments brief");
		expect(screen.queryByRole("checkbox")).toBeNull();

		// A valid title is not enough while the answer is unknown.
		expect(screen.getByRole("button", { name: "submit" })).toBeDisabled();
		expect(createDocument).not.toHaveBeenCalled();
	});

	it("treats an errored availability check exactly as unavailable", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockRejectedValue(new Error("status check failed"));
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByTestId("ai-availability-pending")).toBeNull();

		// Fails closed to the manual path rather than blocking creation.
		await user.type(screen.getByLabelText("titleLabel"), "Payments brief");
		await user.click(screen.getByRole("button", { name: "submit" }));

		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
	});

	it("shows defaults, not the previous entry, when reopened after a cancel", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		const onOpenChange = vi.fn();
		const { reopenWith } = renderDialog(makeProps({ onOpenChange }));

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);

		await user.clear(screen.getByLabelText("titleLabel"));
		await user.type(screen.getByLabelText("titleLabel"), "Abandoned draft");
		await user.type(
			screen.getByLabelText("contentLabel"),
			"Half-written notes",
		);
		await user.click(screen.getByRole("button", { name: "cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);

		// The parent owns `open`; drive it the way the parent would.
		reopenWith(makeProps({ open: false, onOpenChange }));
		reopenWith(makeProps({ open: true, onOpenChange }));

		await waitFor(() =>
			// Reset restores the type's default title, not an empty field —
			// the flow owns the title until the user makes it theirs (R1).
			expect(screen.getByLabelText("titleLabel")).toHaveValue(
				"General Document",
			),
		);
		expect(screen.getByLabelText("contentLabel")).toHaveValue("");
	});

	it("keeps submit disabled while the submit chain is in flight, and a second click fires no second mutation", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		let resolveCreate: (value: unknown) => void = () => {};
		createDocument.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCreate = resolve;
				}),
		);
		renderDialog();

		await screen.findByRole("checkbox");
		await user.clear(screen.getByLabelText("titleLabel"));
		await user.type(screen.getByLabelText("titleLabel"), "Payments brief");
		await user.type(
			screen.getByLabelText("instructionsLabel"),
			"Keep it short",
		);

		await user.click(screen.getByRole("button", { name: "submitWithAi" }));

		const submit = await screen.findByRole("button", {
			name: "submitting",
		});
		expect(submit).toBeDisabled();
		expect(toastLoading).toHaveBeenCalledWith("creating");

		// The mutation's own pending flag is not the only guard — the whole
		// chain (create + invalidate + navigate) holds the button.
		await user.click(submit);
		expect(createDocument).toHaveBeenCalledTimes(1);
		expect(createDocument).toHaveBeenCalledWith({
			projectId: "project-1",
			title: "Payments brief",
			type: "GENERAL",
			generateWithAi: true,
			prompt: "Keep it short",
			timeZone: expect.any(String),
		});

		await act(async () => {
			// A generation route, so the response carries the dispatch — that
			// is what the success copy branches on now, not the local toggle.
			resolveCreate({
				document: { id: "doc-1" },
				generation: { workflowId: "wf-1" },
				displacedActive: false,
				suppliedTextOutcome: null,
			});
		});

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("createdWithAi", {
			id: "toast-id-1",
		});
		expect(routerPush).toHaveBeenCalledTimes(1);
		// The server dispatched the run. Carrying the generate flag too would
		// make the editor fire a second, racing generation on mount.
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-1",
		);
	});

	it("does not let a user lacking document creation permission reach the create action", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		// The dialog's only create path is the permission-gated
		// `projects.documents.create` procedure, so a caller without the
		// document-create permission is refused there. The dialog must report
		// that refusal and produce nothing: no navigation, no close, no
		// success. (The server-side gate itself is asserted in the procedure's
		// own tests, not from the client.)
		createDocument.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const onOpenChange = vi.fn();
		renderDialog(makeProps({ onOpenChange }));

		await screen.findByRole("checkbox");
		await user.clear(screen.getByLabelText("titleLabel"));
		await user.type(screen.getByLabelText("titleLabel"), "Payments brief");
		await user.click(screen.getByRole("button", { name: "submitWithAi" }));

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		// The loading toast is upgraded in place via the sonner `{ id }` idiom.
		expect(toastError).toHaveBeenCalledWith("createFailed", {
			id: "toast-id-1",
		});
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		// Submit is released so the user is not stuck on a failed attempt.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).not.toBeDisabled(),
		);
	});

	it("never reaches the mutation with a whitespace-only title", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);

		await user.clear(screen.getByLabelText("titleLabel"));
		await user.type(screen.getByLabelText("titleLabel"), "   ");
		expect(screen.getByRole("button", { name: "submit" })).toBeDisabled();
		expect(createDocument).not.toHaveBeenCalled();
	});

	// ---- Source scan: no untranslated user-facing string ----
	//
	// U2's verification line requires that no user-facing string in the
	// component remains hardcoded. Comments are stripped first: the component's
	// own doc-comments legitimately name the controls they describe, and would
	// otherwise trip the scan.
	function stripComments(src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
	}

	it("carries no hardcoded user-facing copy", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(
			"modules/saas/projects/components/CreateDocumentDialog.tsx",
			"utf8",
		);
		const codeOnly = stripComments(src);

		// Every placeholder must come from the translator.
		expect(codeOnly).not.toMatch(/placeholder="/);
		// The literals this unit moved into `projects.documents.create`.
		for (const literal of [
			"Create Document",
			"Document Type",
			"Generate with AI",
			"AI Instructions",
			"Content (Optional)",
			"Create & Generate",
			"Creating...",
			"Failed to create document",
			"Document created successfully",
			"Please enter a document title",
		]) {
			expect(codeOnly).not.toContain(literal);
		}
	});

	// ── U3: the title follows the type until the user makes it their own ──
	//
	// "Edited" is derived, not a sticky flag: a field holding the type's own
	// label, or holding nothing, still belongs to the flow. That is the same
	// test the server applies for the one type with a dynamic default, and it
	// is what lets a cleared field re-arm instead of stranding the user.

	const pickType = async (
		user: ReturnType<typeof userEvent.setup>,
		name: RegExp,
	) => {
		await user.click(screen.getByRole("combobox", { name: /typeLabel/i }));
		await user.click(await screen.findByRole("option", { name }));
	};

	const titleField = () =>
		screen.getByLabelText(/titleLabel/i) as HTMLInputElement;

	it("covers AE1 — an untouched title follows the document type", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		expect(titleField().value).toBe("General Document");

		await pickType(user, /Technical Architecture/);
		expect(titleField().value).toBe("Technical Architecture");
	});

	it("covers AE1 — a title the user typed survives a type change", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await user.clear(titleField());
		await user.type(titleField(), "Payments rewrite");

		await pickType(user, /Technical Architecture/);
		expect(titleField().value).toBe("Payments rewrite");
	});

	it("covers AE1 — clearing the title re-arms the type default", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await user.clear(titleField());
		await user.type(titleField(), "Payments rewrite");
		await user.clear(titleField());

		await pickType(user, /Test Plan/);
		expect(titleField().value).toBe("Test Plan");
	});

	it("does not lock the title when the user types exactly the type default", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		// Retyping the same words the field already held must not be read as
		// a deliberate choice — otherwise the type would stop refreshing it.
		await user.clear(titleField());
		await user.type(titleField(), "General Document");

		await pickType(user, /Test Plan/);
		expect(titleField().value).toBe("Test Plan");
	});

	it("submits the title visible in the field, not the type default", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await pickType(user, /Test Plan/);
		await user.clear(titleField());
		await user.type(titleField(), "Release readiness");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			title: "Release readiness",
			type: "TEST_PLAN",
		});
	});

	// ── U5: source content, and how it is used ──
	//
	// Scenarios, as pinned by the plan:
	//   - Covers AE6. Pasting text shows the control defaulted to Use as
	//     Context; choosing Use As-Is turns the AI toggle off; re-enabling the
	//     AI toggle restores Use as Context; clearing the text hides the
	//     control and leaves the AI toggle on.
	//   - The source-content field and the instructions field are separately
	//     addressable and both reach the submit payload. Asserted per route,
	//     because the payload is still the pre-U7 single `content` field: the
	//     instructions carry it while generating, the pasted source carries it
	//     once generation is off. U7 splits them into `sourceText` /
	//     `sourceUsage` / `generateWithAi` and should tighten this to one call.
	//   - Covers R33. The retention statement is present before submit and
	//     appears in both usage modes.
	//   - Covers R34. In a tenant without AI, the source-content field is
	//     offered and the usage-mode control is not.
	//   - Covers R35. The source-content section names the file case and points
	//     at the surface that accepts files.
	//   - No accessible label or code identifier for the mode reuses the
	//     attachment designation terms.
	//   - The mode control exposes a programmatic accessible name and group
	//     role, not only conforming wording.
	//
	// Supplemented with the paths those seven leave open:
	//   - R16's trap: the AI toggle stays operable — by pointer AND keyboard —
	//     while Use As-Is holds it off, because that is the only exit.
	//   - The control is keyed off a DEBOUNCED presence check, so it does not
	//     mount on the first character and unmount on the last.
	//   - Whitespace-only source never summons the control.
	//   - A reopened dialog never shows a mode set with no source behind it.

	const sourceField = () =>
		screen.getByLabelText("sourceContentLabel") as HTMLTextAreaElement;

	const pasteSource = async (
		user: ReturnType<typeof userEvent.setup>,
		text: string,
		field: HTMLTextAreaElement = sourceField(),
	) => {
		await user.click(field);
		await user.paste(text);
	};

	const usageModeGroup = () =>
		screen.getByRole("radiogroup", { name: "sourceUsageLabel" });
	const contextOption = () =>
		screen.getByRole("radio", { name: /sourceUsageContextLabel/ });
	const asIsOption = () =>
		screen.getByRole("radio", { name: /sourceUsageAsIsLabel/ });

	const waitForUsageMode = () =>
		waitFor(() =>
			expect(screen.getByTestId("source-usage-mode")).toBeInTheDocument(),
		);

	it("covers AE6 — the mode appears with source content, defaults to Use as Context, and turning AI back on leaves Use As-Is", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		const toggle = await screen.findByRole("checkbox");
		// R12: nothing to apply a mode to yet, so no mode.
		expect(screen.queryByTestId("source-usage-mode")).toBeNull();

		await pasteSource(user, "Pasted architecture notes");
		await waitForUsageMode();

		// R13: Use as Context is what content becoming present selects.
		expect(contextOption()).toBeChecked();
		expect(asIsOption()).not.toBeChecked();
		expect(toggle).toBeChecked();

		// R15: Use As-Is turns generation off for this action.
		await user.click(asIsOption());
		expect(asIsOption()).toBeChecked();
		expect(contextOption()).not.toBeChecked();
		expect(toggle).not.toBeChecked();
		expect(
			screen.getByTestId("as-is-turns-ai-off-hint"),
		).toBeInTheDocument();
		// Generation is off, so the per-run instructions field is gone with it.
		expect(screen.queryByLabelText("instructionsLabel")).toBeNull();

		// R16: turning the toggle back on is the exit, and it returns the mode
		// to Use as Context.
		await user.click(toggle);
		expect(toggle).toBeChecked();
		expect(contextOption()).toBeChecked();
		expect(asIsOption()).not.toBeChecked();
		expect(screen.queryByTestId("as-is-turns-ai-off-hint")).toBeNull();

		// R13: clearing the source removes the control and leaves AI on.
		await user.clear(sourceField());
		await waitFor(() =>
			expect(screen.queryByTestId("source-usage-mode")).toBeNull(),
		);
		expect(screen.getByRole("checkbox")).toBeChecked();
	});

	it("keeps the Generate with AI toggle operable while Use As-Is holds it off", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		const toggle = await screen.findByRole("checkbox");
		await pasteSource(user, "Pasted architecture notes");
		await waitForUsageMode();
		await user.click(asIsOption());
		expect(toggle).not.toBeChecked();

		// The trap this unit exists to avoid: rendered with the native
		// `disabled` prop the control goes inert to pointer and keyboard, and
		// Use As-Is becomes a state with no exit.
		expect(toggle).toBeEnabled();
		expect(toggle).not.toHaveAttribute("disabled");
		expect(toggle).not.toHaveAttribute("aria-disabled", "true");
		expect(toggle).not.toHaveAttribute("data-disabled");
		// The exit is stated programmatically, not left to be inferred.
		expect(toggle).toHaveAttribute(
			"aria-describedby",
			screen.getByTestId("as-is-turns-ai-off-hint").id,
		);

		// Keyboard, not only pointer: focus it and press Space.
		toggle.focus();
		expect(toggle).toHaveFocus();
		await user.keyboard(" ");
		expect(toggle).toBeChecked();
		expect(contextOption()).toBeChecked();
	});

	it("keeps the source-content field and the instructions field separately addressable", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");

		// Both exist at once — the single toggling textarea conflated them.
		const source = sourceField();
		const instructions = screen.getByLabelText(
			"instructionsLabel",
		) as HTMLTextAreaElement;
		expect(source).not.toBe(instructions);

		await pasteSource(user, "Pasted architecture notes", source);
		await user.click(instructions);
		await user.paste("Keep it short");

		expect(source.value).toBe("Pasted architecture notes");
		expect(instructions.value).toBe("Keep it short");

		// While generating, the instructions are what the run is steered with.
		await user.click(screen.getByRole("button", { name: "submitWithAi" }));
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			prompt: "Keep it short",
		});
	});

	it("submits the pasted source, not the instructions, once generation is turned off", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		const toggle = await screen.findByRole("checkbox");
		await user.click(screen.getByLabelText("instructionsLabel"));
		await user.paste("Keep it short");
		await pasteSource(user, "Pasted architecture notes");

		await user.click(toggle);
		expect(toggle).not.toBeChecked();

		await user.click(screen.getByRole("button", { name: "submit" }));
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			sourceText: "Pasted architecture notes",
		});
	});

	it("covers R33 — both retention outcomes are stated before submit, in either mode", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "Pasted architecture notes");
		await waitForUsageMode();

		// Named option plus the consequence of choosing it — the names differ
		// by two words, so the outcome line is what actually decides.
		expect(
			screen.getByText("sourceUsageContextOutcome"),
		).toBeInTheDocument();
		expect(screen.getByText("sourceUsageAsIsOutcome")).toBeInTheDocument();

		await user.click(asIsOption());
		expect(
			screen.getByText("sourceUsageContextOutcome"),
		).toBeInTheDocument();
		expect(screen.getByText("sourceUsageAsIsOutcome")).toBeInTheDocument();

		// Stated BEFORE submit, not in a confirmation after it.
		expect(createDocument).not.toHaveBeenCalled();
	});

	it("covers R34 — a tenant without AI is offered the source field but no usage mode", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);

		// The field is offered — there is no generation, so what is pasted is
		// the document itself, and the label says so.
		const source = screen.getByLabelText(
			"contentLabel",
		) as HTMLTextAreaElement;
		expect(source).toBeInTheDocument();
		expect(screen.queryByLabelText("sourceContentLabel")).toBeNull();
		expect(
			screen.getByTestId("source-retention-no-ai"),
		).toBeInTheDocument();

		await pasteSource(user, "Pasted architecture notes", source);

		// Long enough to clear the presence debounce: the mode is absent
		// because it has no meaning here, not because it has not appeared yet.
		await waitFor(() =>
			expect(source).toHaveValue("Pasted architecture notes"),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("source-usage-mode")).toBeNull(),
		);
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
	});

	it("covers R35 — the source section names the file case and points at the Context tab", async () => {
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		const hint = await screen.findByTestId("source-file-hint");
		expect(hint).toBeInTheDocument();

		// The key alone proves placement, not that the copy states the
		// boundary — so read the English copy the key resolves to.
		const fs = await import("node:fs");
		const en = JSON.parse(
			fs.readFileSync("../../packages/i18n/translations/en.json", "utf8"),
		);
		const copy: string =
			en.projects.documents.create.sourceFileHint.toLowerCase();
		expect(copy).toMatch(/\bfile\b/);
		expect(copy).toContain("context tab");
	});

	it("shows the file-case boundary in a tenant without AI too", async () => {
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByTestId("ai-unavailable-notice"),
			).toBeInTheDocument(),
		);
		expect(screen.getByTestId("source-file-hint")).toBeInTheDocument();
	});

	it("gives the usage mode a group role and a programmatic accessible name", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "Pasted architecture notes");
		await waitForUsageMode();

		// Role and name, not merely a heading that happens to sit above it.
		expect(usageModeGroup()).toBeInTheDocument();
		expect(usageModeGroup()).toHaveAttribute("aria-labelledby");

		// Each option's accessible name carries its outcome, not just its
		// label — the two labels differ by two words.
		expect(
			screen.getByRole("radio", {
				name: /sourceUsageContextLabel.*sourceUsageContextOutcome/s,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("radio", {
				name: /sourceUsageAsIsLabel.*sourceUsageAsIsOutcome/s,
			}),
		).toBeInTheDocument();
	});

	it("does not name the usage mode with the attachment designation vocabulary", async () => {
		const fs = await import("node:fs");
		const codeOnly = stripComments(
			fs.readFileSync(
				"modules/saas/projects/components/CreateDocumentDialog.tsx",
				"utf8",
			),
		);

		// Story attachments already own `designation` / LOCKED / UNLOCKED for
		// delete-protection plus AI visibility. This flow's mode is a different
		// axis; sharing the words has a documented history of blurring the two.
		expect(codeOnly).not.toMatch(/designation/i);
		expect(codeOnly).not.toMatch(/\bLOCKED\b/);
		expect(codeOnly).not.toMatch(/\bUNLOCKED\b/);
		// The names the server already uses for this exact field.
		expect(codeOnly).toContain("sourceUsage");
		expect(codeOnly).toContain('"CONTEXT"');
		expect(codeOnly).toContain('"AS_IS"');

		// The copy a user actually reads, not only the identifiers.
		const en = JSON.parse(
			fs.readFileSync("../../packages/i18n/translations/en.json", "utf8"),
		);
		const create = en.projects.documents.create as Record<string, string>;
		for (const [key, value] of Object.entries(create)) {
			if (!key.startsWith("source") && !key.includes("AsIs")) {
				continue;
			}
			expect(value).not.toMatch(/designation/i);
			expect(value).not.toMatch(/\block(ed|ing)?\b/i);
		}
	});

	it("keys the usage mode off a debounced presence check, not every keystroke", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "Pasted architecture notes");

		// Bound directly to the textarea the control would already be mounted
		// here, jumping the layout on the first character of every paste.
		expect(screen.queryByTestId("source-usage-mode")).toBeNull();
		await waitForUsageMode();

		await user.clear(sourceField());
		// ...and would already be gone here, jumping it back on the last.
		expect(screen.getByTestId("source-usage-mode")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByTestId("source-usage-mode")).toBeNull(),
		);
	});

	it("never summons the usage mode for whitespace-only source content", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "    \n\t  ");

		await waitFor(() => expect(sourceField()).toHaveValue("    \n\t  "));
		await waitFor(() =>
			expect(screen.queryByTestId("source-usage-mode")).toBeNull(),
		);
		expect(screen.getByRole("checkbox")).toBeChecked();
	});

	it("reopens with no mode set and generation back on after a Use As-Is entry", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		const onOpenChange = vi.fn();
		const { reopenWith } = renderDialog(makeProps({ onOpenChange }));

		await screen.findByRole("checkbox");
		await pasteSource(user, "Pasted architecture notes");
		await waitForUsageMode();
		await user.click(asIsOption());
		expect(screen.getByRole("checkbox")).not.toBeChecked();

		await user.click(screen.getByRole("button", { name: "cancel" }));
		reopenWith(makeProps({ open: false, onOpenChange }));
		reopenWith(makeProps({ open: true, onOpenChange }));

		// No state where the mode is set but no source exists behind it.
		await waitFor(() => expect(sourceField()).toHaveValue(""));
		await waitFor(() =>
			expect(screen.queryByTestId("source-usage-mode")).toBeNull(),
		);
		expect(screen.getByRole("checkbox")).toBeChecked();
	});

	// ── U4: prompt selection is scoped to the document type ──

	/**
	 * The association itself, not just that a name exists.
	 *
	 * `getByLabelText` resolves through `htmlFor`/`id`, so it passes only when
	 * the visible label is wired to the trigger — a generic `aria-label` on the
	 * selector would satisfy a name query but fail this one. That distinction is
	 * the point: the visible text and the announced name must be the same
	 * string, so they cannot drift.
	 */
	it("associates the visible prompt label with the selector trigger", async () => {
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");

		expect(screen.getByLabelText(/promptLabel/i)).toHaveAttribute(
			"role",
			"combobox",
		);
	});

	it("covers AE2 — changing the document type drops a prompt chosen for the previous one", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		// Two prompts for the starting type, so there is a non-default the
		// user can deliberately pick. The new type offers a different set —
		// which is the whole reason a selection must not survive the change.
		availablePrompts.mockImplementation(
			(input: { documentType: string }) =>
				input.documentType === "GENERAL"
					? {
							prompts: [
								{
									id: "p-general-default",
									name: "General default",
									scope: "SYSTEM",
									isDefault: true,
								},
								{
									id: "p-general-alt",
									name: "General alternative",
									scope: "ORG",
									isDefault: false,
								},
							],
						}
					: {
							prompts: [
								{
									id: "p-arch-default",
									name: "Architecture default",
									scope: "SYSTEM",
									isDefault: true,
								},
							],
						},
		);
		renderDialog();

		await screen.findByRole("checkbox");
		// Queried by its accessible name, which the visible "Prompt" label now
		// supplies. This used to be positional — "the second combobox" — because
		// the trigger had no labelling hook to associate with.
		await user.click(
			screen.getByRole("combobox", { name: /promptLabel/i }),
		);
		await user.click(
			await screen.findByRole("option", { name: /General alternative/ }),
		);

		await pickType(user, /Technical Architecture/);

		await user.clear(titleField());
		await user.type(titleField(), "Arch brief");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		// The prompt the user picked belonged to the previous type and is not
		// offered for this one; it must not ride along.
		expect(createDocument.mock.calls[0][0].promptId).not.toBe(
			"p-general-alt",
		);
	});

	it("does not render the prompt selector when generation is off", async () => {
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await screen.findByTestId("ai-unavailable-notice");
		expect(screen.queryByText("promptLabel")).toBeNull();
	});

	it("passes the currently selected document type to the selector, not a stale one", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pickType(user, /Test Plan/);

		await waitFor(() => {
			const last =
				availablePrompts.mock.calls[
					availablePrompts.mock.calls.length - 1
				][0];
			expect(last).toMatchObject({ documentType: "TEST_PLAN" });
		});
	});

	it("submits per-run instructions without writing prompt binding configuration", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await user.type(
			screen.getByLabelText("instructionsLabel"),
			"Focus on rollout risk",
		);
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		// Instructions ride the create call for this run only. Nothing here
		// touches the binding surface — that is an explicit admin action.
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			prompt: "Focus on rollout risk",
		});
		expect(bindPrompt).not.toHaveBeenCalled();
	});

	// ── U7: three submit routes, one call each ──

	it("covers AE4 — Use As-Is creates the document and dispatches no generation", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "Verbatim body text");
		await screen.findByRole("radiogroup");
		await user.click(
			screen.getByRole("radio", { name: /sourceUsageAsIsLabel/ }),
		);

		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			sourceText: "Verbatim body text",
			sourceUsage: "AS_IS",
			generateWithAi: false,
		});
	});

	it("Use as Context carries the text and dispatches generation in one call", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "Background notes");
		await screen.findByRole("radiogroup");

		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		expect(createDocument).toHaveBeenCalledTimes(1);
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			sourceText: "Background notes",
			sourceUsage: "CONTEXT",
			generateWithAi: true,
		});
	});

	it("generates with no source in one call, with no source field set", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await screen.findByRole("checkbox");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		expect(createDocument).toHaveBeenCalledTimes(1);
		const payload = createDocument.mock.calls[0][0];
		expect(payload).toMatchObject({ generateWithAi: true });
		expect(payload).not.toHaveProperty("sourceText");
		expect(payload).not.toHaveProperty("sourceUsage");
	});

	it("covers R32 — a response with no document is a failure, not a success", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		// The shape a swallowed document write used to produce: the source
		// landed, the document did not, and the call still resolved.
		createDocument.mockResolvedValue({
			document: null,
			sourceContextId: "ctx-1",
			generation: null,
		});
		const onOpenChange = vi.fn();
		renderDialog(makeProps({ onOpenChange }));

		await screen.findByRole("checkbox");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("covers R31 — an inactive document is reported, not left to be discovered", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockResolvedValue({
			document: { id: "doc-2" },
			generation: { workflowId: "wf-2" },
			displacedActive: true,
			suppliedTextOutcome: null,
		});
		renderDialog();

		await screen.findByRole("checkbox");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(toastWarning).toHaveBeenCalled());
		expect(toastWarning).toHaveBeenCalledWith("displacedActive");
	});

	it("tells the user when their source text was truncated", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockResolvedValue({
			document: { id: "doc-3" },
			generation: { workflowId: "wf-3" },
			displacedActive: false,
			suppliedTextOutcome: { status: "truncated" as const },
		});
		renderDialog();

		await screen.findByRole("checkbox");
		await pasteSource(user, "A very long source");
		await screen.findByRole("radiogroup");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		// The model's copy carries a marker; the user's view has to say so
		// too, and the dialog is about to close.
		await waitFor(() =>
			expect(toastWarning).toHaveBeenCalledWith("sourceTruncated"),
		);
	});

	it("surfaces no infrastructure detail when the create fails", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockRejectedValue(
			new Error("connect ECONNREFUSED 10.0.0.4:7233 temporal-frontend"),
		);
		const onOpenChange = vi.fn();
		renderDialog(makeProps({ onOpenChange }));

		await screen.findByRole("checkbox");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		const [message] = toastError.mock.calls[0];
		expect(message).toBe("createFailed");
		expect(String(message)).not.toMatch(/ECONNREFUSED|7233|temporal/i);
		expect(routerPush).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	// ── U9: the states the flow must refuse, and why ──

	const turnAiOff = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(await screen.findByRole("checkbox"));
	};

	it("covers AE5 — AI available, generation off, no source: creation is blocked", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await turnAiOff(user);
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		// Fixed by the requirement — asserted exactly, not paraphrased.
		expect(toastError).toHaveBeenCalledWith("blockedEmptyCreation");
		expect(createDocument).not.toHaveBeenCalled();
	});

	it("treats whitespace-only source as no source", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await turnAiOff(user);
		await user.click(sourceField());
		await user.paste("   \n\t  ");
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		expect(toastError).toHaveBeenCalledWith("blockedEmptyCreation");
		expect(createDocument).not.toHaveBeenCalled();
	});

	it("associates the refusal with the input it concerns", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await turnAiOff(user);
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		const field = sourceField();
		expect(field).toHaveAttribute("aria-invalid", "true");
		const describedBy = field.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const message = document.getElementById(describedBy as string);
		expect(message).toHaveTextContent("blockedEmptyCreation");
		expect(message).toHaveAttribute("role", "alert");
	});

	it("keeps the two refusals independent — an empty title disables submit outright", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();

		await user.clear(titleField());
		await turnAiOff(user);

		// The title requirement is enforced by disabling submit, not by a
		// message — so the source guard cannot mask it, because the handler
		// that raises it is never reached. The handler's own title guard
		// stays as defence against a programmatic call.
		expect(
			screen.getByRole("button", { name: /^submit$/i }),
		).toBeDisabled();
		expect(toastError).not.toHaveBeenCalled();
		expect(createDocument).not.toHaveBeenCalled();
	});

	it("does not block a title-only submit where AI is unavailable", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiUnavailable());
		renderDialog();

		await screen.findByTestId("ai-unavailable-notice");
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		// R27: this tenant's only route is a title alone. Refusing it would
		// leave them unable to create documents at all.
		await waitFor(() => expect(createDocument).toHaveBeenCalled());
		expect(toastError).not.toHaveBeenCalledWith("blockedEmptyCreation");
	});

	it("refuses Escape while a submit is in flight", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		let resolveCreate: (value: unknown) => void = () => {};
		createDocument.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCreate = resolve;
				}),
		);
		const onOpenChange = vi.fn();
		renderDialog(makeProps({ onOpenChange }));

		await screen.findByRole("checkbox");
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));
		await screen.findByRole("button", { name: "submitting" });

		// Escape, the backdrop, and the built-in close button are dismissal
		// paths of their own — a disabled Cancel button does not cover them,
		// and letting one through mid-submit leaves the chain running to close
		// and navigate over whatever the user opens next.
		await user.keyboard("{Escape}");
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		await act(async () => {
			resolveCreate({
				document: { id: "doc-1" },
				generation: { workflowId: "wf-1" },
				displacedActive: false,
				suppliedTextOutcome: null,
			});
		});
		await waitFor(() => expect(routerPush).toHaveBeenCalledTimes(1));
	});
});

/**
 * The file source.
 *
 * The dialog makes one document, so it takes one file, and every rule it
 * enforces comes from the shared context-upload allowlist rather than being
 * restated — a picker that advertised what the server refuses is how this drifted
 * before. What is asserted below is mostly the refusals, because the accept
 * attribute alone does not stop a drag-and-drop or a renamed file.
 */
describe("CreateDocumentDialog — attaching a file", () => {
	const fileInput = () =>
		screen.getByTestId("source-file-input") as HTMLInputElement;

	const choose = async (user: UserEvent, file: File) => {
		await user.upload(fileInput(), file);
	};

	const okFile = () =>
		new File(["# spec"], "spec.md", { type: "text/markdown" });

	beforeEach(() => {
		// A sibling of the main describe, so its setup is restated rather than
		// silently absent — the first run of these tests read a createDocument
		// call left over from another test.
		vi.clearAllMocks();
		toastLoading.mockReturnValue("toast-id-1");
		availablePrompts.mockResolvedValue({ prompts: [] });
		createDocument.mockResolvedValue({
			document: { id: "doc-1" },
			generation: null,
			displacedActive: false,
			suppliedTextOutcome: null,
		});
		createUploadUrl.mockResolvedValue({
			signedUploadUrl: "https://signed.example/put",
			contextId: "ctx-1",
			contentType: "text/markdown",
		});
		processFile.mockResolvedValue({});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true } as Response),
		);
	});

	/**
	 * Driven through `fireEvent` rather than the user API on purpose. The
	 * picker's `accept` attribute already filters this in a real dialog, and
	 * `user.upload` honours it — so going through the user API would assert the
	 * attribute and never reach the validator. A drag-and-drop, or a file
	 * renamed to a permitted extension, arrives without that filter.
	 */
	it("refuses a type the shared allowlist does not carry", async () => {
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();
		await screen.findByRole("checkbox");

		fireEvent.change(fileInput(), {
			target: {
				files: [
					new File(["MZ"], "installer.exe", {
						type: "application/x-msdownload",
					}),
				],
			},
		});

		expect(
			await screen.findByTestId("source-file-refusal"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("source-file-chosen")).toBeNull();
	});

	it("refuses a file over the category's size ceiling", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();
		await screen.findByRole("checkbox");

		const huge = new File(["x"], "huge.md", { type: "text/markdown" });
		Object.defineProperty(huge, "size", { value: 999 * 1024 * 1024 });
		await choose(user, huge);

		expect(
			await screen.findByTestId("source-file-refusal"),
		).toBeInTheDocument();
	});

	/**
	 * A zero-byte file clears the type and size gates and then extracts to
	 * nothing, which would surface much later as a failed document. Refused up
	 * front, where another file can still be picked.
	 */
	it("refuses an empty file", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();
		await screen.findByRole("checkbox");

		await choose(user, new File([], "empty.md", { type: "text/markdown" }));

		expect(
			await screen.findByTestId("source-file-refusal"),
		).toBeInTheDocument();
	});

	it("stands in for the paste rather than joining it", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();
		await screen.findByRole("checkbox");

		await choose(user, okFile());

		expect(
			await screen.findByTestId("source-file-chosen"),
		).toHaveTextContent("spec.md");
		expect(screen.getByLabelText(/sourceContentLabel/i)).toBeDisabled();
	});

	/**
	 * A file has one possible use, so the controls that would express a choice
	 * are settled rather than left offering one the submit cannot honour.
	 *
	 * Using a file as generation input would mean starting the run once
	 * extraction finishes — by which point the request that could issue an AI
	 * token is gone, and the worker holds no signing key. Offering it produced
	 * a document that stayed on "generating" with nothing to explain it.
	 */
	it("settles on Use As-Is and withdraws the mode choice", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		renderDialog();
		await screen.findByRole("checkbox");

		await choose(user, okFile());

		expect(
			await screen.findByTestId("file-used-as-is"),
		).toBeInTheDocument();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.getByRole("checkbox")).not.toBeChecked();
	});

	/**
	 * A file's mode does not depend on the dialog's mode state at all.
	 *
	 * Worth saying plainly: this test passed against the broken code too. The
	 * mode was stomped by a debounced effect that fires in a browser and not in
	 * this environment, and no reasonable arrangement of timers here reproduced
	 * it — the proof was the request body captured off a deployed build, which
	 * carried Use as Context with a file attached.
	 *
	 * So the guard is structural rather than this assertion: the upload helper
	 * no longer takes a mode, and states the only one a file can have. What is
	 * pinned below is that no caller reintroduces the parameter.
	 *
	 * Driven by putting that state into Use as Context first — pasting text
	 * makes the control appear with that selection — and only then attaching a
	 * file. On a deployed build the same thing happened by itself: an effect
	 * resets the mode to Use as Context on a debounce once the source is
	 * noticed, which landed just after choosing a file had set As-Is. The
	 * dialog looked correct, because the mode control is not shown for a file,
	 * while the upload carried the mode the server refuses.
	 *
	 * Setting it explicitly reproduces that without depending on a timer.
	 */
	it("uploads a file as-is even when the mode state says otherwise", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockResolvedValue({
			document: { id: "doc-99" },
			generation: null,
		});
		renderDialog();
		await screen.findByRole("checkbox");

		await user.type(
			screen.getByLabelText(/sourceContentLabel/i),
			"pasted first",
		);
		const asContext = await screen.findByRole("radio", {
			name: /sourceUsageContextLabel/i,
		});
		await user.click(asContext);
		expect(asContext).toBeChecked();

		await choose(user, okFile());
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		await waitFor(() => expect(createUploadUrl).toHaveBeenCalled());
		expect(createUploadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ documentUsage: "AS_IS" }),
		);
	});

	it("creates the row first, then uploads against its id as-is", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockResolvedValue({
			document: { id: "doc-99" },
			generation: null,
		});
		renderDialog();
		await screen.findByRole("checkbox");

		await choose(user, okFile());
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		await waitFor(() => expect(processFile).toHaveBeenCalled());
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			awaitingSourceFile: true,
		});
		expect(createDocument.mock.calls[0][0]).not.toHaveProperty(
			"sourceText",
		);
		expect(createUploadUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				targetDocumentId: "doc-99",
				documentTag: "GENERAL",
				documentUsage: "AS_IS",
			}),
		);
	});

	/**
	 * The row is already GENERATING when the upload fails, and nothing behind it
	 * will ever arrive. Saying so beats a success toast over a document that
	 * will sit generating until the sweep clears it.
	 */
	it("says so when the upload fails after the row was created", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue(aiAvailable());
		createDocument.mockResolvedValue({
			document: { id: "doc-99" },
			generation: null,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false } as Response),
		);
		renderDialog();
		await screen.findByRole("checkbox");

		await choose(user, okFile());
		await user.click(screen.getByRole("button", { name: /^submit$/i }));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"fileUploadFailed",
				expect.anything(),
			),
		);
		expect(processFile).not.toHaveBeenCalled();
	});
});
