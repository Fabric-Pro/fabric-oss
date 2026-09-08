/**
 * Fizzy #2199 — what the create dialog says once a generation can be *queued*.
 *
 * The server stopped answering "did it generate?" with a boolean. It now hands
 * back the dispatcher's own discriminated outcome, and a created document can
 * come back QUEUED: accepted, but waiting on the project's context work, which
 * can run for the better part of an hour. Two sentences that used to be safe
 * are now wrong — "opening the editor to generate its content" for a run that
 * has not started, and the same sentence for a request that started nothing at
 * all because an equivalent run was already under way.
 *
 * Translations resolve against the real `en.json` rather than echoing keys
 * back, because the whole point of this unit is the words: a mock that returned
 * "createdQueued" would pass while the UI shipped a missing-key placeholder.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../../../packages/i18n/translations/en.json";

const {
	getAiConfigStatus,
	createDocument,
	availablePrompts,
	routerPush,
	toastLoading,
	toastSuccess,
	toastError,
	toastWarning,
} = vi.hoisted(() => ({
	getAiConfigStatus: vi.fn(),
	createDocument: vi.fn(),
	availablePrompts: vi.fn(),
	routerPush: vi.fn(),
	toastLoading: vi.fn(() => "toast-id-1"),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("next-intl", () => {
	function resolve(path: string): string {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				en,
			);
		if (typeof value !== "string") {
			throw new Error(`missing translation: ${path}`);
		}
		return value;
	}
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) => {
			let out = resolve(`${namespace}.${key}`);
			for (const [name, value] of Object.entries(values ?? {})) {
				out = out.replaceAll(`{${name}}`, String(value));
			}
			return out;
		};
		t.raw = (key: string) => resolve(`${namespace}.${key}`);
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => en,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

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
		projects: {
			contexts: {
				createUploadUrl: vi.fn(),
				processFile: vi.fn(),
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

const copy = en.projects.documents.create;

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<CreateDocumentDialog
				projectId="project-1"
				open
				onOpenChange={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

/**
 * The dialog prefills the type's own label as the title, so a create needs no
 * typing — which keeps each test to the one thing it is about: the shape of the
 * response, and the sentence it produces.
 */
async function createAndGenerate() {
	const user = userEvent.setup();
	renderDialog();
	await screen.findByRole("checkbox");
	await user.click(screen.getByRole("button", { name: copy.submitWithAi }));
}

describe("CreateDocumentDialog — queued and already-running generations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		toastLoading.mockReturnValue("toast-id-1");
		availablePrompts.mockResolvedValue({ prompts: [] });
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
	});

	it("says a queued document is waiting, and never that it is generating", async () => {
		createDocument.mockResolvedValue({
			document: { id: "doc-1", status: "QUEUED" },
			generation: {
				outcome: "started",
				workflowId: "wf-1",
				runId: "run-1",
			},
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		await createAndGenerate();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(copy.createdQueued, {
			id: "toast-id-1",
		});
		// The failure this exists to prevent: a wait that can run for an hour
		// described as an editor about to fill itself in.
		expect(toastSuccess).not.toHaveBeenCalledWith(
			copy.createdWithAi,
			expect.anything(),
		);
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-1",
		);
	});

	it("leaves a started, generating run reading exactly as it did before", async () => {
		createDocument.mockResolvedValue({
			document: { id: "doc-2", status: "GENERATING" },
			generation: {
				outcome: "started",
				workflowId: "wf-2",
				runId: "run-2",
			},
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		await createAndGenerate();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(copy.createdWithAi, {
			id: "toast-id-1",
		});
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-2",
		);
	});

	it("says only that the document was created when no generation was requested", async () => {
		// The AI-unconfigured tenant: the toggle is not rendered at all, so a
		// title alone is the sanctioned route and the response carries no
		// dispatch to describe.
		getAiConfigStatus.mockResolvedValue({ isConfigured: false });
		createDocument.mockResolvedValue({
			document: { id: "doc-3", status: "DRAFT" },
			generation: null,
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		const user = userEvent.setup();
		renderDialog();
		await screen.findByTestId("ai-unavailable-notice");
		await user.click(screen.getByRole("button", { name: copy.submit }));

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(copy.created, {
			id: "toast-id-1",
		});
	});

	it("sends an already-running request to that run's document, and says it is running", async () => {
		createDocument.mockResolvedValue({
			document: { id: "doc-4", status: "GENERATING" },
			generation: {
				outcome: "alreadyInProgress",
				workflowId: "wf-4",
				runId: null,
			},
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		await createAndGenerate();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(
			copy.generationAlreadyRunning,
			{ id: "toast-id-1" },
		);
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-4",
		);
	});

	it("words an already-queued run from the document's status, not from the outcome name", async () => {
		// `alreadyInProgress` deliberately says nothing about *where* the live
		// run is. Only the row does — so a run still inside its dependency wait
		// has to read as waiting rather than as running.
		createDocument.mockResolvedValue({
			document: { id: "doc-5", status: "QUEUED" },
			generation: {
				outcome: "alreadyInProgress",
				workflowId: "wf-5",
				runId: null,
			},
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		await createAndGenerate();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(
			copy.generationAlreadyQueued,
			{
				id: "toast-id-1",
			},
		);
		expect(toastSuccess).not.toHaveBeenCalledWith(
			copy.generationAlreadyRunning,
			expect.anything(),
		);
	});

	it("falls through to the default branch on an outcome it has never heard of", async () => {
		createDocument.mockResolvedValue({
			document: { id: "doc-6", status: "DRAFT" },
			generation: { outcome: "somethingAddedLater", workflowId: "wf-6" },
			displacedActive: false,
			suppliedTextOutcome: null,
		});

		await createAndGenerate();

		// Neither a throw nor silence: the loading toast is resolved, the
		// document exists, and the user is not pushed toward a retry that could
		// race a run that may well be live.
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith(copy.createdWithAi, {
			id: "toast-id-1",
		});
		expect(toastError).not.toHaveBeenCalled();
		expect(routerPush).toHaveBeenCalledWith(
			"/app/projects/project-1/documents/doc-6",
		);
	});
});
