/**
 * Dark-mode design-token contract test for `<ChatMessageInsertDiagramButton />`
 * and `<ChatMessageDiagramErrorBanner />` (D8 / spec § 14.6).
 *
 * This is NOT a pixel-perfect screenshot diff -- the full visual
 * dark-mode E2E lives in Group G (`G12`). The cheap unit-level
 * regression guard locked here is the **design-token contract**: the
 * primary CTA carries `bg-primary` + `text-primary-foreground`, and
 * the destructive surface carries `border-destructive/40` +
 * `bg-destructive/5` + `text-destructive`. Both Tailwind tokens map to
 * CSS variables, so toggling `<html class="dark">` flips the colour
 * without any class swap -- the test only verifies the class strings
 * are present so the design-token bus stays connected.
 *
 * Spec § 14.6 calls this out explicitly: "Light and dark mode both rely
 * on CSS variables. The button uses `variant=default` (primary) which
 * maps to `--primary`."
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks mirror the D2 test setup -- we exercise the rendered DOM only.

vi.mock("next-intl", () => ({
	useTranslations: (ns?: string) => {
		const t = (key: string, values?: Record<string, string>) => {
			if (ns === "diagrams.autoInsert") {
				switch (key) {
					case "insertButton":
						return `Insert into ${values?.docName ?? ""}`;
					case "copyEmbedCodeButton":
						return "Copy embed code";
					case "bannerEditorFailure":
						return `Saved to ${values?.projectName} diagrams — couldn't add it to ${values?.docName}.`;
					case "bannerEditorFailureRetry":
						return "Retry";
					default:
						return key;
				}
			}
			if (ns === "tooltips.diagrams") {
				return key;
			}
			return key;
		};
		return t;
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("../useInsertDiagramAction", () => ({
	useInsertDiagramAction: () => ({
		enabled: true,
		status: "idle",
		click: vi.fn(),
		copyEmbedCode: vi.fn(),
		retry: vi.fn(),
	}),
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

const { ChatMessageInsertDiagramButton } = await import(
	"../ChatMessageInsertDiagramButton"
);
const { ChatMessageDiagramErrorBanner } = await import(
	"../ChatMessageDiagramErrorBanner"
);

import type { ChatMessageInsertDiagramButtonProps } from "../ChatMessageInsertDiagramButton";

function makeFakeEditor(): Editor {
	return { on: vi.fn(), off: vi.fn() } as unknown as Editor;
}

function buildProps(): ChatMessageInsertDiagramButtonProps {
	return {
		surface: "in-document",
		chatMessageId: "msg_dark",
		toolResult: {
			elements: [],
			checkpointId: "cp_x",
			mcpConfigId: "cfg_x",
			resourceUri: "ui://x",
		},
		organizationSlug: "example-org",
		chatScopeProjectName: "Atlas",
		chatScope: {
			projectId: "proj_x",
			organizationId: "org_x",
			lastUserPromptForMessage: () => null,
		},
		resolverOptions: {
			chatContext: {
				projectId: "proj_x",
				organizationId: "org_x",
				surface: "in-document",
			},
			launcherContext: null,
		},
		resolverTarget: {
			kind: "document",
			editor: makeFakeEditor(),
			projectId: "proj_x",
			documentLabel: "Doc X",
			documentId: "doc_x",
		},
		title: "Build",
		canEditTargetProject: true,
		canCreateDiagramsInChatScope: true,
	};
}

function renderInDarkMode(node: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// Toggle dark mode by adding the `.dark` class to a wrapping
	// element. Tailwind's `dark:` variants read from `html.dark` by
	// default, but the in-tree classes inherit from the nearest
	// `.dark` ancestor so wrapping the test is equivalent.
	return render(
		<div className="dark">
			<QueryClientProvider client={queryClient}>
				{node}
			</QueryClientProvider>
		</div>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ChatMessageInsertDiagramButton -- dark-mode token contract (D8)", () => {
	it("primary CTA carries bg-primary + text-primary-foreground", () => {
		renderInDarkMode(<ChatMessageInsertDiagramButton {...buildProps()} />);
		const button = screen.getByRole("button", {
			name: /Insert this diagram/i,
		});
		expect(button.className).toMatch(/bg-primary\b/);
		expect(button.className).toMatch(/text-primary-foreground/);
	});

	it("Copy embed code button uses ghost variant tokens (no hardcoded hex)", () => {
		renderInDarkMode(<ChatMessageInsertDiagramButton {...buildProps()} />);
		const copyButton = screen.getByRole("button", {
			name: /Copy <excalidraw-embed> markup/i,
		});
		// shadcn ghost variant: hover:bg-muted hover:text-foreground
		expect(copyButton.className).toMatch(/hover:bg-muted/);
	});

	it("no hardcoded hex anywhere in the rendered button row", () => {
		const { container } = renderInDarkMode(
			<ChatMessageInsertDiagramButton {...buildProps()} />,
		);
		const html = container.innerHTML;
		// Tailwind tokens render as class names like `bg-primary`,
		// `text-primary-foreground`; hardcoded hex would appear as
		// inline `style="..."` literals. Either form would be a bug.
		// Allowing data-* attributes that may contain digits.
		expect(html).not.toMatch(/style="[^"]*#[0-9a-fA-F]{3,6}/);
	});
});

describe("ChatMessageDiagramErrorBanner -- dark-mode token contract (D8)", () => {
	it("destructive surface carries border-destructive/40 + bg-destructive/5 + text-destructive", () => {
		renderInDarkMode(
			<ChatMessageDiagramErrorBanner
				docName="Spec"
				projectName="Atlas"
				onRetry={() => {}}
			/>,
		);
		const region = screen.getByRole("status");
		expect(region.className).toContain("border-destructive/40");
		expect(region.className).toContain("bg-destructive/5");
		expect(region.className).toContain("text-destructive");
	});
});
