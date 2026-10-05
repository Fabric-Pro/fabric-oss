/**
 * The Documents tab's way out of DRAFT.
 *
 * A document written by hand stays a draft until something completes it, and
 * the card offered nothing that did: Regenerate is withheld from a draft, and
 * no other action touches the status. "Mark as complete" is that action — for
 * a draft that has content, and for someone who may edit the project.
 *
 * It asks the server to complete the draft rather than sending a status: the
 * card can be older than the row, and a document a generation has since picked
 * up must not have that run's status overwritten.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../../../packages/i18n/translations/en.json";

// ── jsdom polyfills ────────────────────────────────────────────
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

// ── Module mocks ───────────────────────────────────────────────

const { documentsListMock, updateDocumentMock } = vi.hoisted(() => ({
	documentsListMock: vi.fn(),
	updateDocumentMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = () => ({
		mutationOptions: (opts: unknown) => ({ ...(opts ?? {}) }),
	});
	return {
		orpc: {
			projects: {
				documents: {
					list: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: [
								"projects.documents.list",
								input,
							] as const,
							queryFn: () => documentsListMock(input),
						}),
						queryKey: ({ input }: { input: unknown }) => [
							"projects.documents.list",
							input,
						],
					},
					delete: mutation(),
					deleteAll: mutation(),
					generate: mutation(),
					setActive: mutation(),
					update: {
						mutationOptions: (opts: unknown) => ({
							...(opts ?? {}),
							mutationFn: (input: unknown) =>
								updateDocumentMock(input),
						}),
					},
				},
			},
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
	};
});

vi.mock("../CreateDocumentDialog", () => ({
	CreateDocumentDialog: () => null,
}));
vi.mock("../DocumentDownloadDropdown", () => ({
	DocumentDownloadDropdown: () => null,
}));
vi.mock("../DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: ({ title }: { title: string }) => <>{title}</>,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { toast } from "sonner";
import { DocumentsList } from "../DocumentsList";

// ── Helpers ────────────────────────────────────────────────────

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Design notes",
		type: "TECHNICAL_SPEC",
		status: "DRAFT",
		source: "GENERATED",
		isActive: true,
		version: 2,
		wordCount: 420,
		content: "# Design\n\nWritten by hand.",
		generationProgress: 0,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: null,
		updatedAt: new Date("2026-09-07T10:00:00Z"),
		createdAt: new Date("2026-09-07T10:00:00Z"),
		_count: { versions: 1 },
		...overrides,
	};
}

async function renderWithDocument(
	document: Record<string, unknown>,
	props: { canEdit?: boolean } = {},
) {
	documentsListMock.mockResolvedValue({
		documents: [document],
		total: 1,
		hasMore: false,
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<DocumentsList projectId="proj_1" enableDelete {...props} />
		</QueryClientProvider>,
	);
	await screen.findByText(String(document.title));
}

const markComplete = () =>
	screen.queryByRole("button", { name: "Mark as complete" });

// ── Tests ──────────────────────────────────────────────────────

describe("DocumentsList — marking a draft complete", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		updateDocumentMock.mockReset();
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.info).mockClear();
	});

	it("offers the action on a draft that has content", async () => {
		await renderWithDocument(makeDocument());

		expect(markComplete()).toBeInTheDocument();
	});

	it("asks the server to complete that draft and refreshes the list", async () => {
		updateDocumentMock.mockResolvedValue({
			document: { id: "doc_1", status: "COMPLETE" },
			draftCompleted: true,
		});
		const user = userEvent.setup();
		await renderWithDocument(makeDocument());
		expect(documentsListMock).toHaveBeenCalledTimes(1);

		await user.click(markComplete() as HTMLElement);

		await waitFor(() => {
			expect(updateDocumentMock).toHaveBeenCalledTimes(1);
		});
		expect(updateDocumentMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			id: "doc_1",
			organizationId: "org_1",
			completeDraft: true,
		});
		await waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith(
				"Document marked as complete",
			);
		});
		// The card has to stop saying "Draft", so the list is read again.
		await waitFor(() => {
			expect(documentsListMock).toHaveBeenCalledTimes(2);
		});
	});

	it.each([
		// A generation picked the document up from another tab.
		"GENERATING",
		// Someone else completed it. The row now reads COMPLETE, but this
		// click completed nothing, and must not say that it did.
		"COMPLETE",
	])(
		"does not claim success when the document had already become %s",
		async (status) => {
			// The card was stale: the server changed nothing and returns the row
			// as it is now.
			updateDocumentMock.mockResolvedValue({
				document: { id: "doc_1", status },
				draftCompleted: false,
			});
			const user = userEvent.setup();
			await renderWithDocument(makeDocument());

			await user.click(markComplete() as HTMLElement);

			await waitFor(() => {
				expect(toast.info).toHaveBeenCalledTimes(1);
			});
			expect(toast.success).not.toHaveBeenCalled();
			await waitFor(() => {
				expect(documentsListMock).toHaveBeenCalledTimes(2);
			});
		},
	);

	it("says so when the update is refused, and leaves the action in place", async () => {
		updateDocumentMock.mockRejectedValue(new Error("Forbidden"));
		const user = userEvent.setup();
		await renderWithDocument(makeDocument());

		await user.click(markComplete() as HTMLElement);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				expect.stringContaining("Forbidden"),
			);
		});
		expect(toast.success).not.toHaveBeenCalled();
		expect(markComplete()).toBeInTheDocument();
	});

	it("offers it on a draft whose content has no countable words", async () => {
		// A diagram or a code block alone: content the server would complete.
		await renderWithDocument(
			makeDocument({
				wordCount: 0,
				content: "```mermaid\ngraph TD; A-->B;\n```",
			}),
		);

		expect(markComplete()).toBeInTheDocument();
	});

	it("does not offer it on an empty draft, which has nothing to complete", async () => {
		await renderWithDocument(makeDocument({ wordCount: 0, content: "" }));

		expect(markComplete()).not.toBeInTheDocument();
	});

	it.each([
		"QUEUED",
		"GENERATING",
		"IN_PROGRESS",
		"REVIEW",
		"COMPLETE",
		"FAILED",
	])("does not offer it on a document that is %s", async (status) => {
		await renderWithDocument(makeDocument({ status }));

		expect(markComplete()).not.toBeInTheDocument();
	});

	it("does not offer it on an integration contract, whose status its run owns", async () => {
		await renderWithDocument(
			makeDocument({ type: "INTEGRATION_CONTRACT" }),
		);

		expect(markComplete()).not.toBeInTheDocument();
	});

	it("does not offer it to someone who cannot edit the project", async () => {
		await renderWithDocument(makeDocument(), { canEdit: false });

		expect(markComplete()).not.toBeInTheDocument();
	});
});
