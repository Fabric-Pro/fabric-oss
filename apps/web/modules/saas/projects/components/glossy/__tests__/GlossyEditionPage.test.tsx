/**
 * `GlossyEditionPage` (Fizzy #2589, U14; R4, R5, R7, R9, R10, R16, R21,
 * R26–R29, R36; F1–F3; AE2, AE3, AE6–AE8): the page where editors build,
 * review, and download a document's Glossy edition, and every other project
 * member reads and downloads it.
 *
 * `@tanstack/react-query` is real; the oRPC client is a stateful fake, so a
 * review changes what the next `get` returns, as the server's would. Visual
 * rendering (mermaid, canvas) and the PDF/DOCX writers are stubbed — their
 * own tests cover them — so these tests pin the page's wiring: what it asks
 * the server, what it renders from the answer, and what it hands the
 * renderers. `next-intl` echoes keys with their values.
 */

import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import type { GlossyEdition } from "../../../hooks/use-glossy-edition";

expect.extend(axeMatchers);

const api = vi.hoisted(() => ({
	get: vi.fn(),
	detect: vi.fn(),
	build: vi.fn(),
	regenerateVisual: vi.fn(),
	reviewVisual: vi.fn(),
	recipientFetch: vi.fn(),
	recipientUpload: vi.fn(),
	recipientUpdate: vi.fn(),
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
	renderPdf: vi.fn(),
	renderDocx: vi.fn(),
	triggerDownload: vi.fn(),
	failingTitles: new Set<string>(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			glossy: {
				get: (input: unknown) => api.get(input),
				detect: (input: unknown) => api.detect(input),
				build: (input: unknown) => api.build(input),
				regenerateVisual: (input: unknown) =>
					api.regenerateVisual(input),
				reviewVisual: (input: unknown) => api.reviewVisual(input),
			},
			recipientBrand: {
				fetch: (input: unknown) => api.recipientFetch(input),
				createLogoUploadUrl: (input: unknown) =>
					api.recipientUpload(input),
				update: (input: unknown) => api.recipientUpdate(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: api.toast }));

vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values && Object.keys(values).length > 0
			? `${key}(${Object.entries(values)
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(", ")})`
			: key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString().slice(0, 10),
			number: (value: number) => String(value),
			relativeTime: (date: Date) => `at ${date.toISOString()}`,
		}),
	};
});

vi.mock("next/link", () => ({
	default: ({
		href,
		children,
		...rest
	}: {
		href: string;
		children: ReactNode;
	}) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: ({ items }: { items: Array<{ label: string }> }) => (
		<nav aria-label="Breadcrumb">
			<ol>
				{items.map((item) => (
					<li key={item.label}>{item.label}</li>
				))}
			</ol>
		</nav>
	),
}));

// mermaid and canvas are the renderer's own business (its tests run them).
vi.mock("../../../lib/glossy/visual-render", () => ({
	renderGlossyVisual: vi.fn(async (spec: { title?: string }) =>
		spec.title && api.failingTitles.has(spec.title)
			? null
			: {
					dataUrl: "data:image/png;base64,AAAA",
					width: 320,
					height: 120,
				},
	),
	renderGlossyVisuals: vi.fn(async () => ({
		images: new Map(),
		failures: [],
	})),
}));

vi.mock(
	"../../../lib/glossy/glossy-document-render",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../lib/glossy/glossy-document-render")
		>()),
		renderGlossyPdf: (input: unknown) => api.renderPdf(input),
		renderGlossyDocx: (input: unknown) => api.renderDocx(input),
	}),
);

vi.mock("../../../lib/markdown-to-document", () => ({
	toSlug: (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, ""),
	triggerBlobDownload: (blob: Blob, filename: string) =>
		api.triggerDownload(blob, filename),
}));

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { GlossyEditionPage } from "../GlossyEditionPage";
import { GLOSSY_CODED_COPY } from "../glossy-copy";
import {
	COMPARISON_KEY,
	DIAGRAM_KEY,
	DOCUMENT_ID,
	editionContent,
	glossyEdition,
	PROJECT_ID,
	TIMELINE_KEY,
} from "./glossy-fixtures";

/** The server's view of the edition; review calls change it, as they would. */
let serverState: GlossyEdition;

function flags() {
	return Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [
			key,
			key === "GLOSSY_EDITION",
		]),
	) as Record<FeatureFlagKey, boolean>;
}

function renderPage(state: GlossyEdition = glossyEdition()) {
	serverState = state;
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<FeatureFlagProvider value={flags()}>
			<QueryClientProvider client={client}>
				<GlossyEditionPage
					projectId={PROJECT_ID}
					documentId={DOCUMENT_ID}
					organizationSlug="example-org"
					projectName="Example project"
				/>
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
}

/** The card of one visual, by its key. */
async function card(visualKey: string): Promise<HTMLElement> {
	return waitFor(() => {
		const element = document.querySelector<HTMLElement>(
			`[data-visual-key="${visualKey}"]`,
		);
		if (!element) {
			throw new Error(`No card for ${visualKey}`);
		}
		return element;
	});
}

/** Wait until the card's image rendered (the renderer is asynchronous). */
async function renderedCard(visualKey: string): Promise<HTMLElement> {
	const element = await card(visualKey);
	await waitFor(() => expect(within(element).getByRole("img")).toBeVisible());
	return element;
}

const PDF_BLOB = new Blob(["%PDF"], { type: "application/pdf" });

const IMAGE_A = "document-media/project-1/document-1/a.png";
const IMAGE_B = "document-media/project-1/document-1/b.png";

/** A build in progress, `sectionsDone` doubling as a marker of which poll answered. */
function buildingBuild(sectionsDone = 1): GlossyEdition["build"] {
	return {
		status: "building",
		step: "rewriting",
		sectionsDone,
		sectionsTotal: 20,
		startedAt: new Date(),
		startedBy: { id: "user-2", name: "Dana Example" },
	};
}

function failedBuild(stuck = false): GlossyEdition["build"] {
	return {
		status: "failed",
		errorCode: "BUILD_FAILED",
		errorMessage: null,
		stuck,
		startedAt: new Date("2026-09-21T08:00:00.000Z"),
		finishedAt: stuck ? null : new Date("2026-09-21T08:01:00.000Z"),
		startedBy: null,
	};
}

const ALIGN_FIRST_LAST_OPTIONS = {
	mode: "align_first",
	lengthMode: "brief",
	styleDirection: null,
	preparerOverrides: null,
} as const;

const DETECTED = {
	outcome: "detected",
	contentHash: "0123456789abcdef",
	opportunities: [
		{
			sectionKey: "section-summary",
			heading: "Executive summary",
			kind: "timeline",
			reason: "Phases with dates.",
		},
	],
	fromCache: false,
	degraded: false,
	recipientWebsiteSuggestions: [],
} as const;

const STUCK_HOLDER = {
	outcome: "building",
	holder: {
		startedBy: { id: "user-2", name: "Dana Example" },
		startedAt: new Date("2026-09-21T08:00:00.000Z"),
	},
	stuck: true,
} as const;

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

/** `a` comes before `b` in document order. */
function precedes(a: Node, b: Node): boolean {
	return Boolean(
		a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.failingTitles.clear();
	api.get.mockImplementation(async () => serverState);
	api.reviewVisual.mockImplementation(
		async (input: { visualKey: string; decision: string }) => {
			const decision =
				input.decision === "accept"
					? ("ACCEPTED" as const)
					: input.decision === "discard"
						? ("DISCARDED" as const)
						: null;
			const edition = serverState.edition;
			if (edition) {
				const decisions = edition.decisions.filter(
					(entry) => entry.visualKey !== input.visualKey,
				);
				if (decision) {
					decisions.push({
						visualKey: input.visualKey,
						decision,
						decidedAt: new Date("2026-09-21T09:00:00.000Z"),
					});
				}
				serverState = {
					...serverState,
					edition: { ...edition, decisions },
				};
			}
			return {
				outcome: "reviewed",
				visualKey: input.visualKey,
				decision,
			};
		},
	);
	api.renderPdf.mockResolvedValue({
		blob: PDF_BLOB,
		omittedVisuals: 0,
		omittedImages: 0,
	});
	api.renderDocx.mockResolvedValue({
		blob: new Blob(["docx"]),
		omittedVisuals: 0,
		omittedImages: 0,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GlossyEditionPage — access", () => {
	it("shows a viewer the preview and downloads, with no build or review controls (AE7)", async () => {
		renderPage(glossyEdition({ canEdit: false }));

		expect(
			await screen.findByRole("heading", {
				level: 2,
				name: "Example business case",
			}),
		).toBeInTheDocument();
		await renderedCard(TIMELINE_KEY);

		expect(
			screen.getByRole("button", { name: "downloadPdf" }),
		).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "downloadDocx" }),
		).toBeEnabled();
		for (const name of [
			"toolbar.build",
			"toolbar.rebuild",
			"toolbar.alignFirst",
			"toolbar.retry",
			"accept",
			"regenerate",
			"discard",
			"restore",
		]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
		expect(screen.getByText("viewerNote")).toBeInTheDocument();
		// The build report is for editors.
		expect(
			screen.queryByText(/report\.keptOriginal/),
		).not.toBeInTheDocument();
	});

	it("never shows a viewer a discarded visual", async () => {
		renderPage(
			glossyEdition({
				canEdit: false,
				edition: {
					decisions: [
						{
							visualKey: TIMELINE_KEY,
							decision: "DISCARDED",
							decidedAt: new Date("2026-09-21T09:00:00.000Z"),
						},
					],
				},
			}),
		);

		await renderedCard(COMPARISON_KEY);
		expect(
			document.querySelector(`[data-visual-key="${TIMELINE_KEY}"]`),
		).toBeNull();
	});

	it("says the edition is unavailable when the server refuses it", async () => {
		api.get.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);
		serverState = glossyEdition();
		renderPage();

		expect(await screen.findByText("page.unavailable")).toBeInTheDocument();
		expect(api.get).toHaveBeenCalledTimes(1);
	});

	it("retries a transient failure, then offers Try again, which recovers the page", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({
			advanceTimers: vi.advanceTimersByTime,
		});
		api.get.mockRejectedValue(
			Object.assign(new Error("Server error"), {
				code: "INTERNAL_SERVER_ERROR",
			}),
		);
		renderPage();

		// Past React Query's retry delays (1 s, then 2 s).
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await screen.findByText("page.loadFailed")).toBeInTheDocument();
		expect(api.get).toHaveBeenCalledTimes(3);
		expect(screen.queryByText("page.unavailable")).not.toBeInTheDocument();

		api.get.mockImplementation(async () => serverState);
		await user.click(
			screen.getByRole("button", { name: "page.retryLoad" }),
		);

		expect(
			await screen.findByRole("heading", {
				level: 2,
				name: "Example business case",
			}),
		).toBeInTheDocument();
		expect(screen.queryByText("page.loadFailed")).not.toBeInTheDocument();
	});

	it("stops polling and shows the unavailable notice when the server refuses a running build's edition", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderPage(glossyEdition({ build: buildingBuild() }));
		expect(
			await screen.findByText(
				"status.building(step=status.steps.rewriting)",
			),
		).toBeInTheDocument();

		// The gate was switched off, or access revoked, mid-build.
		api.get.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);
		await vi.advanceTimersByTimeAsync(3_000);

		expect(await screen.findByText("page.unavailable")).toBeInTheDocument();
		expect(
			screen.queryByText("status.building(step=status.steps.rewriting)"),
		).not.toBeInTheDocument();
		const calls = api.get.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.get).toHaveBeenCalledTimes(calls);
	});
});

describe("GlossyEditionPage — building", () => {
	it("shows an editor with no edition an empty state and Build, and starts nothing on mount", async () => {
		renderPage(glossyEdition({ edition: null }));

		expect(await screen.findByText("empty.title")).toBeInTheDocument();
		expect(screen.getByText("empty.editorBody")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "toolbar.build" }),
		).toBeEnabled();
		// Downloads wait for an edition.
		expect(
			screen.getByRole("button", { name: "downloadPdf" }),
		).toBeDisabled();

		expect(api.get).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(api.build).not.toHaveBeenCalled();
		expect(api.detect).not.toHaveBeenCalled();
	});

	it("starts a Roll the dice build in Brief by default (F1, R23)", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("button", { name: "toolbar.build" }),
		);

		expect(api.build).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			options: { mode: "roll_the_dice", lengthMode: "brief" },
		});
		await waitFor(() =>
			expect(api.toast.success).toHaveBeenCalledWith("outcome.started"),
		);
		expect(api.detect).not.toHaveBeenCalled();
	});

	it("builds in Standard when the editor picks it", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("radio", { name: "lengths.standard" }),
		);
		await user.click(screen.getByRole("button", { name: "toolbar.build" }));

		expect(api.build).toHaveBeenCalledWith(
			expect.objectContaining({
				options: { mode: "roll_the_dice", lengthMode: "standard" },
			}),
		);
	});

	it("disables Build and Regenerate while a build runs, and names who started it", async () => {
		renderPage(
			glossyEdition({
				build: {
					status: "building",
					step: "rewriting",
					sectionsDone: 3,
					sectionsTotal: 8,
					startedAt: new Date(),
					startedBy: { id: "user-2", name: "Dana Example" },
				},
			}),
		);

		const building = await screen.findByRole("button", {
			name: "toolbar.building",
		});
		expect(building).toBeDisabled();
		expect(
			screen.getByText(/status\.startedBy\(name=Dana Example/),
		).toBeInTheDocument();
		expect(
			screen.getByText("status.progress(done=3, total=8)"),
		).toBeInTheDocument();
		expect(
			screen.getByText("status.building(step=status.steps.rewriting)"),
		).toBeInTheDocument();

		const timeline = await renderedCard(TIMELINE_KEY);
		expect(
			within(timeline).getByRole("button", { name: "regenerate" }),
		).toBeDisabled();
		// Review writes no content, so the server takes it during a build.
		expect(
			within(timeline).getByRole("button", { name: "discard" }),
		).toBeEnabled();
	});

	it("shows a configure-provider link when the build finds no AI provider (AE6)", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "aiProviderNotConfigured",
			message: "No AI provider is configured.",
		});
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("button", { name: "toolbar.build" }),
		);

		const link = await screen.findByRole("link", { name: "provider.link" });
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/settings/ai-providers",
		);
		expect(screen.getByText("provider.title")).toBeInTheDocument();
	});

	it("shows a failed first build's reason and Retry instead of the empty state", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage(
			glossyEdition({
				edition: { content: null, outOfDate: false },
				build: {
					status: "failed",
					errorCode: "NOTHING_TO_PRESENT",
					errorMessage: "fixed text",
					stuck: false,
					startedAt: new Date("2026-09-21T08:00:00.000Z"),
					finishedAt: new Date("2026-09-21T08:01:00.000Z"),
					startedBy: null,
				},
			}),
		);

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(
			within(status).getByText("status.firstBuildFailed"),
		).toBeInTheDocument();
		expect(
			within(status).getByText("status.errors.NOTHING_TO_PRESENT"),
		).toBeInTheDocument();
		expect(screen.queryByText("empty.title")).not.toBeInTheDocument();

		await user.click(
			within(status).getByRole("button", { name: "toolbar.retry" }),
		);
		expect(api.build).toHaveBeenCalledTimes(1);
	});

	it("gives WORKFLOW_START_FAILED and unknown codes translated copy", async () => {
		renderPage(
			glossyEdition({
				edition: { content: null },
				build: {
					status: "failed",
					errorCode: "WORKFLOW_START_FAILED",
					errorMessage: null,
					stuck: false,
					startedAt: new Date(),
					finishedAt: null,
					startedBy: null,
				},
			}),
		);
		expect(
			await screen.findByText("status.errors.WORKFLOW_START_FAILED"),
		).toBeInTheDocument();
	});

	it("offers Rebuild, not a wait, when the last build stopped responding", async () => {
		renderPage(
			glossyEdition({
				build: {
					status: "failed",
					errorCode: "BUILD_FAILED",
					errorMessage: null,
					stuck: true,
					startedAt: new Date("2026-09-21T08:00:00.000Z"),
					finishedAt: null,
					startedBy: { id: "user-2", name: "Dana Example" },
				},
				edition: { lastRebuildFailed: true },
			}),
		);

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(within(status).getByText("status.stuck")).toBeInTheDocument();
		expect(
			within(status).getByRole("button", { name: "toolbar.rebuild" }),
		).toBeEnabled();
	});

	it("shows the out-of-date notice with Rebuild for editors (R7, F3)", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage(glossyEdition({ edition: { outOfDate: true } }));

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(
			within(status).getByText("status.outOfDate"),
		).toBeInTheDocument();
		expect(
			within(status).getByText("status.outOfDateEditor"),
		).toBeInTheDocument();
		await user.click(
			within(status).getByRole("button", { name: "toolbar.rebuild" }),
		);
		expect(api.build).toHaveBeenCalledWith(
			expect.objectContaining({
				options: { mode: "roll_the_dice", lengthMode: "brief" },
			}),
		);
	});

	it("tells a viewer of an out-of-date edition to ask an editor", async () => {
		renderPage(
			glossyEdition({ canEdit: false, edition: { outOfDate: true } }),
		);

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(
			within(status).getByText("status.outOfDateViewer"),
		).toBeInTheDocument();
		expect(within(status).queryByRole("button")).not.toBeInTheDocument();
	});

	it("reports alreadyBuilding with the holder and refreshes", async () => {
		const user = userEvent.setup();
		api.build.mockResolvedValue({
			outcome: "alreadyBuilding",
			holder: {
				startedBy: { id: "user-2", name: "Dana Example" },
				startedAt: new Date(),
			},
		});
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("button", { name: "toolbar.build" }),
		);

		await waitFor(() =>
			expect(api.toast.info).toHaveBeenCalledWith(
				"outcome.alreadyBuildingBy(name=Dana Example)",
			),
		);
		await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
	});

	it("polls while a build runs and stops once the build ends", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderPage(glossyEdition({ build: buildingBuild() }));
		expect(
			await screen.findByText(
				"status.building(step=status.steps.rewriting)",
			),
		).toBeInTheDocument();
		expect(api.get).toHaveBeenCalledTimes(1);

		// The build finishes between two polls.
		serverState = { ...serverState, build: { status: "idle" } };
		await vi.advanceTimersByTimeAsync(3_000);
		await waitFor(() =>
			expect(
				screen.queryByText(
					"status.building(step=status.steps.rewriting)",
				),
			).not.toBeInTheDocument(),
		);
		expect(api.get).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.get).toHaveBeenCalledTimes(2);
	});
});

describe("GlossyEditionPage — one start guard", () => {
	it("holds a visual notice's Rebuild while Align first detection runs", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue(STUCK_HOLDER);
		api.detect.mockReturnValue(new Promise(() => undefined));
		renderPage(
			glossyEdition({
				edition: { lastOptions: ALIGN_FIRST_LAST_OPTIONS },
			}),
		);

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);
		await within(timeline).findByRole("button", {
			name: "toolbar.rebuild",
		});
		await user.click(
			screen.getByRole("button", { name: "toolbar.alignFirst" }),
		);
		await screen.findByRole("region", { name: "title" });
		expect(api.detect).toHaveBeenCalledTimes(1);

		const rebuild = within(timeline).getByRole("button", {
			name: "toolbar.rebuild",
		});
		await user.click(rebuild);

		expect(rebuild).toBeDisabled();
		expect(api.detect).toHaveBeenCalledTimes(1);
		expect(api.build).not.toHaveBeenCalled();
	});

	it("holds the status strip's Retry while the Align-first form is open", async () => {
		const user = userEvent.setup();
		api.detect.mockResolvedValue(DETECTED);
		renderPage(
			glossyEdition({
				edition: {
					content: null,
					lastOptions: ALIGN_FIRST_LAST_OPTIONS,
				},
				build: failedBuild(),
			}),
		);

		await user.click(
			await screen.findByRole("button", { name: "toolbar.alignFirst" }),
		);
		const panel = await screen.findByRole("region", { name: "title" });
		const opportunity = await within(panel).findByRole("checkbox", {
			name: /visual\.kinds\.timeline/,
		});

		const status = screen.getByRole("region", { name: "status.region" });
		const retry = within(status).getByRole("button", {
			name: "toolbar.retry",
		});
		await user.click(retry);

		expect(retry).toBeDisabled();
		expect(api.detect).toHaveBeenCalledTimes(1);
		expect(api.build).not.toHaveBeenCalled();
		// The form the editor is filling in stays.
		expect(opportunity).toBeInTheDocument();
	});

	it("holds every build entry point for an ineligible document", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue(STUCK_HOLDER);
		renderPage(
			glossyEdition({
				eligibility: { eligible: false, reason: "generating" },
				edition: { lastRebuildFailed: true, outOfDate: true },
				build: failedBuild(),
			}),
		);

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(
			within(status).getByText("ineligible.generating"),
		).toBeInTheDocument();
		const retry = within(status).getByRole("button", {
			name: "toolbar.retry",
		});
		expect(retry).toBeDisabled();
		// The out-of-date notice's Rebuild.
		expect(
			within(status).getByRole("button", { name: "toolbar.rebuild" }),
		).toBeDisabled();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);
		const rebuild = await within(timeline).findByRole("button", {
			name: "toolbar.rebuild",
		});
		expect(rebuild).toBeDisabled();

		await user.click(retry);
		await user.click(rebuild);
		expect(api.build).not.toHaveBeenCalled();
		expect(api.detect).not.toHaveBeenCalled();
	});
});

describe("GlossyEditionPage — Align first cancelled mid-detection", () => {
	async function openAndCancel() {
		const user = userEvent.setup();
		const detection = deferred<unknown>();
		api.detect.mockReturnValue(detection.promise);
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("radio", { name: "modes.align_first" }),
		);
		await user.click(
			screen.getByRole("button", { name: "toolbar.alignFirst" }),
		);
		const panel = await screen.findByRole("region", { name: "title" });
		expect(within(panel).getByText("detecting")).toBeInTheDocument();

		await user.click(within(panel).getByRole("button", { name: "cancel" }));
		expect(
			screen.queryByRole("region", { name: "title" }),
		).not.toBeInTheDocument();
		return { detection, focused: document.activeElement };
	}

	async function expectStillClosed(focused: Element | null) {
		// The detection has settled once the toolbar stops waiting on it.
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "toolbar.alignFirst" }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByRole("region", { name: "title" }),
		).not.toBeInTheDocument();
		expect(document.activeElement).toBe(focused);
		expect(api.toast.error).not.toHaveBeenCalled();
		expect(api.build).not.toHaveBeenCalled();
	}

	it("stays closed when the cancelled detection answers", async () => {
		const { detection, focused } = await openAndCancel();
		detection.resolve(DETECTED);
		await expectStillClosed(focused);
	});

	it("stays closed, with no toast, when the cancelled detection fails", async () => {
		const { detection, focused } = await openAndCancel();
		detection.reject(
			Object.assign(new Error("Too many requests"), {
				code: "TOO_MANY_REQUESTS",
			}),
		);
		await expectStillClosed(focused);
	});

	it("raises no ineligible notice when the cancelled detection answers notEligible", async () => {
		const { detection, focused } = await openAndCancel();
		detection.resolve({ outcome: "notEligible", reason: "generating" });
		await expectStillClosed(focused);
	});
});

describe("GlossyEditionPage — report", () => {
	it("names a section kept in original wording by its heading (AE2)", async () => {
		renderPage();

		const status = await screen.findByRole("region", {
			name: "status.region",
		});
		expect(
			within(status).getByText("report.keptOriginal(count=1)"),
		).toBeInTheDocument();
		expect(
			within(status).getByText(
				"report.entry(subject=Budget and options, reason=report.keptOriginalReasons.fact_guard)",
			),
		).toBeInTheDocument();
	});

	it("says no visuals were suggested when the build found none (AE8)", async () => {
		renderPage(
			glossyEdition({
				edition: {
					content: editionContent({
						sections: editionContent().sections.map((section) => ({
							...section,
							anchors: [],
						})),
						visuals: {},
						report: {
							keptOriginal: [],
							droppedVisuals: [],
							unfilledSlots: [],
							scaffoldingUnrecognized: false,
						},
					}),
				},
			}),
		);

		expect(
			await screen.findByText("report.noSuggestions"),
		).toBeInTheDocument();
		expect(document.querySelector("[data-visual-key]")).toBeNull();
	});

	it("lists dropped visuals and unfilled slots with their reasons", async () => {
		renderPage(
			glossyEdition({
				edition: {
					content: editionContent({
						report: {
							keptOriginal: [],
							droppedVisuals: [
								{
									kind: "timeline",
									heading: "Delivery",
									reason: "fact_check",
								},
							],
							unfilledSlots: [
								{ slotId: "slot-1", reason: "appendix_slot" },
							],
							scaffoldingUnrecognized: true,
						},
					}),
				},
			}),
		);

		expect(
			await screen.findByText(
				"report.droppedEntry(kind=visual.kinds.timeline, section=Delivery, reason=report.dropReasons.fact_check)",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"report.slotEntry(reason=report.dropReasons.appendix_slot)",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("report.scaffoldingUnrecognized"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("report.noSuggestions"),
		).not.toBeInTheDocument();
	});
});

describe("GlossyEditionPage — review", () => {
	it("shows a render failure as a could-not-render card with Regenerate and Discard", async () => {
		api.failingTitles.add("Options compared");
		renderPage();

		const comparison = await card(COMPARISON_KEY);
		await waitFor(() =>
			expect(
				within(comparison).getByText("couldNotRender"),
			).toBeVisible(),
		);
		expect(within(comparison).queryByRole("img")).not.toBeInTheDocument();
		expect(
			within(comparison).getByRole("button", { name: "regenerate" }),
		).toBeEnabled();
		expect(
			within(comparison).getByRole("button", { name: "discard" }),
		).toBeEnabled();
		// The others render normally.
		await renderedCard(TIMELINE_KEY);
	});

	it("offers no Regenerate on the document's own diagram", async () => {
		renderPage();

		const diagram = await renderedCard(DIAGRAM_KEY);
		expect(
			within(diagram).queryByRole("button", { name: "regenerate" }),
		).not.toBeInTheDocument();
		expect(
			within(diagram).getByRole("button", { name: "discard" }),
		).toBeEnabled();
	});

	it("toggles the badge and download inclusion with Discard and Restore (R28, R29)", async () => {
		const user = userEvent.setup();
		renderPage();

		let timeline = await renderedCard(TIMELINE_KEY);
		expect(
			within(timeline).getByText("status.pending"),
		).toBeInTheDocument();

		await user.click(
			within(timeline).getByRole("button", { name: "discard" }),
		);
		expect(api.reviewVisual).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			visualKey: TIMELINE_KEY,
			decision: "discard",
		});
		timeline = await card(TIMELINE_KEY);
		await waitFor(() =>
			expect(
				within(timeline).getByText("status.discarded"),
			).toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: "downloadPdf" }));
		await waitFor(() => expect(api.renderPdf).toHaveBeenCalledTimes(1));
		expect([...api.renderPdf.mock.calls[0][0].excludedVisualKeys]).toEqual([
			TIMELINE_KEY,
		]);

		await user.click(
			within(timeline).getByRole("button", { name: "restore" }),
		);
		expect(api.reviewVisual).toHaveBeenLastCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			visualKey: TIMELINE_KEY,
			decision: "restore",
		});
		timeline = await renderedCard(TIMELINE_KEY);
		expect(
			within(timeline).getByText("status.pending"),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "downloadPdf" }));
		await waitFor(() => expect(api.renderPdf).toHaveBeenCalledTimes(2));
		expect([...api.renderPdf.mock.calls[1][0].excludedVisualKeys]).toEqual(
			[],
		);
	});

	it("accepts with the spec hash the editor saw", async () => {
		const user = userEvent.setup();
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "accept" }),
		);

		expect(api.reviewVisual).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			visualKey: TIMELINE_KEY,
			decision: "accept",
			specHash: "hash-timeline",
		});
		await waitFor(() =>
			expect(within(timeline).getByText("status.accepted")).toBeVisible(),
		);
	});

	it("holds only the regenerating card's controls while others stay usable", async () => {
		const user = userEvent.setup();
		let finish: (value: unknown) => void = () => undefined;
		api.regenerateVisual.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		const comparison = await renderedCard(COMPARISON_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);

		expect(api.regenerateVisual).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			visualKey: TIMELINE_KEY,
		});
		for (const name of ["accept", "regenerate", "discard"]) {
			expect(
				within(timeline).getByRole("button", { name }),
			).toBeDisabled();
			expect(
				within(comparison).getByRole("button", { name }),
			).toBeEnabled();
		}
		expect(within(timeline).getByText("regenerating")).toBeVisible();

		finish({
			outcome: "regenerated",
			visualKey: TIMELINE_KEY,
			kind: "timeline",
			specHash: "hash-timeline-2",
			contentRevision: 2,
		});
		await waitFor(() =>
			expect(
				within(timeline).getByRole("button", { name: "regenerate" }),
			).toBeEnabled(),
		);
		expect(api.toast.success).toHaveBeenCalledWith("visual.regenerated");
	});

	it("keeps the old visual and says why when regenerate finds no valid replacement", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({
			outcome: "noValidReplacement",
			reason: "fact_check",
		});
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);

		expect(
			await within(timeline).findByText(
				"visual.notices.noValidReplacement(reason=report.dropReasons.fact_check)",
			),
		).toBeInTheDocument();
		expect(within(timeline).getByRole("img")).toBeVisible();
	});

	it("offers Rebuild when regenerate meets a stuck build", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({
			outcome: "building",
			holder: {
				startedBy: { id: "user-2", name: "Dana Example" },
				startedAt: new Date(),
			},
			stuck: true,
		});
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);
		await user.click(
			await within(timeline).findByRole("button", {
				name: "toolbar.rebuild",
			}),
		);
		expect(api.build).toHaveBeenCalledTimes(1);
		// The notice described the stuck build; the new one replaces it.
		await waitFor(() =>
			expect(
				within(timeline).queryByText("visual.notices.buildingStuck"),
			).not.toBeInTheDocument(),
		);
	});

	it("hides Regenerate once the server says a visual is not regenerable", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({ outcome: "notRegenerable" });
		renderPage();

		const comparison = await renderedCard(COMPARISON_KEY);
		await user.click(
			within(comparison).getByRole("button", { name: "regenerate" }),
		);

		await waitFor(() =>
			expect(
				within(comparison).queryByRole("button", {
					name: "regenerate",
				}),
			).not.toBeInTheDocument(),
		);
	});

	it("refetches the edition when regenerate is superseded by a rebuild", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({ outcome: "superseded" });
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		const callsBefore = api.get.mock.calls.length;
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);

		await waitFor(() =>
			expect(api.get.mock.calls.length).toBeGreaterThan(callsBefore),
		);
		expect(api.toast.info).toHaveBeenCalledWith("visual.superseded");
	});

	it("shows the configure-provider link when regenerate finds no AI provider", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({
			outcome: "aiProviderNotConfigured",
			message: "No AI provider is configured.",
		});
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);
		expect(
			await screen.findByRole("link", { name: "provider.link" }),
		).toBeInTheDocument();
	});

	it("holds a regenerated card's controls until the refreshed edition arrives", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockResolvedValue({
			outcome: "regenerated",
			visualKey: TIMELINE_KEY,
			kind: "timeline",
			specHash: "hash-timeline-2",
			contentRevision: 2,
		});
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		const refetch = deferred<GlossyEdition>();
		api.get.mockImplementation(() => refetch.promise);
		const callsBefore = api.get.mock.calls.length;
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);

		await waitFor(() =>
			expect(api.toast.success).toHaveBeenCalledWith(
				"visual.regenerated",
			),
		);
		await waitFor(() =>
			expect(api.get.mock.calls.length).toBeGreaterThan(callsBefore),
		);
		// The refetch is still in flight: the card still shows the old image,
		// so Discard would act on a replacement nobody has seen.
		expect(
			within(timeline).getByRole("button", { name: "discard" }),
		).toBeDisabled();
		expect(within(timeline).getByText("regenerating")).toBeVisible();

		refetch.resolve(serverState);
		await waitFor(() =>
			expect(
				within(timeline).getByRole("button", { name: "discard" }),
			).toBeEnabled(),
		);
	});

	it("drops a build's notice once the page sees the build state move, and keeps the others", async () => {
		const user = userEvent.setup();
		api.regenerateVisual.mockImplementation(
			async (input: { visualKey: string }) =>
				input.visualKey === TIMELINE_KEY
					? {
							outcome: "building",
							holder: {
								startedBy: {
									id: "user-2",
									name: "Dana Example",
								},
								startedAt: new Date(),
							},
							stuck: false,
						}
					: { outcome: "noValidReplacement", reason: "fact_check" },
		);
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		const comparison = await renderedCard(COMPARISON_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "regenerate" }),
		);
		const buildingNotice = "visual.notices.buildingBy(name=Dana Example)";
		expect(
			await within(timeline).findByText(buildingNotice),
		).toBeInTheDocument();

		// The next read the page makes shows the build it was told about.
		serverState = { ...serverState, build: buildingBuild() };
		await user.click(
			within(comparison).getByRole("button", { name: "regenerate" }),
		);

		await screen.findByText("status.building(step=status.steps.rewriting)");
		await waitFor(() =>
			expect(
				within(timeline).queryByText(buildingNotice),
			).not.toBeInTheDocument(),
		);
		expect(
			within(comparison).getByText(
				"visual.notices.noValidReplacement(reason=report.dropReasons.fact_check)",
			),
		).toBeInTheDocument();
	});

	it("says a visual changed since the page loaded, and keeps it pending, when Accept meets a newer spec", async () => {
		const user = userEvent.setup();
		api.reviewVisual.mockResolvedValue({
			outcome: "visualChanged",
			specHash: "hash-timeline-2",
		});
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "accept" }),
		);

		expect(
			await within(timeline).findByText("visual.notices.visualChanged"),
		).toBeInTheDocument();
		expect(
			within(timeline).getByText("status.pending"),
		).toBeInTheDocument();
		expect(
			within(timeline).queryByText("status.accepted"),
		).not.toBeInTheDocument();
	});

	it("says so when the reviewed visual is no longer in the edition", async () => {
		const user = userEvent.setup();
		api.reviewVisual.mockResolvedValue({ outcome: "visualNotFound" });
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "discard" }),
		);

		await waitFor(() =>
			expect(api.toast.error).toHaveBeenCalledWith(
				"visual.notices.visualNotFound",
			),
		);
		expect(
			within(timeline).getByText("status.pending"),
		).toBeInTheDocument();
	});

	it("reports a failed review and gives the card its controls back", async () => {
		const user = userEvent.setup();
		api.reviewVisual.mockRejectedValue(new Error("Network error"));
		renderPage();

		const timeline = await renderedCard(TIMELINE_KEY);
		await user.click(
			within(timeline).getByRole("button", { name: "accept" }),
		);

		await waitFor(() =>
			expect(api.toast.error).toHaveBeenCalledWith("visual.reviewFailed"),
		);
		await waitFor(() =>
			expect(
				within(timeline).getByRole("button", { name: "accept" }),
			).toBeEnabled(),
		);
		expect(
			within(timeline).getByRole("button", { name: "discard" }),
		).toBeEnabled();
		expect(
			within(timeline).getByText("status.pending"),
		).toBeInTheDocument();
	});
});

describe("GlossyEditionPage — preview and downloads", () => {
	it("renders section text without raw HTML or remote images (KTD16)", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		try {
			renderPage(
				glossyEdition({
					edition: {
						content: editionContent({
							sections: [
								{
									sectionKey: "section-hostile",
									headingPath: ["Scope"],
									heading: "Scope",
									level: 2,
									markdown: [
										"Plain **bold** text with a [link](https://example.com/page).",
										"",
										'<div class="x">raw html</div>',
										"",
										"![remote](https://tracker.example.com/pixel.png)",
										"",
										"```mermaid",
										"graph TD; A-->B",
										"```",
									].join("\n"),
									wording: "rewritten",
									anchors: [],
								},
							],
							visuals: {},
						}),
					},
				}),
			);

			const heading = await screen.findByRole("heading", {
				name: "Scope",
			});
			const section = heading.closest("section") as HTMLElement;
			expect(within(section).getByText("bold").tagName).toBe("STRONG");
			expect(
				within(section).getByText(/with a link/),
			).toBeInTheDocument();
			expect(section.querySelector("a")).toBeNull();
			expect(section.querySelector("div.x")).toBeNull();
			expect(section.textContent).not.toContain("raw html");
			expect(section.querySelector("img")).toBeNull();
			expect(section.textContent).not.toContain("graph TD");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("shows the cover with both parties and the appendix with its provenance line (R35, R43)", async () => {
		renderPage(
			glossyEdition({
				brand: {
					preparer: {
						name: "Example Org",
						logoUrl:
							"https://storage.example.com/org-logo.png?sig=1",
						brandColorName: null,
						accentColors: [],
						guidance: null,
					},
					recipient: null,
					recipientVersion: 0,
				},
			}),
		);

		expect(
			await screen.findByRole("img", {
				name: "logoOf(name=Example Org)",
			}),
		).toHaveAttribute(
			"src",
			"https://storage.example.com/org-logo.png?sig=1",
		);
		// Without a saved recipient brand, the cover falls back to the source's client field.
		expect(screen.getByText("Example Corp")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "appendix" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("S1: Example Org annual report"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"provenance(title=Example business case, version=4, date=2026-09-20)",
			),
		).toBeInTheDocument();
	});

	it("downloads a DOCX through the Glossy renderer with the live brands and translated labels (R36)", async () => {
		const user = userEvent.setup();
		api.renderDocx.mockResolvedValue({
			blob: new Blob(["docx"]),
			omittedVisuals: 1,
			omittedImages: 0,
		});
		renderPage(
			glossyEdition({
				imageUrls: {
					"document-media/project-1/document-1/a.png":
						"https://storage.example.com/a.png?sig=1",
				},
			}),
		);
		await renderedCard(TIMELINE_KEY);

		await user.click(screen.getByRole("button", { name: "downloadDocx" }));

		await waitFor(() => expect(api.renderDocx).toHaveBeenCalledTimes(1));
		const input = api.renderDocx.mock.calls[0][0];
		expect(input.content.title).toBe("Example business case");
		expect(input.preparer).toEqual({ name: "Example Org", logoUrl: null });
		expect(input.recipient).toEqual({ name: null, logoUrl: null });
		expect(input.imageUrls).toEqual({
			"document-media/project-1/document-1/a.png":
				"https://storage.example.com/a.png?sig=1",
		});
		expect(input.labels.appendix).toBe("preview.appendix");
		// The preview's rendered visuals are reused rather than rendered again.
		expect([...input.renderedVisuals.keys()].sort()).toEqual(
			[COMPARISON_KEY, DIAGRAM_KEY, TIMELINE_KEY].sort(),
		);
		expect(api.triggerDownload).toHaveBeenCalledWith(
			expect.any(Blob),
			"example-business-case-glossy.docx",
		);
		expect(api.toast.warning).toHaveBeenCalledWith(
			"download.omittedVisuals(count=1)",
		);
	});

	it("shows the document's own images only through URLs the server signed", async () => {
		renderPage(
			glossyEdition({
				imageUrls: {
					[IMAGE_A]: "https://storage.example.com/a.png?sig=1",
				},
				edition: {
					content: editionContent({
						sections: [
							{
								sectionKey: "section-figures",
								headingPath: ["Figures"],
								heading: "Figures",
								level: 2,
								markdown: "First block.\n\nSecond block.",
								wording: "rewritten",
								anchors: [
									{
										blockIndex: 0,
										ref: { type: "image", s3Key: IMAGE_A },
									},
									{
										blockIndex: 1,
										ref: {
											type: "image",
											s3Key: "document-media/project-1/document-1/unsigned.png",
										},
									},
									{
										blockIndex: 1,
										ref: {
											type: "image",
											s3Key: "constructor",
										},
									},
								],
							},
						],
						visuals: {},
					}),
				},
			}),
		);

		const heading = await screen.findByRole("heading", { name: "Figures" });
		const section = heading.closest("section") as HTMLElement;
		const images = section.querySelectorAll("img");
		expect(images).toHaveLength(1);
		expect(images[0]).toHaveAttribute(
			"src",
			"https://storage.example.com/a.png?sig=1",
		);
		expect(images[0]).toHaveAttribute("alt", "documentImage");
	});

	it("places each visual before the block its anchor names, and a past-the-end anchor last", async () => {
		renderPage(
			glossyEdition({
				edition: {
					content: editionContent({
						sections: [
							editionContent().sections[0],
							{
								sectionKey: "section-options",
								headingPath: ["Budget and options"],
								heading: "Budget and options",
								level: 2,
								markdown: "Alpha block.\n\nBravo block.",
								wording: "rewritten",
								anchors: [
									{
										blockIndex: 9,
										ref: {
											type: "visual",
											visualKey: DIAGRAM_KEY,
										},
									},
									{
										blockIndex: 0,
										ref: {
											type: "visual",
											visualKey: COMPARISON_KEY,
										},
									},
								],
							},
						],
					}),
				},
			}),
		);

		const timeline = await card(TIMELINE_KEY);
		const comparison = await card(COMPARISON_KEY);
		const diagram = await card(DIAGRAM_KEY);
		const first = screen.getByText(
			"The programme costs 240k and starts in Q3.",
		);
		const second = screen.getByText("It pays back within a year.");
		expect(precedes(first, timeline)).toBe(true);
		expect(precedes(timeline, second)).toBe(true);

		const alpha = screen.getByText("Alpha block.");
		const bravo = screen.getByText("Bravo block.");
		expect(precedes(second, comparison)).toBe(true);
		expect(precedes(comparison, alpha)).toBe(true);
		expect(precedes(alpha, bravo)).toBe(true);
		expect(precedes(bravo, diagram)).toBe(true);
	});

	it("renders hostile appendix entries and additional material without markup or remote images (KTD16)", async () => {
		renderPage(
			glossyEdition({
				edition: {
					content: editionContent({
						appendix: {
							sources: [
								{
									id: "S1",
									text: 'Annual report <img src="https://tracker.example.com/s.png"> with a [link](https://example.com/source) and **weight**',
								},
							],
							details: [
								{
									label: "Client",
									value: "<b>Example Corp</b> ![logo](https://tracker.example.com/d.png)",
								},
							],
							placeholders: [
								{
									heading: "Budget",
									text: "<script>window.hostile = 1</script>TBD",
								},
							],
							assumptions: [
								{
									heading: null,
									text: "Rollout in Q4 ![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
									status: "ASSUMED",
									qualifier: "assumed",
								},
							],
							additionalMaterial: [
								{
									heading: "Extra",
									level: 2,
									markdown: [
										'<div class="hostile">raw html</div>',
										"",
										"![remote](https://tracker.example.com/extra.png)",
										"",
										"![vector](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
										"",
										"![dot](data:image/png;base64,iVBORw0KGgo=)",
										"",
										"See [the site](https://example.com/more).",
									].join("\n"),
									anchors: [],
								},
							],
						},
					}),
				},
			}),
		);

		const appendix = (
			await screen.findByRole("heading", { name: "appendix" })
		).closest("section") as HTMLElement;
		expect(appendix.querySelector("a")).toBeNull();
		expect(appendix.querySelector("b")).toBeNull();
		expect(appendix.querySelector("script")).toBeNull();
		expect(appendix.querySelector("div.hostile")).toBeNull();
		expect(appendix.textContent).not.toContain("raw html");
		// Only the raster data URI renders: no remote image, no SVG data URI.
		expect(
			[...appendix.querySelectorAll("img")].map((img) =>
				img.getAttribute("src"),
			),
		).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
		expect(within(appendix).getByText("weight").tagName).toBe("STRONG");
		expect(
			within(appendix).getByText(/with a link and/),
		).toBeInTheDocument();
		expect(within(appendix).getByText(/See the site/)).toBeInTheDocument();
		expect(within(appendix).getByText(/Rollout in Q4/)).toBeInTheDocument();
	});

	it("keeps the preview's signed image and logo URLs across build polls, and swaps them when an image is added", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let poll = 0;
		let signedKeys = [IMAGE_A];
		const signed = (path: string) =>
			`https://storage.example.com/${path}?X-Amz-Signature=sig-${poll}`;
		api.get.mockImplementation(async () => {
			poll += 1;
			return {
				...serverState,
				build: buildingBuild(poll),
				imageUrls: Object.fromEntries(
					signedKeys.map((key) => [key, signed(key)]),
				),
				brand: {
					...serverState.brand,
					preparer: {
						...serverState.brand.preparer,
						logoUrl: signed("logos/example-org.png"),
					},
				},
			};
		});
		renderPage(
			glossyEdition({
				build: buildingBuild(),
				edition: {
					content: editionContent({
						sections: [
							{
								sectionKey: "section-figures",
								headingPath: ["Figures"],
								heading: "Figures",
								level: 2,
								markdown: "First block.\n\nSecond block.",
								wording: "rewritten",
								anchors: [
									{
										blockIndex: 0,
										ref: { type: "image", s3Key: IMAGE_A },
									},
									{
										blockIndex: 1,
										ref: { type: "image", s3Key: IMAGE_B },
									},
								],
							},
						],
						visuals: {},
					}),
				},
			}),
		);

		const imageSources = () =>
			screen
				.getAllByRole("img", { name: "documentImage" })
				.map((image) => image.getAttribute("src"));
		const logoSource = () =>
			screen
				.getByRole("img", { name: "logoOf(name=Example Org)" })
				.getAttribute("src");

		await screen.findByText("status.progress(done=1, total=20)");
		expect(imageSources()).toEqual([
			`https://storage.example.com/${IMAGE_A}?X-Amz-Signature=sig-1`,
		]);
		expect(logoSource()).toContain("sig-1");

		for (const tick of [2, 3]) {
			await vi.advanceTimersByTimeAsync(3_000);
			await screen.findByText(`status.progress(done=${tick}, total=20)`);
			expect(imageSources()).toEqual([
				`https://storage.example.com/${IMAGE_A}?X-Amz-Signature=sig-1`,
			]);
			expect(logoSource()).toContain("sig-1");
		}

		// The server signs one more image: the preview takes the fresh set.
		signedKeys = [IMAGE_A, IMAGE_B];
		await vi.advanceTimersByTimeAsync(3_000);
		await screen.findByText("status.progress(done=4, total=20)");
		expect(imageSources()).toEqual([
			`https://storage.example.com/${IMAGE_A}?X-Amz-Signature=sig-4`,
			`https://storage.example.com/${IMAGE_B}?X-Amz-Signature=sig-4`,
		]);
		expect(logoSource()).toContain("sig-4");
	});

	it("asks for fresh signed reads before downloading from a page older than 45 minutes", async () => {
		const user = userEvent.setup();
		renderPage(
			glossyEdition({
				imageUrls: {
					[IMAGE_A]: "https://storage.example.com/a.png?sig=old",
				},
				brand: {
					preparer: {
						name: "Example Org",
						logoUrl:
							"https://storage.example.com/org-logo.png?sig=old",
						brandColorName: null,
						accentColors: [],
						guidance: null,
					},
				},
			}),
		);
		await renderedCard(TIMELINE_KEY);

		serverState = {
			...serverState,
			imageUrls: {
				[IMAGE_A]: "https://storage.example.com/a.png?sig=fresh",
			},
			brand: {
				...serverState.brand,
				preparer: {
					...serverState.brand.preparer,
					logoUrl:
						"https://storage.example.com/org-logo.png?sig=fresh",
				},
			},
		};
		const callsBefore = api.get.mock.calls.length;
		const later = Date.now() + 46 * 60 * 1000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(later);
		try {
			await user.click(
				screen.getByRole("button", { name: "downloadPdf" }),
			);
			await waitFor(() => expect(api.renderPdf).toHaveBeenCalledTimes(1));
		} finally {
			clock.mockRestore();
		}

		expect(api.get).toHaveBeenCalledTimes(callsBefore + 1);
		expect(api.get.mock.invocationCallOrder.at(-1)).toBeLessThan(
			api.renderPdf.mock.invocationCallOrder[0],
		);
		const input = api.renderPdf.mock.calls[0][0];
		expect(input.imageUrls).toEqual({
			[IMAGE_A]: "https://storage.example.com/a.png?sig=fresh",
		});
		expect(input.preparer.logoUrl).toBe(
			"https://storage.example.com/org-logo.png?sig=fresh",
		);
	});

	it("downloads a fresh page's edition without asking for it again", async () => {
		const user = userEvent.setup();
		renderPage(
			glossyEdition({
				imageUrls: {
					[IMAGE_A]: "https://storage.example.com/a.png?sig=1",
				},
			}),
		);
		await renderedCard(TIMELINE_KEY);
		const callsBefore = api.get.mock.calls.length;

		await user.click(screen.getByRole("button", { name: "downloadPdf" }));
		await waitFor(() => expect(api.renderPdf).toHaveBeenCalledTimes(1));

		expect(api.get).toHaveBeenCalledTimes(callsBefore);
		expect(api.renderPdf.mock.calls[0][0].imageUrls).toEqual({
			[IMAGE_A]: "https://storage.example.com/a.png?sig=1",
		});
	});
});

describe("GlossyEditionPage — Align first", () => {
	it("runs detection, not a build, and builds only what the editor confirmed (F2)", async () => {
		const user = userEvent.setup();
		api.detect.mockResolvedValue({
			outcome: "detected",
			contentHash: "0123456789abcdef",
			opportunities: [
				{
					sectionKey: "section-summary",
					heading: "Executive summary",
					kind: "timeline",
					reason: "Phases with dates.",
				},
				{
					sectionKey: "section-options",
					heading: "Budget and options",
					kind: "comparison",
					reason: "Two options.",
				},
			],
			fromCache: false,
			degraded: false,
			recipientWebsiteSuggestions: [],
		});
		api.build.mockResolvedValue({
			outcome: "started",
			startedAt: new Date(),
		});
		renderPage(glossyEdition({ edition: null }));

		await user.click(
			await screen.findByRole("radio", { name: "modes.align_first" }),
		);
		await user.click(
			screen.getByRole("button", { name: "toolbar.alignFirst" }),
		);

		expect(api.detect).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
		expect(api.build).not.toHaveBeenCalled();

		const panel = await screen.findByRole("region", { name: "title" });
		await user.click(
			within(panel).getByRole("checkbox", {
				name: /visual\.kinds\.comparison/,
			}),
		);
		await user.click(within(panel).getByRole("button", { name: "build" }));

		await waitFor(() => expect(api.build).toHaveBeenCalledTimes(1));
		expect(api.build.mock.calls[0][0].options).toEqual({
			mode: "align_first",
			lengthMode: "brief",
			styleDirection: "Calm and factual.",
			preparerOverrides: null,
			detection: {
				contentHash: "0123456789abcdef",
				opportunities: [
					{ sectionKey: "section-summary", kind: "timeline" },
				],
			},
		});
		// A started build closes the form.
		await waitFor(() =>
			expect(
				screen.queryByRole("region", { name: "title" }),
			).not.toBeInTheDocument(),
		);
	});

	it("shows Detect again when the build answers draftStale", async () => {
		const user = userEvent.setup();
		api.detect.mockResolvedValue({
			outcome: "detected",
			contentHash: "0123456789abcdef",
			opportunities: [],
			fromCache: true,
			degraded: false,
			recipientWebsiteSuggestions: [],
		});
		api.build.mockResolvedValue({ outcome: "draftStale" });
		renderPage(
			glossyEdition({
				edition: {
					lastOptions: {
						mode: "align_first",
						lengthMode: "standard",
						styleDirection: null,
						preparerOverrides: null,
					},
				},
			}),
		);

		// The last build's mode and length are preselected.
		await user.click(
			await screen.findByRole("button", { name: "toolbar.alignFirst" }),
		);
		const panel = await screen.findByRole("region", { name: "title" });
		await user.click(
			within(panel).getByRole("button", { name: "rebuild" }),
		);

		expect(
			await within(panel).findByText("draftStale"),
		).toBeInTheDocument();
		expect(api.build.mock.calls[0][0].options.lengthMode).toBe("standard");
		await user.click(
			within(panel).getByRole("button", { name: "detectAgain" }),
		);
		expect(api.detect).toHaveBeenCalledTimes(2);
	});
});

describe("GlossyEditionPage — accessibility", () => {
	it("has no axe violations for an editor and for a viewer", async () => {
		const editor = renderPage(
			glossyEdition({ edition: { outOfDate: true } }),
		);
		await renderedCard(TIMELINE_KEY);
		await renderedCard(COMPARISON_KEY);
		expect(await axe(editor.container)).toHaveNoViolations();
		editor.unmount();

		const viewer = renderPage(glossyEdition({ canEdit: false }));
		await renderedCard(TIMELINE_KEY);
		expect(await axe(viewer.container)).toHaveNoViolations();
	});

	it("has no axe violations with no edition yet", async () => {
		const { container } = renderPage(glossyEdition({ edition: null }));
		await screen.findByText("empty.title");
		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("GlossyEditionPage — translations", () => {
	type Tree = { [key: string]: string | Tree };

	const glossyOf = (messages: unknown): Tree =>
		(messages as { projects: { glossy: Tree } }).projects.glossy;

	/** `path -> message` for every string under a subtree. */
	function flatten(tree: Tree, prefix = ""): Map<string, string> {
		const out = new Map<string, string>();
		for (const [key, value] of Object.entries(tree)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "string") {
				out.set(path, value);
			} else {
				for (const [nested, message] of flatten(value, path)) {
					out.set(nested, message);
				}
			}
		}
		return out;
	}

	it("has German copy for every English message of the page, and nothing extra", () => {
		const english = flatten(glossyOf(en));
		const german = flatten(glossyOf(de));

		expect([...german.keys()].sort()).toEqual([...english.keys()].sort());
		for (const [path, message] of german) {
			expect(message.trim(), path).not.toBe("");
		}
	});

	it("keeps the mode names Roll the dice and Align first in English in German (product decision)", () => {
		const english = flatten(glossyOf(en));
		const german = flatten(glossyOf(de));
		for (const path of [
			"toolbar.modes.roll_the_dice",
			"toolbar.modes.align_first",
			"toolbar.alignFirst",
			"alignFirst.title",
		]) {
			expect(german.get(path), path).toBe(english.get(path));
		}
		expect(german.get("toolbar.modes.roll_the_dice")).toBe("Roll the dice");
		expect(german.get("toolbar.modes.align_first")).toBe("Align first");
		for (const [path, message] of german) {
			expect(message, path).not.toMatch(
				/Direkt erstellen|Erst abstimmen/,
			);
		}
	});

	it("has copy for every code the server can send", () => {
		const english = flatten(glossyOf(en));
		const german = flatten(glossyOf(de));
		for (const [subtree, codes] of Object.entries(GLOSSY_CODED_COPY)) {
			for (const code of codes) {
				expect(
					english.has(`${subtree}.${code}`),
					`en ${subtree}.${code}`,
				).toBe(true);
				expect(
					german.has(`${subtree}.${code}`),
					`de ${subtree}.${code}`,
				).toBe(true);
			}
		}
	});
});
