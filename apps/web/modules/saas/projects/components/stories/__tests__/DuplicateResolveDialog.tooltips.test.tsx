/**
 * Tooltip legibility + the similarity/confidence explainer in
 * DuplicateResolveDialog.
 *
 * Regression guard for the metadata strip: its rich label/value rows use
 * `text-foreground` / `text-muted-foreground`, which are invisible on the
 * default "inverse" tooltip surface (bg-foreground) in BOTH themes — the
 * surface must be "popover" so those tokens stay legible. We assert the
 * rendered tooltip carries `data-surface="popover"` rather than colors
 * (jsdom has no computed theme), which locks the fix in place.
 *
 * Also covers the new hover explainer on the "{x}% similar · {y}% match
 * confidence" score, which describes the two-stage detection (embedding
 * similarity + LLM verifier confidence).
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so translated strings
 * surface as their keys (e.g. "metaLabelWords", "similarHelpLabel").
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				mergeDuplicate: vi.fn(),
				dismissDuplicate: vi.fn(),
				proposeDuplicateMerge: vi.fn(),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "" }),
}));

vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: vi.fn(async (file: File) => ({
		ok: true as const,
		file,
	})),
	// The upload hook calls this after compressImage. A mock without it
	// throws inside preparation; the default stub keeps the pre-existing
	// behaviour of these suites (every image is within budget).
	compressImageToBudget: vi.fn(async (file: File) => ({
		file,
		withinBudget: true,
	})),
	resolveStoryImageUrls: vi.fn(async () => ({})),
}));

vi.mock("@saas/shared/components/copilot/MessageAttachmentList", () => ({
	MessageAttachmentList: () => null,
}));

// Radix Tooltip internals use ResizeObserver + pointer capture; jsdom provides
// neither. Mirror the polyfills the other tooltip tests rely on.
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => {};
	}
});

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

import {
	type DuplicateLink,
	type DuplicateLinkStory,
	DuplicateResolveDialog,
} from "../DuplicateResolveDialog";

function makeStory(id: string, identifier: string): DuplicateLinkStory {
	return {
		id,
		identifier,
		title: `Title ${identifier}`,
		description: "A short description with five words.",
		acceptanceCriteria: "Given X, when Y, then Z.",
		kind: "FEATURE",
		draftingStage: "BACKLOG",
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		pmAutoSyncEnabled: false,
		lastPmSyncStatus: null,
		lastSyncedAt: null,
		createdAt: "2026-04-01T00:00:00.000Z",
		updatedAt: "2026-04-01T00:00:00.000Z",
		source: "FABRIC",
		createdById: "u1",
		reporterName: null,
		createdByName: "Alex",
	};
}

function makeLink(): DuplicateLink {
	return {
		id: "link-1",
		similarity: 1,
		confidence: 0.95,
		reasoning: null,
		storyA: makeStory("a", "F-A"),
		storyB: makeStory("b", "F-B"),
	};
}

function renderDialog() {
	render(
		<DuplicateResolveDialog
			open
			onOpenChange={vi.fn()}
			projectId="p1"
			organizationId={null}
			link={makeLink()}
			onResolved={vi.fn()}
		/>,
	);
}

/** The styled (visible) tooltip content carries data-slot + data-surface. */
function openTooltipContent(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

describe("DuplicateResolveDialog — metadata tooltip surface", () => {
	it("renders the per-column metadata tooltip on the legible popover surface", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderDialog();

		// Two strips (one per story); open the first.
		const triggers = screen.getAllByLabelText("metaDetailsAria");
		expect(triggers.length).toBeGreaterThanOrEqual(1);
		await user.hover(triggers[0]);
		act(() => {
			vi.advanceTimersByTime(600);
		});

		const content = await waitFor(() => {
			const el = openTooltipContent();
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		// The popover surface is what keeps text-foreground values visible in
		// both light and dark themes (the inverse surface hides them).
		expect(content).toHaveAttribute("data-surface", "popover");
		// The labelled rows are present (Words is always shown).
		expect(content.textContent).toContain("metaLabelWords");
	});
});

describe("DuplicateResolveDialog — similarity/confidence explainer", () => {
	it("exposes a hover explainer describing how the scores are calculated", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderDialog();

		const trigger = screen.getByLabelText("similarConfidenceAria");
		await user.hover(trigger);
		act(() => {
			vi.advanceTimersByTime(600);
		});

		const content = await waitFor(() => {
			const el = openTooltipContent();
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		// Legible surface + the two-stage explanation (similarity + confidence).
		expect(content).toHaveAttribute("data-surface", "popover");
		expect(content.textContent).toContain("similarHelpLabel");
		expect(content.textContent).toContain("similarHelpBody");
		expect(content.textContent).toContain("confidenceHelpLabel");
		expect(content.textContent).toContain("confidenceHelpBody");
	});
});
