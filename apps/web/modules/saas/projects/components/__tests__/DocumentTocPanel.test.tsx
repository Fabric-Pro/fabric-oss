import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DOCUMENT_TOC_STORAGE_KEY,
	type DocumentTocItem,
} from "../../lib/document-toc";
import { DocumentTocPanel } from "../DocumentTocPanel";

// next-intl is globally mocked in vitest.setup.ts (t returns the key), so
// assertions target translation keys, not English copy.

const item = (overrides: Partial<DocumentTocItem>): DocumentTocItem => ({
	id: "overview",
	text: "Overview",
	level: 1,
	pos: 0,
	...overrides,
});

const defaultItems: DocumentTocItem[] = [
	item({ id: "overview", text: "Overview", level: 1, pos: 0 }),
	item({ id: "scope", text: "Scope", level: 2, pos: 20 }),
	item({ id: "in-scope", text: "In Scope", level: 3, pos: 40 }),
];

afterEach(() => {
	localStorage.clear();
});

describe("DocumentTocPanel", () => {
	it("renders nothing at all when there are no headings (FR5)", () => {
		const { container } = render(
			<DocumentTocPanel items={[]} onNavigate={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for a heading-less document even when expansion was persisted", () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");

		const { container } = render(
			<DocumentTocPanel items={[]} onNavigate={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("lists every heading and indents entries by level", () => {
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const buttons = screen.getAllByRole("button", { hidden: true });
		// 3 entries + the spine toggle
		expect(buttons).toHaveLength(4);

		const overview = screen.getByText("Overview", {
			selector: "button",
		});
		const inScope = screen.getByText("In Scope", { selector: "button" });
		expect(overview.style.paddingInlineStart).toBe("8px");
		expect(inScope.style.paddingInlineStart).toBe("32px");
	});

	it("nests entries so the hierarchy is programmatically exposed, not just indented", () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		// defaultItems is H1 "Overview" → H2 "Scope" → H3 "In Scope".
		const overviewItem = screen
			.getByText("Overview", { selector: "button" })
			.closest("li") as HTMLElement;
		const scopeItem = screen
			.getByText("Scope", { selector: "button" })
			.closest("li") as HTMLElement;

		// A screen reader hears real nesting rather than a flat 3-item list.
		expect(overviewItem.querySelector("ul")).not.toBeNull();
		expect(overviewItem).toContainElement(scopeItem);
		expect(scopeItem.querySelector("ul")).not.toBeNull();
		expect(scopeItem).toContainElement(
			screen.getByText("In Scope", { selector: "button" }),
		);
	});

	it("raises the rail to xl when the host asks for it", () => {
		// A surface whose AI assistant starts expanded has 28rem less room, so
		// lg would leave the editor ~250px wide with both panels open.
		const { container } = render(
			<DocumentTocPanel
				items={defaultItems}
				onNavigate={vi.fn()}
				breakpoint="xl"
			/>,
		);

		const rail = container.firstElementChild as HTMLElement;
		expect(rail.className).toContain("xl:flex");
		expect(rail.className).not.toContain("lg:flex");
	});

	it("keeps the rail above the lg breakpoint only", () => {
		// The work area already gives up 72px to the app rail and 28rem to the
		// AI assistant; surfacing a further 256px at md would leave the
		// document almost no width. One class governs both the spine and the
		// list, because the spine is a flex child of the rail.
		const { container } = render(
			<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />,
		);

		const rail = container.firstElementChild as HTMLElement;
		expect(rail.className).toContain("lg:flex");
		expect(rail.className).not.toContain("md:flex");
	});

	it("keeps a full-height spine occupying real width while collapsed", () => {
		// The previous affordance was a 12x32 pill floating on the edge, below
		// the 24x24 target-size floor and half-clipped by the work area. The
		// spine is a laid-out column instead, so nothing can clip it.
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const spine = screen.getByRole("button", { name: "expand" });
		expect(spine.className).toContain("w-9");
		expect(spine.className).not.toContain("absolute");
		// The ring is inset so the work area's overflow-hidden cannot cut it.
		expect(spine.className).toContain("focus-visible:ring-inset");
	});

	it("names what the collapsed column opens", () => {
		// The caption is the whole point of the spine: collapsed is exactly
		// when it is the only thing explaining the column.
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const spine = screen.getByRole("button", { name: "expand" });
		expect(spine).toHaveTextContent("title");

		fireEvent.click(spine);
		expect(
			screen.getByRole("button", { name: "collapse" }),
		).toHaveTextContent("title");
	});

	it("does not gate the caption behind a display rule", () => {
		// The handoff hid the caption under `@[240px]/toc`, meant as a height
		// guard — but `@container` is inline-size, and the collapsed rail is
		// 36px WIDE, so the caption would have vanished in exactly the state
		// it exists for. jsdom loads no stylesheet, so a textContent check
		// passes either way; assert the class that would do the hiding.
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const caption = screen
			.getByRole("button", { name: "expand" })
			.querySelector("[class*='writing-mode']") as HTMLElement;

		expect(caption).not.toBeNull();
		// Token-wise, so the clipping mechanism itself (`overflow-hidden`)
		// isn't mistaken for a display gate.
		const classes = caption.className.split(/\s+/);
		expect(classes).not.toContain("hidden");
		expect(classes).not.toContain("sr-only");
		expect(classes.filter((c) => c.includes("@["))).toEqual([]);
		// The clip is what lets the caption stay in every state.
		expect(classes).toContain("overflow-hidden");
	});

	it("reports its state and target through aria on the spine", () => {
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const spine = screen.getByRole("button", { name: "expand" });
		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		expect(spine).toHaveAttribute("aria-expanded", "false");
		expect(spine).toHaveAttribute("aria-controls", nav.id);

		fireEvent.click(spine);
		expect(
			screen.getByRole("button", { name: "collapse" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("invokes onNavigate with the clicked item", () => {
		const onNavigate = vi.fn();
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		render(
			<DocumentTocPanel items={defaultItems} onNavigate={onNavigate} />,
		);

		fireEvent.click(screen.getByText("Scope", { selector: "button" }));

		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate).toHaveBeenCalledWith(defaultItems[1]);
	});

	it("is collapsed by default with the panel hidden from assistive tech", () => {
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		const collapsibleContainer = nav.parentElement as HTMLElement;
		expect(collapsibleContainer).toHaveAttribute("aria-hidden", "true");
		expect(collapsibleContainer.className).toContain("w-0");

		// The spine stays visible and labelled for expansion.
		expect(
			screen.getByRole("button", { name: "expand" }),
		).toBeInTheDocument();
	});

	it("expands via the spine and persists the choice", () => {
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: "expand" }));

		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		const collapsibleContainer = nav.parentElement as HTMLElement;
		expect(collapsibleContainer).toHaveAttribute("aria-hidden", "false");
		expect(collapsibleContainer.className).toContain("w-[220px]");
		expect(localStorage.getItem(DOCUMENT_TOC_STORAGE_KEY)).toBe("true");

		// The spine label flips to collapse.
		expect(
			screen.getByRole("button", { name: "collapse" }),
		).toBeInTheDocument();
	});

	it("starts expanded when a previous session persisted expansion", () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");

		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		expect(nav.parentElement).toHaveAttribute("aria-hidden", "false");
	});

	it("collapses back and persists false", () => {
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		render(<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: "collapse" }));

		expect(localStorage.getItem(DOCUMENT_TOC_STORAGE_KEY)).toBe("false");
		const nav = screen.getByLabelText("ariaLabel", { selector: "nav" });
		expect(nav.parentElement).toHaveAttribute("aria-hidden", "true");
	});

	it("survives storage failures without crashing", () => {
		const getItemSpy = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("storage disabled");
			});
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("storage disabled");
			});

		try {
			render(
				<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />,
			);

			// Falls back to the collapsed default and toggling still works.
			fireEvent.click(screen.getByRole("button", { name: "expand" }));
			expect(
				screen.getByRole("button", { name: "collapse" }),
			).toBeInTheDocument();
		} finally {
			getItemSpy.mockRestore();
			setItemSpy.mockRestore();
		}
	});

	it("exposes the full heading text via the title attribute for truncated entries", () => {
		const longText =
			"A very long heading title that will certainly be truncated in a narrow rail";
		render(
			<DocumentTocPanel
				items={[item({ id: "long", text: longText })]}
				onNavigate={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(longText, { selector: "button" }),
		).toHaveAttribute("title", longText);
	});

	it("neutralizes the Radix viewport's table wrapper so long entries can truncate", () => {
		// Radix wraps viewport content in a `display: table` div that
		// shrink-wraps to its widest child. Without the override, `w-full` on
		// an entry resolves against that wrapper instead of the rail, so a
		// long heading stretches past the panel and `truncate` never applies.
		// jsdom has no layout engine, so this locks the mechanism rather than
		// the measured width — the visual symptom was confirmed in a browser.
		localStorage.setItem(DOCUMENT_TOC_STORAGE_KEY, "true");
		const { container } = render(
			<DocumentTocPanel items={defaultItems} onNavigate={vi.fn()} />,
		);

		const viewport = container.querySelector(
			"[data-radix-scroll-area-viewport]",
		);
		expect(viewport).not.toBeNull();
		expect((viewport?.parentElement as HTMLElement).className).toContain(
			"[&_[data-radix-scroll-area-viewport]>div]:!block",
		);
	});

	it("labels headings that slugified from empty text with the untitled fallback", () => {
		render(
			<DocumentTocPanel
				items={[item({ id: "section", text: "" })]}
				onNavigate={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("untitled", { selector: "button" }),
		).toHaveAttribute("title", "untitled");
	});

	it("renders duplicate heading titles as distinct entries", () => {
		const onNavigate = vi.fn();
		const duplicates = [
			item({ id: "overview", text: "Overview", pos: 0 }),
			item({ id: "overview-1", text: "Overview", pos: 50 }),
		];
		render(<DocumentTocPanel items={duplicates} onNavigate={onNavigate} />);

		const entries = screen.getAllByText("Overview", { selector: "button" });
		expect(entries).toHaveLength(2);

		fireEvent.click(entries[1]);
		expect(onNavigate).toHaveBeenCalledWith(duplicates[1]);
	});
});
