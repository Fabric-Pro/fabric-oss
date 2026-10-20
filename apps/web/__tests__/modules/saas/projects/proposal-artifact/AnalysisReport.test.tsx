/**
 * `AnalysisReport` — the report of the shown analysis run in the Internal
 * Analysis tab (Fizzy #2946).
 *
 * Pinned here:
 *  - the assessment, summary and before-sending list show at once; the full
 *    text opens on demand, by click or keyboard, and nothing renders for a
 *    report with nothing to show;
 *  - `[S<N>]` becomes a source chip only in text, and only for a number the
 *    server resolved — never from a link, reference definition, footnote or
 *    code the model wrote — with the evidence chips' kinds and names;
 *  - the text renders without HTML, links, images or live URLs; headings sit
 *    below the trigger, and tables and code scroll in their own container;
 *  - a report stored as plain text, or one whose rendering throws, shows as
 *    escaped text under a note, and the rest of the report stays;
 *  - the parse is memoised: an identical render does not parse again.
 *
 * `next-intl` resolves the real en.json and de.json, so a missing or renamed
 * string fails the test.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const intl = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const en = (await import("@repo/i18n/translations/en.json")).default;
	const de = (await import("@repo/i18n/translations/de.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			const key = `${intl.locale}:${namespace}`;
			if (!translators.has(key)) {
				translators.set(
					key,
					createTranslator({
						locale: intl.locale,
						messages: intl.locale === "de" ? de : en,
						namespace: namespace as never,
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(key);
		},
		useLocale: () => intl.locale,
	};
});

const parse = vi.hoisted(() => ({ fail: false }));

vi.mock(
	"@saas/projects/components/proposal-artifact/report-citations-remark",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/components/proposal-artifact/report-citations-remark")
			>();
		return {
			...actual,
			remarkReportCitations: vi.fn(
				(
					options: Parameters<typeof actual.remarkReportCitations>[0],
				) => {
					if (parse.fail) {
						throw new Error("The renderer failed");
					}
					return actual.remarkReportCitations(options);
				},
			),
		};
	},
);

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { REPORT_CITATION_SCAN_MAX_MARKERS } from "@repo/utils/proposal-artifact/report-text";
import {
	AnalysisReport,
	type ProposalAnalysisReport,
} from "@saas/projects/components/proposal-artifact/AnalysisReport";
import { remarkReportCitations } from "@saas/projects/components/proposal-artifact/report-citations-remark";
import type { ProposalAnalysisEvidence } from "@saas/projects/components/proposal-artifact/use-proposal-analysis";
import { report } from "./proposal-artifact-fixtures";

const copy = en.projects.proposalArtifact.analysis.report;
const evidenceCopy = en.projects.proposalArtifact.analysis.evidence;

const CONTEXT_HREF = "/app/example-org/projects/project-1/contexts/ctx-1";

const linkSource = (source = 2): ProposalAnalysisEvidence => ({
	source,
	kind: "projectContext",
	contextType: "LINK",
	title: "Kickoff notes",
	excerpt: "The client wants SSO.",
	link: { contextId: "ctx-1", href: CONTEXT_HREF },
});
const companySource = (source = 2): ProposalAnalysisEvidence => ({
	source,
	kind: "company",
	title: "Rate card",
	excerpt: "Senior rate is fixed.",
});
const summarySource = (source = 2): ProposalAnalysisEvidence => ({
	source,
	kind: "summary",
	title: null,
});
const removedSource = (source = 2): ProposalAnalysisEvidence => ({
	source,
	kind: "removed",
});

const cites = (...evidence: ProposalAnalysisEvidence[]) =>
	evidence.map((item) => ({ source: item.source, evidence: item }));

/** The report with its own "Full report" state, as the panel holds it. */
function Harness({
	value,
	initiallyOpen = false,
}: {
	value: ProposalAnalysisReport | null;
	initiallyOpen?: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<div>
			<p>Sibling content</p>
			<AnalysisReport report={value} open={open} onOpenChange={setOpen} />
		</div>
	);
}

function renderReport(value: ProposalAnalysisReport | null) {
	return render(<Harness value={value} />);
}

function trigger(name: string | RegExp = copy.fullReport) {
	return screen.getByRole("button", { name });
}

/** Render a report with this text and these citations, opened. */
async function renderOpen(
	text: string,
	citations: ProposalAnalysisReport["citations"] = [],
	overrides: Partial<ProposalAnalysisReport> = {},
) {
	const view = renderReport(report({ text, citations, ...overrides }));
	await userEvent.click(trigger(new RegExp(copy.fullReport)));
	return view;
}

function chips(container: HTMLElement) {
	return [
		...container.querySelectorAll<HTMLElement>(
			"[data-slot='report-citation']",
		),
	];
}

afterEach(() => {
	intl.locale = "en";
	parse.fail = false;
	vi.mocked(remarkReportCitations).mockClear();
	vi.restoreAllMocks();
});

describe("AnalysisReport — what shows at once", () => {
	it("shows the heading, assessment, summary and before-sending list, with the full report closed", () => {
		renderReport(
			report({
				assessment: "Ready to send after two fixes",
				summary: "Covers the brief.\nTwo gaps remain.",
				beforeSending: ["Confirm the hosting region", "Name the PM"],
				text: "## Detail\n\nThe full text.",
			}),
		);

		expect(
			screen.getByRole("heading", { level: 3, name: copy.title }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Ready to send after two fixes"),
		).toBeInTheDocument();
		const summary = screen.getByText(/Covers the brief\./);
		expect(summary.textContent).toBe("Covers the brief.\nTwo gaps remain.");
		expect(summary).toHaveClass("whitespace-pre-line");
		expect(
			screen.getByRole("heading", { level: 4, name: copy.beforeSending }),
		).toBeInTheDocument();
		const list = screen.getByRole("list");
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Confirm the hosting region", "Name the PM"]);

		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		expect(trigger().closest("h4")).not.toBeNull();
		expect(screen.queryByText("The full text.")).not.toBeInTheDocument();
	});

	it("opens and closes the full report by click", async () => {
		renderReport(report({ text: "The full text." }));

		await userEvent.click(trigger());
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("The full text.")).toBeInTheDocument();

		await userEvent.click(trigger());
		expect(screen.queryByText("The full text.")).not.toBeInTheDocument();
	});

	it("opens the full report with Enter and with Space", async () => {
		renderReport(report({ text: "The full text." }));

		trigger().focus();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByText("The full text.")).toBeInTheDocument();
		await userEvent.keyboard("{Enter}");
		expect(screen.queryByText("The full text.")).not.toBeInTheDocument();

		await userEvent.keyboard(" ");
		expect(screen.getByText("The full text.")).toBeInTheDocument();
		expect(trigger()).toHaveFocus();
	});

	it("renders nothing for no report, or one with only scope items", () => {
		const none = renderReport(null);
		expect(none.container.querySelector("section")).toBeNull();
		expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
		none.unmount();

		const scopeOnly = renderReport(
			report({
				assessment: " ",
				summary: "",
				beforeSending: ["  "],
				text: null,
				scope: [
					{
						item: "Hosting",
						priority: "MUST",
						inProposal: "Yes",
						note: "Covered",
					},
				],
				duringDiscovery: ["Ask about SSO"],
			}),
		);
		expect(scopeOnly.container.querySelector("section")).toBeNull();
		expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
		expect(screen.queryByText("Hosting")).not.toBeInTheDocument();
	});

	it("offers no full report when the text is missing or blank", () => {
		const missing = renderReport(report({ text: null }));
		expect(screen.getByText(copy.title)).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		missing.unmount();

		renderReport(report({ text: "  \n " }));
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("marks a shortened full report on its trigger", () => {
		renderReport(report({ text: "The full text.", textTruncated: true }));

		expect(
			trigger(`${copy.fullReport} ${copy.shortened}`),
		).toBeInTheDocument();
	});

	it("wraps a long assessment instead of setting it as a badge", () => {
		const assessment = `Ready ${"to send after many careful fixes ".repeat(20)}`;
		const { container } = renderReport(report({ assessment }));

		const element = screen.getByText(assessment.trim());
		expect(element.closest("[data-slot='badge']")).toBeNull();
		let node: HTMLElement | null = element;
		while (node && node !== container) {
			expect(node.className).not.toMatch(/whitespace-nowrap|truncate/);
			node = node.parentElement;
		}
	});

	it("renders the chrome in German", async () => {
		intl.locale = "de";
		const deCopy = de.projects.proposalArtifact.analysis.report;
		renderReport(
			report({
				text: "**Fett**",
				textTruncated: true,
				plainText: true,
			}),
		);

		expect(
			screen.getByRole("heading", { level: 3, name: deCopy.title }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				level: 4,
				name: deCopy.beforeSending,
			}),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: `${deCopy.fullReport} ${deCopy.shortened}`,
			}),
		);
		expect(screen.getByText(deCopy.plainTextNote)).toBeInTheDocument();
	});

	it("has every report string in German too", () => {
		const deCopy = de.projects.proposalArtifact.analysis.report;
		expect(Object.keys(deCopy).sort()).toEqual(Object.keys(copy).sort());
		for (const value of Object.values(deCopy)) {
			expect(typeof value).toBe("string");
			expect(value.trim()).not.toBe("");
		}
		expect(deCopy.title).not.toBe(copy.title);
		expect(deCopy.plainTextNote).not.toBe(copy.plainTextNote);
	});
});

describe("AnalysisReport — citations", () => {
	it("links a cited LINK context to its in-app page in a new tab", async () => {
		const { container } = await renderOpen(
			"The client wants SSO [S2].",
			cites(linkSource()),
		);

		const link = screen.getByRole("link", {
			name: `S2: Kickoff notes ${evidenceCopy.opensInNewTab}`,
		});
		expect(link).toHaveAttribute("href", CONTEXT_HREF);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(link.textContent).toContain("S2");
		expect(chips(container)).toHaveLength(1);
		expect(container).not.toHaveTextContent("[S2]");
	});

	it("renders a chip for a marker in a heading, a table cell and a blockquote", async () => {
		const { container } = await renderOpen(
			[
				"# Hosting [S2]",
				"",
				"| Item | Source |",
				"| --- | --- |",
				"| Hosting | [S2] |",
				"",
				"> Quoted [S2]",
			].join("\n"),
			cites(linkSource()),
		);

		const links = screen.getAllByRole("link", { name: /^S2: / });
		expect(links).toHaveLength(3);
		expect(links[0]?.closest("h5")).not.toBeNull();
		expect(links[1]?.closest("td")).not.toBeNull();
		expect(links[2]?.closest("blockquote")).not.toBeNull();
		expect(chips(container)).toHaveLength(3);
	});

	it("keeps unlisted markers, model-written links, definitions, footnotes and code as text", async () => {
		const { container } = await renderOpen(
			[
				"Not emitted [S9].",
				"",
				"A link [x](#ref-S2) and [S2](https://example.com) and [[S2]](#ref-S2).",
				"",
				"[S2]: javascript:alert(1)",
				"",
				"Later [S2] usage.",
				"",
				"A footnote [^S2].",
				"",
				"Inline `[S2]` code.",
				"",
				"```text",
				"[S2] in a fence",
				"```",
			].join("\n"),
			cites(linkSource()),
		);

		expect(chips(container)).toEqual([]);
		expect(container.querySelector("a")).toBeNull();
		expect(container).toHaveTextContent("Not emitted [S9].");
		expect(container).toHaveTextContent("A footnote [^S2].");
		expect(screen.getByText("[S2]", { selector: "code" })).toBeVisible();
		expect(
			screen.getByText("[S2] in a fence", { selector: "code" }),
		).toBeVisible();
		expect(container.querySelector("[href]")).toBeNull();
		expect(container.innerHTML).not.toMatch(/javascript:/);
	});

	it("keeps a marker inside a model-written link as text", async () => {
		const { container } = await renderOpen(
			"See [[S2]](#ref-S2) and [see [S2] here](https://example.com).",
			cites(linkSource()),
		);

		expect(chips(container)).toEqual([]);
		expect(container.querySelector("a, [href]")).toBeNull();
		expect(container).toHaveTextContent("See [S2] and see [S2] here.");
	});

	it("names a removed source", async () => {
		const { container } = await renderOpen(
			"Cited [S2].",
			cites(removedSource()),
		);

		const [chip] = chips(container);
		expect(chip?.textContent).toBe("S2 · Source removed");
		expect(chip?.querySelector("a, button")).toBeNull();
	});

	it("opens a company source in a popover, with no link", async () => {
		const { container } = await renderOpen(
			"Rates are fixed [S2].",
			cites(companySource()),
		);

		expect(container.querySelector("a")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "S2: Rate card" }),
		);
		const popover = await screen.findByRole("dialog");
		expect(within(popover).getByText("Rate card")).toBeInTheDocument();
		expect(
			within(popover).getByText("Senior rate is fixed."),
		).toBeInTheDocument();
	});

	it("shows a plain source's title beside its first chip only", async () => {
		const { container } = await renderOpen(
			"First [S2]. Again [S2]. And [S2].",
			cites(summarySource()),
		);

		const all = chips(container);
		expect(all).toHaveLength(3);
		const title = evidenceCopy.kind.summary;
		const visibleTitle = (chip: HTMLElement | undefined) =>
			chip?.querySelector("span:not(.sr-only):not([data-slot='badge'])")
				?.textContent ?? null;
		expect(visibleTitle(all[0])).toBe(title);
		expect(visibleTitle(all[1])).toBeNull();
		expect(visibleTitle(all[2])).toBeNull();
		// Screen readers still hear the source at every chip.
		for (const chip of all) {
			expect(chip.textContent).toBe(`S2 ${title}`);
			expect(chip.querySelector("a, button")).toBeNull();
		}
	});

	it("renders no more chips than the server scans markers, leaving the later markers as text", async () => {
		// 1,000 markers in paragraphs of 20, as a report that passes the
		// server's structure checks can hold them.
		const paragraph = Array.from({ length: 20 }, () => "Cited [S1].").join(
			" ",
		);
		const text = Array.from({ length: 50 }, () => paragraph).join("\n\n");
		const { container } = await renderOpen(text, cites(summarySource(1)));

		const all = chips(container);
		expect(all).toHaveLength(REPORT_CITATION_SCAN_MAX_MARKERS);
		// A chip shows "S1", never the bracketed marker.
		expect(container.textContent?.match(/\[S1\]/g)).toHaveLength(
			1_000 - REPORT_CITATION_SCAN_MAX_MARKERS,
		);
		const title = evidenceCopy.kind.summary;
		const visibleTitle = (chip: HTMLElement | undefined) =>
			chip?.querySelector("span:not(.sr-only):not([data-slot='badge'])")
				?.textContent ?? null;
		expect(visibleTitle(all[0])).toBe(title);
		expect(all.slice(1).map(visibleTitle)).toEqual(
			Array.from(
				{ length: REPORT_CITATION_SCAN_MAX_MARKERS - 1 },
				() => null,
			),
		);
		// The chips are the first markers in document order.
		const paragraphs = [...container.querySelectorAll("p")].filter((p) =>
			p.textContent?.includes("Cited"),
		);
		expect(paragraphs).toHaveLength(50);
		for (const [index, p] of paragraphs.entries()) {
			const before = index * 20;
			expect(chips(p)).toHaveLength(
				Math.min(
					20,
					Math.max(0, REPORT_CITATION_SCAN_MAX_MARKERS - before),
				),
			);
		}
	});

	it("names each kind of chip with its S number", async () => {
		const { container } = await renderOpen(
			"Link [S1]. Popover [S2]. Plain [S3]. Removed [S4].",
			cites(
				linkSource(1),
				companySource(2),
				{ source: 3, kind: "other", title: "Call notes" },
				removedSource(4),
			),
		);

		expect(
			screen.getByRole("link", {
				name: `S1: Kickoff notes ${evidenceCopy.opensInNewTab}`,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "S2: Rate card" }),
		).toBeInTheDocument();
		const [, , plain, removed] = chips(container);
		expect(plain?.textContent).toContain("S3");
		expect(plain?.textContent).toContain("Call notes");
		expect(removed?.textContent).toContain("S4");
	});
});

describe("AnalysisReport — what the text may render", () => {
	it("renders no script, image, frame, live link or raw HTML", async () => {
		const { container } = await renderOpen(
			[
				"<script>alert(1)</script>",
				"",
				"<img src=x onerror=alert(1)>",
				"",
				"Text with [x](javascript:alert(1)) inside.",
				"",
				"![a](https://example.com/a.png)",
				"",
				"<table><tr><td>Raw cell</td></tr></table>",
				"",
				'<iframe src="https://example.com/frame"></iframe>',
				"",
				"Cited [S2].",
			].join("\n"),
			cites(linkSource()),
		);

		expect(
			container.querySelector("script, img, iframe, table"),
		).toBeNull();
		const hrefs = [...container.querySelectorAll("a[href]")].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toEqual([CONTEXT_HREF]);
		expect(container).toHaveTextContent("Text with x inside.");
		expect(container).not.toHaveTextContent("Raw cell");
		expect(container.innerHTML).not.toMatch(
			/onerror|javascript:|example\.com\/a\.png|<script/,
		);
	});

	it("renders headings below the trigger, and tables and code in their own scroll container", async () => {
		const { container } = await renderOpen(
			[
				"# One",
				"## Two",
				"###### Six",
				"",
				"| A | B |",
				"| --- | --- |",
				"| 1 | 2 |",
				"",
				"```mermaid",
				"graph TD; A-->B",
				"```",
			].join("\n"),
		);

		const content = container.querySelector(
			"[data-slot='collapsible-content']",
		) as HTMLElement;
		expect(content.querySelector("h1, h2, h3, h4, h6")).toBeNull();
		expect(
			within(content)
				.getAllByRole("heading", { level: 5 })
				.map((heading) => heading.textContent),
		).toEqual(["One", "Two", "Six"]);
		expect(content.querySelector("table")?.parentElement).toHaveClass(
			"overflow-x-auto",
		);
		expect(content.querySelector("pre")?.parentElement).toHaveClass(
			"overflow-x-auto",
		);
		expect(content.querySelector("pre")?.textContent).toContain(
			"graph TD; A-->B",
		);
		expect(content.querySelector("svg")).toBeNull();
	});
});

describe("AnalysisReport — plain text", () => {
	const markup = "**Not bold** _not em_\n# Not a heading\n<b>tag</b>";

	it("shows a report stored as plain text escaped, under the note", async () => {
		const { container } = await renderOpen(markup, cites(linkSource()), {
			plainText: true,
		});

		expect(screen.getByText(copy.plainTextNote)).toBeInTheDocument();
		const body = screen.getByText(/Not bold/);
		expect(body.textContent).toBe(markup);
		expect(body).toHaveClass("whitespace-pre-wrap");
		expect(
			container.querySelector(
				"[data-slot='collapsible-content'] :is(strong, em, b, h5, a, span[data-slot='report-citation'])",
			),
		).toBeNull();
		expect(remarkReportCitations).not.toHaveBeenCalled();
	});

	it("falls back to escaped plain text when the rendering throws, keeping the rest", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		parse.fail = true;
		await renderOpen(markup, cites(linkSource()));

		expect(await screen.findByText(copy.plainTextNote)).toBeInTheDocument();
		expect(screen.getByText(/Not bold/).textContent).toBe(markup);
		expect(screen.getByText("Sibling content")).toBeInTheDocument();
		expect(
			screen.getByText("Ready to send after two fixes"),
		).toBeInTheDocument();
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
	});

	it("shows a long plain-text report quickly", () => {
		const text = "*a".repeat(30_000);
		render(
			<Harness
				value={report({ text, plainText: true })}
				initiallyOpen={false}
			/>,
		);

		const started = performance.now();
		fireEvent.click(trigger());
		expect(screen.getByText(copy.plainTextNote)).toBeInTheDocument();
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(document.querySelector("em, strong")).toBeNull();
	});
});

describe("AnalysisReport — parsing", () => {
	it("parses only while open, and not again for an identical render", async () => {
		const value = report({
			text: "Cited [S2].",
			citations: cites(linkSource()),
		});
		const view = render(<Harness value={value} />);
		expect(remarkReportCitations).not.toHaveBeenCalled();

		await userEvent.click(trigger());
		expect(remarkReportCitations).toHaveBeenCalledTimes(1);

		view.rerender(<Harness value={value} />);
		// A poll brings the same report as new objects.
		view.rerender(
			<Harness value={{ ...value, citations: cites(linkSource()) }} />,
		);
		expect(remarkReportCitations).toHaveBeenCalledTimes(1);
		expect(
			screen.getByRole("link", { name: /^S2: Kickoff notes/ }),
		).toBeInTheDocument();

		view.rerender(
			<Harness value={{ ...value, text: "Cited again [S2]." }} />,
		);
		expect(remarkReportCitations).toHaveBeenCalledTimes(2);
	});

	it("keeps an open source popover open through an identical render", async () => {
		const value = report({
			text: "Rates [S2].",
			citations: cites(companySource()),
		});
		const view = render(<Harness value={value} />);
		await userEvent.click(trigger());
		await userEvent.click(
			screen.getByRole("button", { name: "S2: Rate card" }),
		);
		const popover = await screen.findByRole("dialog");
		await waitFor(() =>
			expect(popover.contains(document.activeElement)).toBe(true),
		);

		act(() => {
			view.rerender(
				<Harness
					value={{ ...value, citations: cites(companySource()) }}
				/>,
			);
		});
		expect(screen.getByRole("dialog")).toBe(popover);
		expect(popover.contains(document.activeElement)).toBe(true);
	});
});
