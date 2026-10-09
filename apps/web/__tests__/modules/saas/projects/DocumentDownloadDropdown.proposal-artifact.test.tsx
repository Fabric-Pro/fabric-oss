/**
 * Downloads and the Glossy entry of a Proposal under the `PROPOSAL_ARTIFACT`
 * rollout gate (Fizzy #2801).
 *
 * Export is Main only. PDF and DOCX read the document through
 * `projects.documents.get` and render its `content` — the client-ready Main
 * document — and nothing else: the Internal Analysis lives in its own tables
 * behind its own procedures, so the proof is that an export makes exactly one
 * client call, the document read. The oRPC client is a recording proxy, so a
 * call to any other procedure, present or future, shows up by name.
 *
 * The visuals a coordinated run writes into Main are mermaid fences, and an
 * export renders each as an image, not as its source text. Only what jsdom
 * cannot do is stubbed: the canvas step (`svgToPng`) and the diagram engine;
 * the PDF and DOCX renderers run for real, with jsPDF's `addImage` and docx's
 * `ImageRun` recorded.
 *
 * The Glossy item: such a Proposal needs no Glossy edition, so the menu, and
 * the list that hands it the link, offer the item only when a legacy edition
 * was published. A Business Case, and everything with the gate off, are
 * unchanged.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────

const PNG_1PX =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const rec = vi.hoisted(() => {
	const calls: string[] = [];
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	/**
	 * An oRPC client stand-in that answers any procedure path: a call is
	 * recorded by its dotted path and served by `handlers`, or refused.
	 */
	function client(path: string[] = []): unknown {
		return new Proxy(() => undefined, {
			get: (_target, prop) =>
				typeof prop === "string" && prop !== "then"
					? client([...path, prop])
					: undefined,
			apply: (_target, _self, args: unknown[]) => {
				const key = path.join(".");
				calls.push(key);
				const handler = handlers[key];
				return handler
					? handler(...args)
					: Promise.reject(new Error(`unexpected call: ${key}`));
			},
		});
	}
	return {
		calls,
		handlers,
		client,
		flags: { glossy: false, proposalArtifact: false },
		mermaidSources: [] as string[],
		pdfImages: [] as string[],
		docxImages: 0,
		docxTexts: [] as string[],
		downloads: [] as { blob: Blob; filename: string }[],
		documentsList: vi.fn(),
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: rec.client() }));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "GLOSSY_EDITION"
			? rec.flags.glossy
			: key === "PROPOSAL_ARTIFACT"
				? rec.flags.proposalArtifact
				: false,
}));

// The browser download itself; the renderers in this module stay real.
vi.mock("@saas/projects/lib/markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/lib/markdown-to-document")
		>();
	return {
		...actual,
		triggerBlobDownload: (blob: Blob, filename: string) => {
			rec.downloads.push({ blob, filename });
		},
	};
});

// The canvas step jsdom cannot run: any diagram SVG becomes a 1px PNG.
vi.mock(
	"@saas/projects/lib/document-export-helpers",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/lib/document-export-helpers")
			>();
		return {
			...actual,
			svgToPng: async () => ({
				dataUrl: PNG_1PX,
				width: 240,
				height: 120,
			}),
		};
	},
);

// The diagram engine the export tries first; it records what it was handed.
vi.mock("beautiful-mermaid", () => ({
	renderMermaidSVG: (code: string) => {
		rec.mermaidSources.push(code);
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"></svg>';
	},
}));

vi.mock("jspdf", async (importOriginal) => {
	const actual = await importOriginal<typeof import("jspdf")>();
	class RecordingPdf extends actual.jsPDF {
		constructor(...args: ConstructorParameters<typeof actual.jsPDF>) {
			super(...args);
			// jsPDF copies its API onto each instance, so the override goes
			// there too. Recorded rather than decoded: what matters is that
			// the diagram went in as an image.
			this.addImage = ((...imageArgs: unknown[]) => {
				rec.pdfImages.push(String(imageArgs[0]));
				return this;
			}) as typeof this.addImage;
		}
	}
	return { ...actual, jsPDF: RecordingPdf, default: RecordingPdf };
});

vi.mock("docx", async (importOriginal) => {
	const actual = await importOriginal<typeof import("docx")>();
	class ImageRun extends actual.ImageRun {
		constructor(options: ConstructorParameters<typeof actual.ImageRun>[0]) {
			super(options);
			rec.docxImages += 1;
		}
	}
	class Paragraph extends actual.Paragraph {
		constructor(
			options: ConstructorParameters<typeof actual.Paragraph>[0],
		) {
			super(options);
			if (typeof options === "string") {
				rec.docxTexts.push(options);
			} else if (options?.text) {
				rec.docxTexts.push(options.text);
			}
		}
	}
	class TextRun extends actual.TextRun {
		constructor(options: ConstructorParameters<typeof actual.TextRun>[0]) {
			super(options);
			rec.docxTexts.push(
				typeof options === "string"
					? options
					: String(options.text ?? ""),
			);
		}
	}
	return { ...actual, ImageRun, Paragraph, TextRun };
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

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
							queryFn: () => rec.documentsList(input),
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
vi.mock("@saas/projects/components/CreateDocumentDialog", () => ({
	CreateDocumentDialog: () => null,
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: ({ title }: { title: string }) => <>{title}</>,
}));
vi.mock("@saas/projects/components/ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { DocumentDownloadDropdown } from "@saas/projects/components/DocumentDownloadDropdown";
import { DocumentsList } from "@saas/projects/components/DocumentsList";

// ── Fixtures and helpers ─────────────────────────────────────────────────

const MERMAID_SOURCE = "flowchart LR\n  Discovery --> Build --> Launch";

/** A client-ready Main document with one visual, as a coordinated run saves it. */
const MAIN_CONTENT = [
	"# Example proposal",
	"",
	"## Delivery plan",
	"",
	"The rollout runs in three phases.",
	"",
	"```mermaid",
	MERMAID_SOURCE,
	"```",
	"",
	"## Investment",
	"",
	"A fixed fee per phase.",
].join("\n");

const GLOSSY_LABEL = "menuItem";
const GLOSSY_HREF = "/app/example-org/projects/proj_1/documents/doc_1/glossy";

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDropdown(
	props: Partial<Parameters<typeof DocumentDownloadDropdown>[0]> = {},
) {
	return render(
		<QueryClientProvider client={newClient()}>
			<DocumentDownloadDropdown
				documentId="doc_1"
				title="Example proposal"
				projectId="proj_1"
				documentType="PROPOSAL"
				organizationId="org_1"
				{...props}
			/>
		</QueryClientProvider>,
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

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsText(blob);
	});
}

function publishedEdition() {
	return {
		edition: { content: { sections: [] } },
		build: { status: "idle" },
	};
}

function resetRecords() {
	rec.calls.length = 0;
	for (const key of Object.keys(rec.handlers)) {
		delete rec.handlers[key];
	}
	rec.mermaidSources.length = 0;
	rec.pdfImages.length = 0;
	rec.docxImages = 0;
	rec.docxTexts.length = 0;
	rec.downloads.length = 0;
	rec.documentsList.mockReset();
	rec.flags.glossy = false;
	rec.flags.proposalArtifact = false;
}

// ── Export: Main only, visuals as images ─────────────────────────────────

describe("DocumentDownloadDropdown — export of a Proposal under the Proposal artifact gate", () => {
	beforeEach(() => {
		resetRecords();
		rec.flags.proposalArtifact = true;
		rec.handlers["projects.documents.get"] = async () => ({
			document: { content: MAIN_CONTENT },
		});
	});

	it("builds the PDF from the document read alone, with the visual as an image", async () => {
		const user = await (async () => {
			renderDropdown();
			return openMenu();
		})();
		await user.click(screen.getByRole("menuitem", { name: "PDF (.pdf)" }));

		await waitFor(() => expect(rec.downloads).toHaveLength(1));
		// One client call, and it is the document read: no analysis, no
		// style, no other procedure is consulted for an export.
		expect(rec.calls).toEqual(["projects.documents.get"]);
		expect(rec.calls.some((call) => /proposalArtifact/i.test(call))).toBe(
			false,
		);

		expect(rec.downloads[0].filename).toBe("example-proposal.pdf");
		expect(rec.mermaidSources).toEqual([MERMAID_SOURCE]);
		expect(rec.pdfImages).toEqual([PNG_1PX]);
		const pdf = await readBlobText(rec.downloads[0].blob);
		expect(pdf).toContain("Delivery plan");
		expect(pdf).toContain("A fixed fee per phase.");
		// The diagram went in as an image, not as its source or a placeholder.
		expect(pdf).not.toContain("Discovery --> Build");
		expect(pdf).not.toContain("[Diagram:");
	});

	it("builds the DOCX from the document read alone, with the visual as an image", async () => {
		renderDropdown();
		const user = await openMenu();
		await user.click(
			screen.getByRole("menuitem", { name: "Word (.docx)" }),
		);

		await waitFor(() => expect(rec.downloads).toHaveLength(1));
		expect(rec.calls).toEqual(["projects.documents.get"]);

		expect(rec.downloads[0].filename).toBe("example-proposal.docx");
		expect(rec.mermaidSources).toEqual([MERMAID_SOURCE]);
		expect(rec.docxImages).toBe(1);
		expect(rec.docxTexts).toEqual(
			expect.arrayContaining(["Delivery plan", "A fixed fee per phase."]),
		);
		expect(rec.docxTexts.join("\n")).not.toMatch(
			/Discovery --> Build|\[Diagram:/,
		);
	});

	it("reads the document in the route's organization", async () => {
		const read = vi.fn(async () => ({ document: { content: "# Plan" } }));
		rec.handlers["projects.documents.get"] = read;
		renderDropdown({ organizationId: "org_route" });
		const user = await openMenu();
		await user.click(screen.getByRole("menuitem", { name: "PDF (.pdf)" }));

		await waitFor(() =>
			expect(read).toHaveBeenCalledWith({
				projectId: "proj_1",
				id: "doc_1",
				organizationId: "org_route",
			}),
		);
	});
});

// ── The Glossy item in the menu ──────────────────────────────────────────

describe("DocumentDownloadDropdown — Glossy item under the Proposal artifact gate", () => {
	beforeEach(() => {
		resetRecords();
		rec.flags.glossy = true;
		rec.flags.proposalArtifact = true;
	});

	it("withholds it from a Proposal without a published edition", async () => {
		rec.handlers["projects.glossy.get"] = async () => ({
			edition: null,
			build: { status: "idle" },
		});
		renderDropdown({ glossyHref: GLOSSY_HREF });
		await openMenu();

		await waitFor(() => expect(rec.calls).toEqual(["projects.glossy.get"]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "PDF (.pdf)" }),
		).toBeInTheDocument();
	});

	it("offers it on a Proposal whose legacy edition was published", async () => {
		rec.handlers["projects.glossy.get"] = async () => publishedEdition();
		renderDropdown({ glossyHref: GLOSSY_HREF });
		await openMenu();

		expect(
			await screen.findByRole("menuitem", { name: GLOSSY_LABEL }),
		).toHaveAttribute("href", GLOSSY_HREF);
	});

	it("leaves a Business Case's item alone, asking nothing", async () => {
		renderDropdown({
			documentType: "BUSINESS_CASE",
			glossyHref: GLOSSY_HREF,
		});
		await openMenu();

		expect(
			screen.getByRole("menuitem", { name: GLOSSY_LABEL }),
		).toHaveAttribute("href", GLOSSY_HREF);
		expect(rec.calls).toEqual([]);
	});

	it("leaves a Proposal's item alone with the artifact gate off", async () => {
		rec.flags.proposalArtifact = false;
		renderDropdown({ glossyHref: GLOSSY_HREF });
		await openMenu();

		expect(
			screen.getByRole("menuitem", { name: GLOSSY_LABEL }),
		).toHaveAttribute("href", GLOSSY_HREF);
		expect(rec.calls).toEqual([]);
	});
});

// ── The list decides, for the menu and the tour anchor alike ────────────

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
		updatedAt: new Date("2026-10-07T10:00:00Z"),
		createdAt: new Date("2026-10-07T10:00:00Z"),
		_count: { versions: 0 },
		...overrides,
	};
}

async function renderList() {
	rec.documentsList.mockResolvedValue({
		documents: [
			makeDocument({
				id: "doc_proposal",
				title: "Example proposal",
				type: "PROPOSAL",
			}),
			makeDocument({
				id: "doc_bc",
				title: "Example business case",
				type: "BUSINESS_CASE",
			}),
		],
		total: 2,
		hasMore: false,
	});
	const view = render(
		<QueryClientProvider client={newClient()}>
			<DocumentsList projectId="proj_1" enableDelete />
		</QueryClientProvider>,
	);
	await screen.findByText("Example proposal");
	return view;
}

/** The card that carries `title`. */
function cardFor(title: string): HTMLElement {
	const card = screen.getByRole("button", {
		name: `Open ${title}`,
	}).parentElement;
	if (!card) {
		throw new Error(`no card for ${title}`);
	}
	return card;
}

const anchorOn = (title: string) =>
	cardFor(title).querySelector('[data-onboarding-target="documents-glossy"]');

describe("DocumentsList — Glossy item under the Proposal artifact gate", () => {
	beforeEach(() => {
		resetRecords();
		rec.flags.glossy = true;
		rec.flags.proposalArtifact = true;
	});

	it("hands a Proposal without an edition no Glossy link, and keeps the Business Case's", async () => {
		rec.handlers["projects.glossy.get"] = async () => ({
			edition: null,
			build: { status: "idle" },
		});
		await renderList();
		await waitFor(() => expect(rec.calls).toContain("projects.glossy.get"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Read before a menu opens: an open menu hides the rest of the page
		// from the accessibility tree.
		expect(anchorOn("Example business case")).not.toBeNull();
		expect(anchorOn("Example proposal")).toBeNull();
		await openMenu(
			within(cardFor("Example proposal")).getByRole("button", {
				name: "Download",
			}),
		);
		expect(
			screen.queryByRole("menuitem", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("hands a Proposal with a published edition its Glossy link and anchor", async () => {
		rec.handlers["projects.glossy.get"] = async () => publishedEdition();
		await renderList();

		await waitFor(() =>
			expect(anchorOn("Example proposal")).not.toBeNull(),
		);
		await openMenu(
			within(cardFor("Example proposal")).getByRole("button", {
				name: "Download",
			}),
		);
		expect(
			await screen.findByRole("menuitem", { name: GLOSSY_LABEL }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj_1/documents/doc_proposal/glossy",
		);
		// One edition read per Proposal, shared by the list and its menu.
		expect(
			rec.calls.filter((call) => call === "projects.glossy.get"),
		).toHaveLength(1);
	});
});
