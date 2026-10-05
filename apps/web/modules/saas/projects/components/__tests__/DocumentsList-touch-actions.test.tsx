/**
 * The document card without a mouse — and with one.
 *
 * Two defects, both invisible to a test that clicks a button directly.
 *
 * The action row (View, Download, Regenerate, Delete, …) is hidden until the
 * card is hovered. Hover styles apply only where the device can hover, so on a
 * tablet or phone the row never appeared — and stayed hit-testable, leaving
 * invisible buttons, Delete among them. A keyboard user tabbing into the row
 * focused buttons they could not see.
 *
 * And a click on the card did not open the document. The "Open" button covers
 * the card, but two decorative layers painted above it took every click on the
 * card body, and the title block took every click on the title. Only the
 * keyboard reached the button.
 *
 * jsdom evaluates no media queries and does no hit-testing, so these tests pin
 * the classes that carry the behaviour, as `ProjectFavoriteToggle.test.tsx`
 * does for the same kind of problem:
 *   - with a coarse pointer the row is always visible, sits on a line of its
 *     own under the title so it takes no width from the text, and its buttons
 *     are large enough to tap;
 *   - with keyboard focus inside the card the row is visible, and a button
 *     clicked with the mouse does not keep it visible;
 *   - with a mouse the row is still hidden until hover;
 *   - nothing but the card's own controls takes pointer events, so a click
 *     anywhere else reaches the "Open" button.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

const { documentsListMock } = vi.hoisted(() => ({
	documentsListMock: vi.fn(),
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

import { DocumentsList } from "../DocumentsList";

// ── Helpers ────────────────────────────────────────────────────

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Project Proposal",
		type: "PROPOSAL",
		status: "COMPLETE",
		source: "GENERATED",
		isActive: true,
		version: 2,
		wordCount: 6033,
		content: "# Proposal\n\nBody.",
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

async function renderWithDocument(document: Record<string, unknown>) {
	documentsListMock.mockResolvedValue({
		documents: [document],
		total: 1,
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
	await screen.findByText(String(document.title));
}

/** The card: the element every `group-*` class on it refers to. */
function card(title = "Project Proposal"): HTMLElement {
	const element = screen.getByText(title).closest(".group");
	if (!(element instanceof HTMLElement)) {
		throw new Error("the title is not inside a card");
	}
	return element;
}

/** The row that holds the card's action buttons. */
function actionRow(): HTMLElement {
	const row = screen.getByTitle("Delete").parentElement;
	if (!row) {
		throw new Error("the Delete button has no parent");
	}
	return row;
}

/** The block that holds the card's title and description. */
function titleBlock(title = "Project Proposal"): HTMLElement {
	const block = screen.getByText(title).closest("h3")?.parentElement;
	if (!block) {
		throw new Error("the title is not inside a title block");
	}
	return block;
}

const classes = (element: Element) => element.className.split(/\s+/);

// ── Tests ──────────────────────────────────────────────────────

describe("DocumentsList — card actions without a mouse", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
	});

	it("keeps the mouse behaviour: the row is hidden until the card is hovered", async () => {
		await renderWithDocument(makeDocument());

		expect(classes(actionRow())).toEqual(
			expect.arrayContaining(["opacity-0", "group-hover:opacity-100"]),
		);
	});

	it("shows the row on a touch device, which never hovers", async () => {
		await renderWithDocument(makeDocument());

		// A bare `opacity-0` leaves invisible but tappable buttons.
		expect(classes(actionRow())).toContain("pointer-coarse:opacity-100");
	});

	it("shows the row for keyboard focus inside the card, but not for a button the mouse clicked", async () => {
		await renderWithDocument(makeDocument());

		const rowClasses = classes(actionRow());
		expect(rowClasses).toContain("group-has-focus-visible:opacity-100");
		// `:focus-within` also matches a button that keeps focus after a mouse
		// click, which would leave the row shown once the pointer has left.
		expect(rowClasses).not.toContain("group-focus-within:opacity-100");
	});

	it("gives the row a line of its own on a touch device, so it takes no width from the title", async () => {
		await renderWithDocument(makeDocument());

		const row = actionRow();
		expect(classes(row)).toEqual(
			expect.arrayContaining([
				"pointer-coarse:basis-full",
				"pointer-coarse:justify-end",
			]),
		);
		// The row can only wrap if the header it sits in allows it.
		const header = row.parentElement as HTMLElement;
		expect(classes(header)).toContain("pointer-coarse:flex-wrap");
	});

	it.each([
		["View", makeDocument()],
		["Regenerate", makeDocument()],
		["Delete", makeDocument()],
		["Set as active", makeDocument({ isActive: false })],
	])(
		"makes %s large enough to tap on a touch device",
		async (title, document) => {
			await renderWithDocument(document);

			expect(classes(screen.getByTitle(title))).toContain(
				"pointer-coarse:size-11",
			);
		},
	);

	it("makes Mark as complete large enough to tap on a touch device", async () => {
		await renderWithDocument(makeDocument({ status: "DRAFT" }));

		expect(
			classes(screen.getByRole("button", { name: "Mark as complete" })),
		).toContain("pointer-coarse:size-11");
	});

	it("keeps the Active badge on a touch device, where the row no longer needs its place", async () => {
		await renderWithDocument(makeDocument());

		const badge = screen.getByText("Active").parentElement as HTMLElement;
		const badgeClasses = classes(badge);
		// With a mouse or a keyboard the badge still makes way for the row.
		expect(badgeClasses).toEqual(
			expect.arrayContaining([
				"group-hover:opacity-0",
				"not-pointer-coarse:group-has-focus-visible:opacity-0",
			]),
		);
		// Never for a coarse pointer, and never for mouse-click focus.
		expect(
			badgeClasses.some((name) => name.startsWith("pointer-coarse:")),
		).toBe(false);
		expect(badgeClasses.some((name) => name.includes("focus-within"))).toBe(
			false,
		);
	});

	it("ends the title block short of the Active badge, so a long title stops before it", async () => {
		await renderWithDocument(makeDocument());

		// A title truncates where its block ends. The block may shrink below
		// the title's width, and keeps the badge's corner free.
		const blockClasses = classes(titleBlock());
		expect(blockClasses).toEqual(
			expect.arrayContaining(["min-w-0", "flex-1", "pr-16"]),
		);
		expect(blockClasses).not.toContain("pointer-coarse:pr-0");
	});

	it("gives that corner back to the title on a touch device when the card has no Active badge", async () => {
		await renderWithDocument(makeDocument({ isActive: false }));

		// Nothing sits there on a touch device: the badge is absent and the
		// action row has a line of its own. Keeping the corner free would cut
		// the title short beside empty space.
		expect(classes(titleBlock())).toContain("pointer-coarse:pr-0");
	});
});

describe("DocumentsList — a click on the card opens the document", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
	});

	it("covers the card with the Open button", async () => {
		await renderWithDocument(makeDocument());

		const open = screen.getByRole("button", {
			name: "Open Project Proposal",
		});
		expect(open.parentElement).toBe(card());
		expect(classes(open)).toEqual(
			expect.arrayContaining(["absolute", "inset-0"]),
		);
	});

	it("lets no decorative layer take the click instead", async () => {
		await renderWithDocument(makeDocument());

		// Everything laid over the card besides the Open button itself: the
		// hover halo and the inner panel. They are painted above the button,
		// so each must pass pointer events through.
		const layers = [...card().children].filter(
			(child) =>
				child.tagName !== "BUTTON" &&
				classes(child).includes("absolute"),
		);
		expect(layers.length).toBeGreaterThanOrEqual(2);
		for (const layer of layers) {
			expect(classes(layer)).toContain("pointer-events-none");
		}
	});

	it("lets a click on the title or the description through", async () => {
		await renderWithDocument(makeDocument());

		// The card's content sits in one region that passes pointer events
		// through; nothing between it and the title may take them back.
		const heading = screen.getByRole("heading", {
			name: "Project Proposal",
		});
		let element: HTMLElement | null = heading;
		const taking: string[] = [];
		while (element && element !== card()) {
			if (classes(element).includes("pointer-events-auto")) {
				taking.push(element.tagName);
			}
			element = element.parentElement;
		}
		expect(taking).toEqual([]);
		const content = heading.closest(".pointer-events-none");
		expect(content).not.toBeNull();
		expect(card().contains(content)).toBe(true);
	});

	it("lets the gap beside the buttons through, and only the buttons take the click", async () => {
		await renderWithDocument(makeDocument());

		// On a touch device the row spans the card; the row itself must not be
		// a dead strip over the Open button.
		expect(classes(actionRow())).toEqual(
			expect.arrayContaining([
				"pointer-events-none",
				"*:pointer-events-auto",
			]),
		);
		expect(classes(actionRow())).not.toContain("pointer-events-auto");
	});

	it.each([
		["View", makeDocument()],
		["Regenerate", makeDocument()],
		["Delete", makeDocument()],
		["Set as active", makeDocument({ isActive: false })],
	])(
		"keeps %s taking the click while it is disabled",
		async (title, document) => {
			await renderWithDocument(document);

			// A disabled button is one whose action is in flight. The shared
			// button makes a disabled button transparent to the pointer, and the
			// row around it is transparent too, so a second click on the spinner
			// would land on the Open button and leave the page.
			const buttonClasses = classes(screen.getByTitle(title));
			expect(buttonClasses).toContain("disabled:pointer-events-auto");
			expect(buttonClasses).not.toContain("disabled:pointer-events-none");
		},
	);

	it("keeps Mark as complete taking the click while it is disabled", async () => {
		await renderWithDocument(makeDocument({ status: "DRAFT" }));

		const buttonClasses = classes(
			screen.getByRole("button", { name: "Mark as complete" }),
		);
		expect(buttonClasses).toContain("disabled:pointer-events-auto");
		expect(buttonClasses).not.toContain("disabled:pointer-events-none");
	});

	it("gives pointer events to nothing in the card but its buttons", async () => {
		await renderWithDocument(makeDocument());

		// Anything else that takes pointer events — a footer, a wrapper — is a
		// dead zone over the Open button.
		const taking = [
			...card().querySelectorAll(".pointer-events-auto"),
		].filter((element) => element.tagName !== "BUTTON");
		expect(taking).toEqual([]);
	});

	it("renders nothing but elements for a failed document with no content", async () => {
		// `hasContent` used to evaluate to the number 0 here, and React
		// rendered it: a stray "0" in the action row and at the top of the
		// card.
		await renderWithDocument(
			makeDocument({ status: "FAILED", wordCount: 0, content: "" }),
		);

		expect(
			screen.queryByRole("button", { name: "Open Project Proposal" }),
		).not.toBeInTheDocument();
		const stray = (parent: Element) =>
			[...parent.childNodes]
				.filter((node) => node.nodeType === Node.TEXT_NODE)
				.map((node) => node.textContent);
		expect(stray(card())).toEqual([]);
		expect(stray(actionRow())).toEqual([]);
	});
});
