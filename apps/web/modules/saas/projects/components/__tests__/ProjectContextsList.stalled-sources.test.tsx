/**
 * Stuck sources on the Context tab (Fizzy #2886).
 *
 * The stall banner used to say "a source stopped processing" without saying
 * which, and fired for live integrations that were never going to "finish".
 * The server now names the stuck sources on the gate; this pins what the list
 * does with them:
 *   1. A named row is outlined and carries its own Retry.
 *   2. A group holding one says so on its header while collapsed.
 *   3. Choosing a name in the banner opens the group, scrolls to the row and
 *      focuses it.
 *   4. Retry restarts that row and re-reads both the list and the gates.
 *   5. The Active tile counts only rows with real background work, not a live
 *      integration whose status is PENDING by design.
 *
 * The gate hook is mocked with a gate the real view builder turns into the
 * banner's view, so the banner itself is the real one.
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
	retryStalledMock,
	refetchGatesMock,
	gateRef,
	trackEventMock,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	retryStalledMock: vi.fn(),
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
				createDownloadUrl: { call: vi.fn() },
				retryStalled: { call: retryStalledMock },
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

function fileContext(id: string, filename: string, status = "EXTRACTING") {
	return {
		id,
		type: "FILE",
		extractionStatus: status,
		extractionError: null,
		embeddedAt: null,
		createdAt: LONG_AGO,
		sourceTitle: null,
		originalFilename: filename,
		metadata: { title: filename },
	};
}

function transcriptContext(id: string, meetingSubject: string) {
	return {
		id,
		type: "MEETING_TRANSCRIPT",
		extractionStatus: "EXTRACTING",
		extractionError: null,
		embeddedAt: null,
		createdAt: LONG_AGO,
		metadata: {
			meetingId: `meeting-${id}`,
			meetingSubject,
			meetingDate: "2026-09-01T08:00:00Z",
		},
	};
}

function slackContext(id: string) {
	return {
		id,
		type: "INTEGRATION",
		extractionStatus: "PENDING",
		extractionError: null,
		embeddedAt: null,
		createdAt: LONG_AGO,
		metadata: { provider: "SLACK", channelName: "example-channel" },
	};
}

function stalledGate(
	subjects: CapabilityGate["subjects"],
	subjectTotal = subjects.length,
): CapabilityGate {
	return {
		capabilityKey: "context.use-linked-source",
		state: "HARD_BLOCK",
		reasonKey: "context.ingestion-stalled",
		blockingDependency: "source ingestion",
		remedy: null,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
		subjects,
		subjectTotal,
		suppressed: false,
		fingerprint: "ctx:0",
	};
}

function serveContexts(contexts: unknown[]) {
	contextsListMock.mockResolvedValue({
		contexts,
		total: contexts.length,
		hasMore: false,
	});
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — stuck sources (Fizzy #2886)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		retryStalledMock.mockReset();
		refetchGatesMock.mockReset();
		trackEventMock.mockReset();
		gateRef.current = null;
		retryStalledMock.mockResolvedValue({
			contextId: "ctx_file",
			dispatch: "processing",
			workflowId: "project-context-processing-ctx_file-retry-1",
		});
	});

	it("outlines a named row and gives it its own Retry", async () => {
		serveContexts([
			fileContext("ctx_file", "example-brief.pdf"),
			fileContext("ctx_ok", "example-notes.pdf", "COMPLETED"),
		]);
		gateRef.current = stalledGate([
			{ id: "ctx_file", label: "example-brief.pdf" },
		]);

		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		const marker = await screen.findByTestId("context-stalled-ctx_file");
		const row = container.querySelector<HTMLElement>(
			'[data-context-id="ctx_file"]',
		);
		expect(row?.className).toContain("ring-destructive");
		expect(row).toContainElement(marker);
		expect(
			within(marker).getByRole("button", {
				name: "actionForRow",
			}),
		).toBeInTheDocument();

		// The healthy row is left alone.
		const healthy = container.querySelector<HTMLElement>(
			'[data-context-id="ctx_ok"]',
		);
		expect(healthy?.className).not.toContain("ring-destructive");
		expect(
			screen.queryByTestId("context-stalled-ctx_ok"),
		).not.toBeInTheDocument();
	});

	it("restarts the row on Retry and re-reads the list and the gates", async () => {
		serveContexts([fileContext("ctx_file", "example-brief.pdf")]);
		gateRef.current = stalledGate([
			{ id: "ctx_file", label: "example-brief.pdf" },
		]);
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		const marker = await screen.findByTestId("context-stalled-ctx_file");
		await user.click(
			within(marker).getByRole("button", { name: "actionForRow" }),
		);

		await waitFor(() =>
			expect(retryStalledMock).toHaveBeenCalledWith({
				contextId: "ctx_file",
				projectId: "proj_1",
			}),
		);
		await waitFor(() => expect(refetchGatesMock).toHaveBeenCalled());
		// The list was read once on mount and again after the retry.
		await waitFor(() =>
			expect(contextsListMock.mock.calls.length).toBeGreaterThan(1),
		);
	});

	it("marks a collapsed group holding a stuck source on its header", async () => {
		serveContexts([transcriptContext("ctx_tx", "Example sync")]);
		gateRef.current = stalledGate([
			{ id: "ctx_tx", label: "Example sync" },
		]);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const header = await screen.findByText("Meeting Transcripts");
		// Collapsed: the row is not on the page, the header says why to open it.
		expect(
			screen.queryByTestId("context-stalled-ctx_tx"),
		).not.toBeInTheDocument();
		const group = header.closest("div.rounded-xl");
		expect(group?.className).toContain("border-destructive");
		expect(
			within(group as HTMLElement).getAllByText("groupStuck").length,
		).toBeGreaterThan(0);
	});

	it("opens the group, scrolls to the row and focuses it when its name is chosen in the banner", async () => {
		serveContexts([transcriptContext("ctx_tx", "Example sync")]);
		gateRef.current = stalledGate([
			{ id: "ctx_tx", label: "Example sync" },
		]);
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const user = userEvent.setup();

		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await screen.findByText("Meeting Transcripts");
		await user.click(screen.getByRole("button", { name: "Example sync" }));

		const row = await waitFor(() => {
			const found = container.querySelector<HTMLElement>(
				'[data-context-id="ctx_tx"]',
			);
			expect(found).not.toBeNull();
			return found as HTMLElement;
		});
		expect(row.className).toContain("ring-destructive");
		await waitFor(() =>
			expect(scrollIntoView).toHaveBeenCalledWith(
				expect.objectContaining({ block: "center" }),
			),
		);
		expect(scrollIntoView.mock.contexts.at(-1)).toBe(row);
		await waitFor(() => expect(document.activeElement).toBe(row));
	});

	it("shows no banner, names nothing and outlines nothing when the gate names no source", async () => {
		serveContexts([fileContext("ctx_file", "example-brief.pdf")]);
		gateRef.current = stalledGate([]);

		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		// The list has rendered its row, so an absent banner is an answer.
		await waitFor(() =>
			expect(
				container.querySelector('[data-context-id="ctx_file"]'),
			).not.toBeNull(),
		);
		// A warning with no source to point at is the one AC-4 forbids.
		expect(
			screen.queryByText("reason.context.ingestion-stalled.title"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("reason.context.ingestion-stalled.body"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("context-stalled-ctx_file"),
		).not.toBeInTheDocument();
		expect(
			container.querySelector('[data-context-id="ctx_file"]')?.className,
		).not.toContain("ring-destructive");
	});

	it("leaves a live integration out of the Active count", async () => {
		serveContexts([
			slackContext("ctx_slack"),
			fileContext("ctx_file", "example-brief.pdf"),
		]);

		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(
			await screen.findByTestId("context-readiness-active"),
		).toHaveTextContent("1");
	});
});
