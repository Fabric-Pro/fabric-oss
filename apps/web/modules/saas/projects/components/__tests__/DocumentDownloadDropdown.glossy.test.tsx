/**
 * The document Download menu as a Glossy entry point (Fizzy #2589, U15).
 *
 *  - AE10 / R1 / R2 / R40: the Glossy item is offered only when the parent
 *    hands the menu a `glossyHref` — which it does only with the
 *    `GLOSSY_EDITION` gate on — and only for a Glossy-eligible type, so a PRD
 *    never shows it whatever it is handed. The menu reads no flag itself; the
 *    list is where the gate is read, and that half is pinned below too.
 *  - R38: the Markdown download leaves visual slots out. PDF and DOCX already
 *    strip them in their renderers (see `markdown-to-document-visual-slots`);
 *    Markdown is written from the raw body, so the menu has to.
 *  - The content fetch carries the route's `organizationId`, so it resolves
 *    the page's tenant rather than the session's active organization.
 *
 * Copy is resolved from the real `en.json`, and the new namespace is checked
 * for locale parity, so a missing key fails here rather than rendering a raw
 * key path.
 */

import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../packages/i18n/translations/en.json";

// ── Module mocks ─────────────────────────────────────────────────────────

const { documentGetMock, documentsListMock, flags, triggerBlobDownloadMock } =
	vi.hoisted(() => ({
		documentGetMock: vi.fn(),
		documentsListMock: vi.fn(),
		flags: { glossy: false },
		triggerBlobDownloadMock: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
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
		triggerBlobDownload: triggerBlobDownloadMock,
		renderMermaidToPng: vi.fn(async () => null),
		renderMarkdownToPdf: vi.fn(async () => new Blob(["pdf"])),
		renderMarkdownToDocx: vi.fn(async () => new Blob(["docx"])),
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
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
	useFeatureFlag: (key: string) => key === "GLOSSY_EDITION" && flags.glossy,
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

const GLOSSY_LABEL = "Glossy version";
const GLOSSY_HREF = "/app/example-org/projects/proj_1/documents/doc_1/glossy";

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsText(blob);
	});
}

function renderDropdown(
	props: Partial<Parameters<typeof DocumentDownloadDropdown>[0]> = {},
) {
	return render(
		<DocumentDownloadDropdown
			documentId="doc_1"
			title="Rollout business case"
			projectId="proj_1"
			documentType="BUSINESS_CASE"
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

// ── The menu ─────────────────────────────────────────────────────────────

describe("DocumentDownloadDropdown — Glossy entry (AE10)", () => {
	beforeEach(() => {
		documentGetMock.mockReset();
		triggerBlobDownloadMock.mockReset();
	});

	it("links a Business Case to its Glossy page when handed the href (gate on)", async () => {
		renderDropdown({ glossyHref: GLOSSY_HREF });
		await openMenu();

		const item = screen.getByRole("menuitem", { name: GLOSSY_LABEL });
		expect(item).toHaveAttribute("href", GLOSSY_HREF);
	});

	it("offers it on a Proposal too", async () => {
		renderDropdown({ documentType: "PROPOSAL", glossyHref: GLOSSY_HREF });
		await openMenu();

		expect(
			screen.getByRole("menuitem", { name: GLOSSY_LABEL }),
		).toBeInTheDocument();
	});

	it("shows no Glossy item on a Business Case without the href (gate off)", async () => {
		renderDropdown();
		await openMenu();

		expect(
			screen.getByRole("menuitem", { name: "Markdown (.md)" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("never shows it on a PRD, even when handed an href", async () => {
		renderDropdown({ documentType: "PRD", glossyHref: GLOSSY_HREF });
		await openMenu();

		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});
});

describe("DocumentDownloadDropdown — downloads", () => {
	beforeEach(() => {
		documentGetMock.mockReset();
		triggerBlobDownloadMock.mockReset();
	});

	it("leaves visual slots out of the Markdown download", async () => {
		const slot = serializeVisualSlot({
			id: "slot-1",
			kind: "timeline",
			hint: "Rollout milestones",
		});
		documentGetMock.mockResolvedValue({
			document: {
				content: [
					"# Rollout",
					"",
					"Pilot starts in the first quarter.",
					"",
					slot,
					"",
					"General availability follows.",
				].join("\n"),
			},
		});
		renderDropdown();
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Markdown (.md)" }),
		);

		await waitFor(() =>
			expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1),
		);
		const [blob, filename] = triggerBlobDownloadMock.mock.calls[0];
		expect(filename).toBe("rollout-business-case.md");
		const text = await readBlobText(blob as Blob);
		expect(text).not.toContain("visual-slot");
		expect(text).toBe(
			[
				"# Rollout",
				"",
				"Pilot starts in the first quarter.",
				"",
				"General availability follows.",
			].join("\n"),
		);
	});

	it("fetches the content with the route's organizationId", async () => {
		documentGetMock.mockResolvedValue({ document: { content: "# Plan" } });
		renderDropdown({ organizationId: "org_route" });
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Markdown (.md)" }),
		);

		await waitFor(() =>
			expect(documentGetMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				id: "doc_1",
				organizationId: "org_route",
			}),
		);
	});
});

// ── The list decides ─────────────────────────────────────────────────────

function makeDocument(overrides: Record<string, unknown>) {
	return {
		title: "Untitled",
		status: "COMPLETE",
		source: "GENERATED",
		isActive: true,
		wordCount: 120,
		content: "",
		generationProgress: 100,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: null,
		updatedAt: new Date("2026-09-07T10:00:00Z"),
		createdAt: new Date("2026-09-07T10:00:00Z"),
		_count: { versions: 0 },
		...overrides,
	};
}

async function renderList() {
	documentsListMock.mockResolvedValue({
		documents: [
			makeDocument({
				id: "doc_bc",
				title: "Rollout business case",
				type: "BUSINESS_CASE",
			}),
			makeDocument({ id: "doc_prd", title: "Checkout PRD", type: "PRD" }),
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
	await screen.findByText("Rollout business case");
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

describe("DocumentsList — Glossy gate (AE10)", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		flags.glossy = false;
	});

	it("hands a Business Case its Glossy link with the gate on", async () => {
		flags.glossy = true;
		await renderList();
		await openMenu(downloadTriggerFor("Rollout business case"));

		expect(
			screen.getByRole("menuitem", { name: GLOSSY_LABEL }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj_1/documents/doc_bc/glossy",
		);
	});

	it("offers no Glossy item on a Business Case with the gate off", async () => {
		await renderList();
		await openMenu(downloadTriggerFor("Rollout business case"));

		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("offers no Glossy item on a PRD with the gate on", async () => {
		flags.glossy = true;
		await renderList();
		await openMenu(downloadTriggerFor("Checkout PRD"));

		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});
});

describe("projects.glossyEntry copy", () => {
	it("has every key, non-empty, in both locales", () => {
		const enKeys = en.projects.glossyEntry;
		const deKeys = de.projects.glossyEntry as Record<string, unknown>;
		for (const [key, value] of Object.entries(enKeys)) {
			expect(value, `en ${key}`).toMatch(/\S/);
			expect(deKeys[key], `de ${key}`).toEqual(
				expect.stringMatching(/\S/),
			);
		}
		expect(Object.keys(deKeys).sort()).toEqual(Object.keys(enKeys).sort());
	});
});
