/**
 * The Context tab's Download item for an uploaded OpenAPI file (Fizzy #2280).
 *
 * Ingestion re-types an uploaded OpenAPI file from `FILE` to `API_SPEC`. The
 * server always signed that as the original upload, but the list kept its own
 * copy of the "original file" types without `API_SPEC`, so the row offered the
 * "extracted text" submenu — Markdown, PDF, Word — and its PDF item printed the
 * raw JSON. Downloading a Swagger file therefore looked impossible. The list now
 * classifies with the server's own function, so the row offers the single
 * Download of the file as uploaded.
 *
 * Copy keys render raw: the global setup mocks `next-intl` to return the key.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCapabilityGateView } from "../../lib/capability-gate-view";

// ── jsdom polyfills ──────────────────────────────────────────────────────
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
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	contextsListMock,
	createDownloadUrlMock,
	renderMarkdownToPdfMock,
	refetchGatesMock,
	gateRef,
	trackEventMock,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	createDownloadUrlMock: vi.fn(),
	renderMarkdownToPdfMock: vi.fn(),
	refetchGatesMock: vi.fn(),
	gateRef: { current: null as CapabilityGate | null },
	trackEventMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: {} } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({
						input,
						refetchInterval,
					}: {
						input: unknown;
						refetchInterval?: unknown;
					}) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: () => contextsListMock(input),
						refetchInterval,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
				delete: { call: vi.fn() },
				createDownloadUrl: { call: createDownloadUrlMock },
				retryStalled: { call: vi.fn() },
				repositorySync: {
					get: {
						queryOptions: () => ({
							queryKey: [
								"projects.contexts.repositorySync.get",
							] as const,
							queryFn: async () => null,
						}),
					},
					configure: { mutationOptions: () => ({}) },
					syncNow: { mutationOptions: () => ({}) },
					disable: { mutationOptions: () => ({}) },
				},
			},
		},
		integrations: {
			teams: {
				contextAccess: {
					queryOptions: () => ({
						queryKey: ["integrations.teams.contextAccess"] as const,
						queryFn: async () => ({
							connected: false,
							contexts: [],
						}),
					}),
				},
			},
		},
	},
}));

vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../capability-gates/useCapabilityGates")
			>();
		return {
			...actual,
			useCapabilityGate: (key: string) => {
				const gate =
					gateRef.current?.capabilityKey === key
						? gateRef.current
						: null;
				return {
					gate,
					view: gate ? buildCapabilityGateView(gate) : null,
					blocked: false,
					hidden: false,
				};
			},
			useCapabilityGates: () => ({
				projectId: "proj_1",
				enabled: true,
				isLoading: false,
				gates: new Map(),
				suppressedCount: 0,
				isSessionDismissed: () => false,
				linkFor: () => null,
				codebaseRetryFor: () => undefined,
				codebaseRetrying: false,
				suppress: () => {},
				restore: () => {},
				refetch: refetchGatesMock,
			}),
		};
	},
);

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("../../lib/markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/markdown-to-document")>();
	return {
		...actual,
		renderMarkdownToPdf: renderMarkdownToPdfMock,
		renderMarkdownToDocx: vi.fn(async () => new Blob(["docx"])),
	};
});

vi.mock("../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../DownloadAllContextsButton", () => ({
	DownloadAllContextsButton: () => null,
}));
// The readiness tiles live in the hero's aside; render just that.
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: ({ aside }: { aside?: React.ReactNode }) => (
		<div>{aside}</div>
	),
}));

import { ProjectContextsList } from "../ProjectContextsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const LONG_AGO = new Date("2026-09-01T08:00:00Z");

function uploadedContext(id: string, type: string, filename: string) {
	return {
		id,
		type,
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: LONG_AGO,
		createdAt: LONG_AGO,
		sourceTitle: null,
		originalFilename: filename,
		mimeType: "application/json",
		s3Path: `projects/proj_1/${id}.json`,
		fileSize: 1691,
		contentLength: 640,
		metadata: { title: filename },
	};
}

function textContext(id: string, title: string) {
	return {
		id,
		type: "TEXT",
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: LONG_AGO,
		createdAt: LONG_AGO,
		sourceTitle: title,
		s3Path: null,
		contentLength: 120,
		metadata: { title },
	};
}

/** Opens the row's "More options" menu and returns the menu. */
async function openRowMenu(
	user: ReturnType<typeof userEvent.setup>,
	container: HTMLElement,
	contextId: string,
): Promise<HTMLElement> {
	await waitFor(() =>
		expect(
			container.querySelector(`[data-context-id="${contextId}"]`),
		).not.toBeNull(),
	);
	const row = container.querySelector<HTMLElement>(
		`[data-context-id="${contextId}"]`,
	);
	if (!row) {
		throw new Error(`no row for ${contextId}`);
	}
	await user.click(within(row).getByRole("button", { name: "More options" }));
	return screen.findByRole("menu");
}

function serveContexts(contexts: unknown[]) {
	contextsListMock.mockResolvedValue({
		contexts,
		total: contexts.length,
		hasMore: false,
	});
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — downloading an uploaded OpenAPI file (Fizzy #2280)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		createDownloadUrlMock.mockReset();
		renderMarkdownToPdfMock.mockReset();
		trackEventMock.mockReset();
		gateRef.current = null;
	});

	it("offers the file as uploaded, not the extracted-text formats", async () => {
		serveContexts([
			uploadedContext("ctx_spec", "API_SPEC", "petstore.json"),
		]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		const menu = await openRowMenu(user, container, "ctx_spec");

		expect(
			within(menu).getByRole("menuitem", { name: "actionForRow" }),
		).toBeInTheDocument();
		expect(
			within(menu).queryByRole("menuitem", { name: "format.aria" }),
		).not.toBeInTheDocument();
	});

	it("saves the signed original without converting it", async () => {
		createDownloadUrlMock.mockResolvedValue({
			url: "https://storage.example.com/signed/petstore.json",
			filename: "petstore.json",
			expiresAt: "2026-10-13T00:05:00.000Z",
			contextClass: "A",
		});
		const clicked: Array<{ href: string; download: string }> = [];
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(function (this: HTMLAnchorElement) {
				clicked.push({ href: this.href, download: this.download });
			});
		serveContexts([
			uploadedContext("ctx_spec", "API_SPEC", "petstore.json"),
		]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		const menu = await openRowMenu(user, container, "ctx_spec");
		await user.click(
			within(menu).getByRole("menuitem", { name: "actionForRow" }),
		);

		await waitFor(() =>
			expect(clicked).toContainEqual({
				href: "https://storage.example.com/signed/petstore.json",
				download: "petstore.json",
			}),
		);
		expect(createDownloadUrlMock).toHaveBeenCalledWith({
			contextId: "ctx_spec",
			projectId: "proj_1",
			organizationId: "org_example",
		});
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		clickSpy.mockRestore();
	});

	it("keeps the format submenu for extracted text", async () => {
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		const menu = await openRowMenu(user, container, "ctx_note");

		expect(
			within(menu).getByRole("menuitem", { name: "format.aria" }),
		).toBeInTheDocument();
		expect(
			within(menu).queryByRole("menuitem", { name: "actionForRow" }),
		).not.toBeInTheDocument();
	});
});
