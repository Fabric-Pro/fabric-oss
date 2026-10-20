/**
 * `ProposalLiveSections` — a Proposal's Main tab while its generation runs
 * (Fizzy #2801).
 *
 * Pinned here: finished sections render through the editor's own markdown
 * pipeline (headings as headings, mermaid as a diagram, raw HTML never as
 * markup); with the Proposal theme on (Fizzy #2946) the document, and only
 * the document, sits on the theme's paper, with the pane as the desk around
 * it; a "writing next section" line follows them; one polite region says how
 * many sections are ready and nothing moves focus; before the first section
 * the pane hosts the generation progress (the queued wait, a Retry once a run
 * stalls) above the previous body, dimmed, or a skeleton for a new document —
 * never a blank pane. Once this run has written a section the previous body
 * never returns: when the live preview stops and the fallback writes the Main
 * (Fizzy #2946), the sections stay with a "preview stopped" line, announced
 * once.
 *
 * The read-only editor is the real Tiptap one with the editor's extensions,
 * and `next-intl` resolves the real en.json, so a missing string fails.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			if (!translators.has(namespace)) {
				translators.set(
					namespace,
					createTranslator({
						locale: "en",
						messages,
						namespace: namespace as never,
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});

import messages from "@repo/i18n/translations/en.json";
import {
	PROPOSAL_FINISHING_PROGRESS,
	PROPOSAL_PREVIEW_STOPPED_PROGRESS,
} from "@repo/utils/proposal-artifact/live-progress";
import {
	buildProposalThemeTokens,
	NEUTRAL_THEME,
	resolveThemePaint,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	countLiveSections,
	ProposalLiveSections,
	type ProposalLiveSectionsProps,
} from "@saas/projects/components/proposal-artifact/ProposalLiveSections";
import type { ProposalThemeRootProps } from "@saas/projects/components/proposal-artifact/use-proposal-theme";
import type { CSSProperties } from "react";

const copy = messages.projects.proposalArtifactPage.live;

const TWO_SECTIONS = [
	"# Example proposal",
	"",
	"## Scope",
	"",
	"We deliver the onboarding flow.",
	"",
	"## Timeline",
	"",
	"Six weeks from kickoff.",
].join("\n");

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** What the page hands the pane while the theme is on: the neutral paint. */
const THEME_ROOT_PROPS: ProposalThemeRootProps = {
	className: "proposal-theme",
	"data-proposal-theme": "live",
	style: themeCustomProperties(
		resolveThemePaint(
			buildProposalThemeTokens({
				organization: null,
				style: null,
				brandKit: null,
				recipient: null,
			}),
		),
	) as CSSProperties,
};

const THEME_ROOT = '.proposal-theme[data-proposal-theme="live"]';

function themeRoot(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>(THEME_ROOT);
	if (!root) {
		throw new Error("no theme root");
	}
	return root;
}

function renderPane(overrides: Partial<ProposalLiveSectionsProps> = {}) {
	const props: ProposalLiveSectionsProps = {
		liveContent: null,
		savedContent: null,
		status: "GENERATING",
		progress: 40,
		title: "Example proposal",
		generationStartedAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
	const view = render(<ProposalLiveSections {...props} />);
	return {
		...view,
		rerenderPane: (next: Partial<ProposalLiveSectionsProps>) =>
			view.rerender(<ProposalLiveSections {...props} {...next} />),
	};
}

/** The single region the pane announces section counts through. */
function sectionsRegion(container: HTMLElement): HTMLElement {
	const region = container.querySelector<HTMLElement>(
		"output[aria-live='polite']",
	);
	if (!region) {
		throw new Error("no polite region");
	}
	return region;
}

describe("ProposalLiveSections — live sections", () => {
	it("renders the finished sections read-only, with the next one announced as being written", async () => {
		const { container } = renderPane({ liveContent: TWO_SECTIONS });

		expect(
			await screen.findByRole("heading", { level: 2, name: "Scope" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: "Timeline" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("We deliver the onboarding flow."),
		).toBeInTheDocument();
		expect(screen.getByText(copy.writingNext)).toBeInTheDocument();

		const editable = container.querySelector(".tiptap");
		expect(editable).toHaveAttribute("contenteditable", "false");
		// The progress card belongs to the wait before the first section.
		expect(
			screen.queryByRole("region", {
				name: "Document generation progress",
			}),
		).not.toBeInTheDocument();
	});

	it("says the run is finishing, not writing, once the agent's stream has ended", async () => {
		renderPane({ liveContent: TWO_SECTIONS, progress: 85 });

		expect(
			await screen.findByRole("heading", { level: 2, name: "Scope" }),
		).toBeInTheDocument();
		expect(screen.getByText(copy.finishing)).toBeInTheDocument();
		expect(screen.queryByText(copy.writingNext)).not.toBeInTheDocument();
	});

	it("puts the document on the theme's paper, with the pane as the desk and the run's line outside it", async () => {
		const { container } = renderPane({
			liveContent: TWO_SECTIONS,
			themeRootProps: THEME_ROOT_PROPS,
		});
		await screen.findByRole("heading", { level: 2, name: "Scope" });

		const pane = screen.getByTestId("proposal-live-sections");
		const root = themeRoot(container);
		expect(root.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);
		expect(root.style.getPropertyValue("--pa-ink")).toBe(NEUTRAL_THEME.ink);
		expect(root).toContainElement(container.querySelector(".tiptap"));
		expect(
			within(root).getByRole("heading", { level: 2, name: "Timeline" }),
		).toBeInTheDocument();
		// The desk keeps the app's surface; the paper is painted only from the
		// theme's own properties, never from a colour utility of its own.
		expect(pane).toHaveClass("bg-background");
		expect(pane).not.toHaveClass("proposal-theme");
		expect(root.className).not.toMatch(/(^|\s)(bg|text)-/);
		expect(root).not.toContainElement(screen.getByText(copy.writingNext));
		expect(root).not.toContainElement(sectionsRegion(container));
	});

	it("leaves the document unthemed while the theme is off", async () => {
		const { container } = renderPane({ liveContent: TWO_SECTIONS });
		await screen.findByRole("heading", { level: 2, name: "Scope" });

		expect(container.querySelector(".proposal-theme")).toBeNull();
		expect(container.querySelector("[data-proposal-theme]")).toBeNull();
	});

	it("draws a mermaid fence as a diagram, not as a code block", async () => {
		const { container } = renderPane({
			liveContent: [
				"## Delivery flow",
				"",
				"```mermaid",
				"flowchart LR",
				"  Kickoff --> Build",
				"```",
				"",
				"## Next",
			].join("\n"),
		});

		await waitFor(() =>
			expect(
				container.querySelector(".node-mermaidBlock"),
			).not.toBeNull(),
		);
		expect(container.querySelector("pre code.language-mermaid")).toBeNull();
	});

	it("renders raw HTML in model output through the editor schema, never as markup", async () => {
		const { container } = renderPane({
			liveContent: [
				"## Scope",
				"",
				'<script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">',
				"",
				"Plain text stays.",
			].join("\n"),
		});

		expect(
			await screen.findByText("Plain text stays."),
		).toBeInTheDocument();
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("[onerror]")).toBeNull();
		expect(
			(window as unknown as { __pwned?: boolean }).__pwned,
		).toBeUndefined();
	});

	it("updates the rendered sections in place as new ones are saved", async () => {
		const { container, rerenderPane } = renderPane({
			liveContent: TWO_SECTIONS,
		});
		await screen.findByRole("heading", { level: 2, name: "Timeline" });
		const editable = container.querySelector(".tiptap");

		rerenderPane({
			liveContent: `${TWO_SECTIONS}\n\n## Pricing\n\nA fixed fee.`,
		});

		expect(
			await screen.findByRole("heading", { level: 2, name: "Pricing" }),
		).toBeInTheDocument();
		// The same editor took the new content: the sections already on
		// screen were not torn down and rebuilt.
		expect(container.querySelector(".tiptap")).toBe(editable);
	});
});

describe("ProposalLiveSections — announcements", () => {
	it("says how many sections are ready through one polite region, updated in place", async () => {
		const { container, rerenderPane } = renderPane({
			liveContent: "## Scope\n\nText.",
		});
		const region = sectionsRegion(container);
		expect(region).toHaveTextContent("1 section ready");

		rerenderPane({ liveContent: TWO_SECTIONS });

		expect(sectionsRegion(container)).toBe(region);
		expect(region).toHaveTextContent("2 sections ready");
		expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
	});

	it("starts empty, so the first section is announced as a change", () => {
		const { container } = renderPane({ status: "QUEUED", progress: 0 });

		expect(sectionsRegion(container)).toBeEmptyDOMElement();
	});

	it("never moves focus while sections arrive", async () => {
		const user = userEvent.setup();
		const outside = document.createElement("button");
		outside.textContent = "Elsewhere";
		document.body.appendChild(outside);
		await user.click(outside);
		expect(outside).toHaveFocus();

		const { rerenderPane } = renderPane({ liveContent: "## Scope\n\nA." });
		await screen.findByRole("heading", { level: 2, name: "Scope" });
		rerenderPane({ liveContent: TWO_SECTIONS });
		await screen.findByRole("heading", { level: 2, name: "Timeline" });

		expect(outside).toHaveFocus();
		outside.remove();
	});
});

describe("ProposalLiveSections — before the first section", () => {
	it("shows the queued wait with a skeleton for a new document, never a blank pane", () => {
		renderPane({
			status: "QUEUED",
			progress: 0,
			liveContent: "",
			savedContent: "",
		});

		const progress = screen.getByRole("region", {
			name: "Document generation progress",
		});
		expect(
			within(progress).getByText("Waiting for project context"),
		).toBeInTheDocument();
		expect(screen.getByText(copy.newDocument)).toBeInTheDocument();
		expect(screen.queryByText(copy.writingNext)).not.toBeInTheDocument();
		// A queued run is waiting, not stalled: no retry is offered.
		expect(
			screen.queryByRole("button", { name: /retry/i }),
		).not.toBeInTheDocument();
	});

	it("shows generation progress above the previous body, dimmed and labelled", async () => {
		renderPane({
			status: "GENERATING",
			progress: 35,
			liveContent: null,
			savedContent: "## Old scope\n\nThe earlier version.",
		});

		expect(
			screen.getByRole("region", {
				name: "Document generation progress",
			}),
		).toBeInTheDocument();
		const previous = screen.getByRole("region", {
			name: copy.previousVersion,
		});
		expect(
			await within(previous).findByRole("heading", {
				level: 2,
				name: "Old scope",
			}),
		).toBeInTheDocument();
		expect(
			within(previous)
				.getByText("The earlier version.")
				.closest(".opacity-60"),
		).not.toBeNull();
		expect(screen.queryByText(copy.newDocument)).not.toBeInTheDocument();
	});

	it("puts the dimmed previous body on the paper, with the progress and its label on the desk", async () => {
		const { container } = renderPane({
			status: "GENERATING",
			progress: 35,
			liveContent: null,
			savedContent: "## Old scope\n\nThe earlier version.",
			themeRootProps: THEME_ROOT_PROPS,
		});
		await screen.findByRole("heading", { level: 2, name: "Old scope" });

		const root = themeRoot(container);
		expect(root).toContainElement(screen.getByText("The earlier version."));
		// The paper dims as a whole.
		expect(root.parentElement).toHaveClass("opacity-60");
		expect(root).not.toContainElement(
			screen.getByRole("region", {
				name: "Document generation progress",
			}),
		);
		expect(root).not.toContainElement(
			screen.getByText(copy.previousVersion),
		);
	});

	it("offers Retry once a run stalls, and hands the click to the page", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		const stalledAt = new Date(NOW.getTime() - 10 * 60 * 1000);
		renderPane({
			status: "GENERATING",
			progress: 35,
			generationStartedAt: stalledAt,
			updatedAt: stalledAt,
			onRetry,
		});

		await user.click(
			screen.getByRole("button", { name: /retry generation/i }),
		);

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("offers no Retry to a reader who cannot start a run", () => {
		const stalledAt = new Date(NOW.getTime() - 10 * 60 * 1000);
		renderPane({
			status: "GENERATING",
			progress: 35,
			generationStartedAt: stalledAt,
			updatedAt: stalledAt,
		});

		expect(
			screen.queryByRole("button", { name: /retry/i }),
		).not.toBeInTheDocument();
	});

	it("keeps a stalled run retryable after sections have arrived", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		const stalledAt = new Date(NOW.getTime() - 10 * 60 * 1000);
		renderPane({
			liveContent: TWO_SECTIONS,
			generationStartedAt: stalledAt,
			updatedAt: stalledAt,
			onRetry,
		});

		expect(screen.getByText(copy.stalled)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: copy.retry }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("has no detectable accessibility violations in either state", async () => {
		const waiting = renderPane({
			status: "QUEUED",
			progress: 0,
			savedContent: "## Old scope\n\nText.",
		});
		// The hosted progress card's bar has no accessible name of its own;
		// the line above it, in its own live region, says the step and the
		// percentage. That card is the editor overlay's, unchanged here.
		expect(
			await axe(waiting.container, {
				rules: { "aria-progressbar-name": { enabled: false } },
			}),
		).toHaveNoViolations();
		waiting.unmount();

		const live = renderPane({ liveContent: TWO_SECTIONS });
		await screen.findByRole("heading", { level: 2, name: "Scope" });
		expect(await axe(live.container)).toHaveNoViolations();
	});
});

describe("ProposalLiveSections — the live preview stopped", () => {
	const PREVIOUS_BODY = "## Old scope\n\nThe earlier version.";

	it("keeps this run's sections, never the previous body, and says the preview stopped instead of writing next", async () => {
		renderPane({
			liveContent: TWO_SECTIONS,
			savedContent: PREVIOUS_BODY,
			progress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
		});

		expect(
			await screen.findByRole("heading", { level: 2, name: "Scope" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: "Timeline" }),
		).toBeInTheDocument();
		expect(screen.getByText(copy.previewStopped)).toBeInTheDocument();
		expect(screen.queryByText(copy.writingNext)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: copy.previousVersion }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("The earlier version."),
		).not.toBeInTheDocument();
	});

	it("announces the stop once, through the one polite region", () => {
		const { container, rerenderPane } = renderPane({
			liveContent: TWO_SECTIONS,
			progress: 40,
		});
		const region = sectionsRegion(container);
		expect(region).toHaveTextContent("2 sections ready");
		expect(region).not.toHaveTextContent(copy.previewStopped);

		rerenderPane({ progress: PROPOSAL_PREVIEW_STOPPED_PROGRESS });
		expect(sectionsRegion(container)).toBe(region);
		expect(region.textContent).toBe(
			`2 sections ready. ${copy.previewStopped}`,
		);

		// A later poll, the same state: the region's text does not change,
		// so nothing is announced again.
		rerenderPane({
			progress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
			updatedAt: new Date(),
		});
		expect(region.textContent).toBe(
			`2 sections ready. ${copy.previewStopped}`,
		);
		expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
	});

	it("still shows the dimmed previous body before this run's first section", async () => {
		renderPane({
			liveContent: null,
			savedContent: PREVIOUS_BODY,
			progress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
		});

		const previous = screen.getByRole("region", {
			name: copy.previousVersion,
		});
		expect(
			await within(previous).findByRole("heading", {
				level: 2,
				name: "Old scope",
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.previewStopped)).not.toBeInTheDocument();
	});

	it("says the run is finishing once the workflow reports the end, as before", async () => {
		renderPane({
			liveContent: TWO_SECTIONS,
			progress: PROPOSAL_FINISHING_PROGRESS,
		});

		await screen.findByRole("heading", { level: 2, name: "Scope" });
		expect(screen.getByText(copy.finishing)).toBeInTheDocument();
		expect(screen.queryByText(copy.previewStopped)).not.toBeInTheDocument();
	});

	it("has no detectable accessibility violations with the preview stopped", async () => {
		const { container } = renderPane({
			liveContent: TWO_SECTIONS,
			progress: PROPOSAL_PREVIEW_STOPPED_PROGRESS,
		});
		await screen.findByRole("heading", { level: 2, name: "Scope" });

		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("countLiveSections", () => {
	it("counts the H2 and H3 headings that delimit sections", () => {
		expect(
			countLiveSections("# Title\n\n## One\n\n### One.a\n\n## Two"),
		).toBe(3);
	});

	it("ignores headings inside fenced code", () => {
		expect(
			countLiveSections("## One\n\n```md\n## Not a section\n```\n"),
		).toBe(1);
	});

	it("falls back to the shallowest level below a leading title", () => {
		expect(
			countLiveSections("# Title\n\n#### A\n\n#### B\n\n##### c"),
		).toBe(2);
	});

	it("is zero for a preview without a section heading", () => {
		expect(countLiveSections("Just an introduction.")).toBe(0);
		expect(countLiveSections("# Only a title")).toBe(0);
	});
});
