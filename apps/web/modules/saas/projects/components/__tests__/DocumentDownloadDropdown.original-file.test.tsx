/**
 * The document Download menu's "Original file" item (Fizzy #2280).
 *
 * A document imported from an upload is converted to Markdown, and until now
 * the menu offered only Markdown, PDF and Word exports of that text — an
 * uploaded `petstore.json` could come back only as a PDF. The list now hands
 * the menu the upload it was converted from (`sourceFile`, resolved on the
 * server), and the menu offers that file as uploaded, ahead of the unchanged
 * exports.
 *
 * Copy is resolved from the real `en.json`, and the namespace is checked for
 * locale parity, so a missing key fails here rather than rendering a raw path.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../packages/i18n/translations/en.json";

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	createDownloadUrlMock,
	documentGetMock,
	documentsListMock,
	renderMarkdownToPdfMock,
	toastErrorMock,
	triggerUrlDownloadMock,
} = vi.hoisted(() => ({
	createDownloadUrlMock: vi.fn(),
	documentGetMock: vi.fn(),
	documentsListMock: vi.fn(),
	renderMarkdownToPdfMock: vi.fn(),
	toastErrorMock: vi.fn(),
	triggerUrlDownloadMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				createDownloadUrl: (input: unknown) =>
					createDownloadUrlMock(input),
			},
			documents: {
				get: (input: unknown) => documentGetMock(input),
				resolveMediaUrls: vi.fn(async () => ({ urls: {} })),
			},
		},
	},
}));

vi.mock("../../lib/markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/markdown-to-document")>();
	return {
		...actual,
		triggerUrlDownload: triggerUrlDownloadMock,
		triggerBlobDownload: vi.fn(),
		renderMermaidToPng: vi.fn(async () => null),
		renderMarkdownToPdf: renderMarkdownToPdfMock,
		renderMarkdownToDocx: vi.fn(async () => new Blob(["docx"])),
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: toastErrorMock },
}));

vi.mock("next-intl", () => {
	function resolveCopy(path: string): string {
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
			let out = resolveCopy(`${namespace}.${key}`);
			for (const [name, value] of Object.entries(values ?? {})) {
				out = out.replaceAll(`{${name}}`, String(value));
			}
			return out;
		};
		t.raw = (key: string) => resolveCopy(`${namespace}.${key}`);
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
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

// DocumentsList's own collaborators, for the list half below.
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
					update: mutation(),
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
vi.mock("../CreateDocumentDialog", () => ({
	CreateDocumentDialog: () => null,
}));
vi.mock("../DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: ({ title }: { title: string }) => <>{title}</>,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { DocumentDownloadDropdown } from "../DocumentDownloadDropdown";
import { DocumentsList } from "../DocumentsList";

// ── Helpers ──────────────────────────────────────────────────────────────

const SPEC_FILE = { contextId: "ctx_spec", filename: "petstore.json" };

function renderDropdown(
	props: Partial<Parameters<typeof DocumentDownloadDropdown>[0]> = {},
) {
	return render(
		<DocumentDownloadDropdown
			documentId="doc_1"
			title="Petstore API"
			projectId="proj_1"
			documentType="API_DOCUMENTATION"
			organizationId="org_1"
			{...props}
		/>,
	);
}

async function openMenu(trigger?: HTMLElement) {
	const user = userEvent.setup();
	await user.click(
		trigger ?? screen.getByRole("button", { name: "Download" }),
	);
	await screen.findByRole("menu");
	return user;
}

beforeEach(() => {
	createDownloadUrlMock.mockReset();
	documentGetMock.mockReset();
	documentsListMock.mockReset();
	renderMarkdownToPdfMock.mockReset();
	renderMarkdownToPdfMock.mockResolvedValue(new Blob(["pdf"]));
	toastErrorMock.mockReset();
	triggerUrlDownloadMock.mockReset();
});

// ── The menu ─────────────────────────────────────────────────────────────

describe("DocumentDownloadDropdown — original file", () => {
	it("offers no original for a document that was not imported from a file", async () => {
		renderDropdown();
		await openMenu();

		expect(
			screen.queryByRole("menuitem", { name: /Original file/ }),
		).not.toBeInTheDocument();
		// The converted exports are all still there.
		for (const name of ["Markdown (.md)", "PDF (.pdf)", "Word (.docx)"]) {
			expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
		}
	});

	it("offers the upload first, named by its own extension", async () => {
		renderDropdown({ sourceFile: SPEC_FILE });
		await openMenu();

		const items = screen.getAllByRole("menuitem");
		expect(items[0]).toHaveAccessibleName("Original file (.json)");
		expect(items[0]).toHaveAttribute(
			"title",
			"Download petstore.json exactly as it was uploaded",
		);
		expect(
			screen.getByRole("menuitem", { name: "PDF (.pdf)" }),
		).toBeInTheDocument();
	});

	it("saves the stored file itself, never a conversion of the document text", async () => {
		createDownloadUrlMock.mockResolvedValue({
			url: "https://storage.example.com/signed/petstore.json",
			filename: "petstore.json",
			expiresAt: "2026-10-13T00:05:00.000Z",
			contextClass: "A",
		});
		renderDropdown({ sourceFile: SPEC_FILE, organizationId: "org_route" });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		);

		await waitFor(() =>
			expect(triggerUrlDownloadMock).toHaveBeenCalledWith(
				"https://storage.example.com/signed/petstore.json",
				"petstore.json",
			),
		);
		expect(createDownloadUrlMock).toHaveBeenCalledWith({
			contextId: "ctx_spec",
			projectId: "proj_1",
			organizationId: "org_route",
		});
		expect(documentGetMock).not.toHaveBeenCalled();
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("leaves the converted exports as they were beside the original", async () => {
		documentGetMock.mockResolvedValue({ document: { content: "# Pets" } });
		renderDropdown({ sourceFile: SPEC_FILE });
		const user = await openMenu();
		await user.click(screen.getByRole("menuitem", { name: "PDF (.pdf)" }));

		await waitFor(() =>
			expect(renderMarkdownToPdfMock).toHaveBeenCalledWith("# Pets"),
		);
		expect(createDownloadUrlMock).not.toHaveBeenCalled();
		expect(triggerUrlDownloadMock).not.toHaveBeenCalled();
	});

	it("refuses to save synthesized text under the original's name", async () => {
		createDownloadUrlMock.mockResolvedValue({
			url: "https://storage.example.com/signed/export.md",
			filename: "export.md",
			expiresAt: "2026-10-13T00:05:00.000Z",
			contextClass: "B",
		});
		renderDropdown({ sourceFile: SPEC_FILE });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		);

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				"The original file is no longer available",
			),
		);
		expect(triggerUrlDownloadMock).not.toHaveBeenCalled();
	});

	it("says the original is gone when storage no longer holds it", async () => {
		createDownloadUrlMock.mockRejectedValue(
			Object.assign(
				new Error("The original file is no longer in storage"),
				{
					code: "BAD_REQUEST",
					data: { code: "CONTENT_UNAVAILABLE" },
				},
			),
		);
		renderDropdown({ sourceFile: SPEC_FILE });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		);

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				"The original file is no longer available",
			),
		);
		expect(triggerUrlDownloadMock).not.toHaveBeenCalled();
	});

	it("says the original is gone when its source was deleted since the list loaded", async () => {
		createDownloadUrlMock.mockRejectedValue(
			Object.assign(new Error("Project context not found"), {
				code: "NOT_FOUND",
			}),
		);
		renderDropdown({ sourceFile: SPEC_FILE });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		);

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				"The original file is no longer available",
			),
		);
	});

	it("reports any other failure as a failed download", async () => {
		createDownloadUrlMock.mockRejectedValue(
			Object.assign(new Error("nope"), { code: "FORBIDDEN" }),
		);
		renderDropdown({ sourceFile: SPEC_FILE });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		);

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Couldn't download the original file",
			),
		);
	});

	it("still offers an upload whose name has no extension", async () => {
		renderDropdown({
			sourceFile: { contextId: "ctx_file", filename: null },
		});
		await openMenu();

		const item = screen.getByRole("menuitem", { name: "Original file" });
		expect(item).not.toHaveAttribute("title");
	});
});

// ── The list hands it over ───────────────────────────────────────────────

function makeDocument(overrides: Record<string, unknown>) {
	return {
		title: "Untitled",
		type: "API_DOCUMENTATION",
		status: "COMPLETE",
		source: "GENERATED",
		sourceFile: null,
		isActive: true,
		wordCount: 120,
		content: "",
		generationProgress: 100,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: null,
		updatedAt: new Date("2026-10-13T10:00:00Z"),
		createdAt: new Date("2026-10-13T10:00:00Z"),
		_count: { versions: 0 },
		...overrides,
	};
}

/** The Download trigger on the card that carries `title`. */
function downloadTriggerFor(title: string): HTMLElement {
	const open = screen.getByRole("button", { name: `Open ${title}` });
	const card = open.parentElement;
	if (!card) {
		throw new Error(`no card for ${title}`);
	}
	return within(card).getByRole("button", { name: "Download" });
}

describe("DocumentsList — original file", () => {
	it("hands each card its own source file, and none to a generated one", async () => {
		documentsListMock.mockResolvedValue({
			documents: [
				makeDocument({
					id: "doc_imported",
					title: "Petstore API",
					source: "IMPORTED",
					sourceFile: SPEC_FILE,
				}),
				makeDocument({
					id: "doc_generated",
					title: "Checkout PRD",
					type: "PRD",
				}),
			],
			total: 2,
			hasMore: false,
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<DocumentsList projectId="proj_1" enableDelete />
			</QueryClientProvider>,
		);
		await screen.findByText("Petstore API");

		const user = await openMenu(downloadTriggerFor("Petstore API"));
		expect(
			screen.getByRole("menuitem", { name: "Original file (.json)" }),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");

		await openMenu(downloadTriggerFor("Checkout PRD"));
		expect(
			screen.queryByRole("menuitem", { name: /Original file/ }),
		).not.toBeInTheDocument();
	});
});

describe("projects.documentDownload copy", () => {
	it("has every key, non-empty, in both locales", () => {
		const enKeys = en.projects.documentDownload;
		const deKeys = de.projects.documentDownload as Record<string, unknown>;
		for (const [key, value] of Object.entries(enKeys)) {
			expect(value, `en ${key}`).toMatch(/\S/);
			expect(deKeys[key], `de ${key}`).toEqual(
				expect.stringMatching(/\S/),
			);
		}
		expect(Object.keys(deKeys).sort()).toEqual(Object.keys(enKeys).sort());
	});
});
