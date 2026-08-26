/**
 * Tests for AuditTraceDiagram.
 *
 * Covers:
 *   - empty state when no rows match the correlation ID
 *   - renders N nodes when N events are returned
 *   - Export button triggers a Blob download
 *   - buildTraceSvg returns a valid SVG string
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const tracedRequestMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			list: (...args: unknown[]) => listMock(...args),
			tracedRequest: (...args: unknown[]) => tracedRequestMock(...args),
		},
	},
}));

import { AuditTraceDiagram, buildTraceSvg } from "../AuditTraceDiagram";

function renderDiagram(props: {
	correlationId?: string | null;
	open?: boolean;
	layout?: "horizontal" | "vertical";
	presentation?: "dialog" | "sheet-left";
}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditTraceDiagram
				organizationId="org-1"
				correlationId={props.correlationId ?? "req_test"}
				open={props.open ?? true}
				onClose={() => {}}
				onShowInTable={() => {}}
				layout={props.layout}
				presentation={props.presentation}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMock.mockReset();
	tracedRequestMock.mockReset();
	// Default the tracedRequest mock to reject so the diagram falls
	// through to the legacy audit.list path. Individual tests opt in by
	// providing a resolved value.
	tracedRequestMock.mockRejectedValue(new Error("not stubbed"));
});

describe("AuditTraceDiagram", () => {
	it("shows the empty-state copy when no rows match the correlation ID", async () => {
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		renderDiagram({ correlationId: "req_unknown" });
		await waitFor(() => {
			expect(screen.getByTestId("audit-trace-empty")).toBeInTheDocument();
		});
	});

	it("renders N nodes for N returned rows", async () => {
		const rows = [
			{
				id: "row-1",
				action: "auth.login.success",
				createdAt: new Date("2026-05-17T10:00:00Z"),
				outcome: "success",
				severity: "info",
				actorEmailSnapshot: "alice@example.com",
				actorNameSnapshot: "Alice",
				actorType: "user",
				resourceName: null,
				durationMs: 12,
				metadata: { correlationId: "req_abc" },
			},
			{
				id: "row-2",
				action: "org.member.invited",
				createdAt: new Date("2026-05-17T10:00:02Z"),
				outcome: "success",
				severity: "info",
				actorEmailSnapshot: "alice@example.com",
				actorNameSnapshot: "Alice",
				actorType: "user",
				resourceName: "bob@example.com",
				durationMs: 35,
				metadata: { correlationId: "req_abc" },
			},
			{
				id: "row-3",
				action: "error.internal",
				createdAt: new Date("2026-05-17T10:00:05Z"),
				outcome: "failure",
				severity: "error",
				actorEmailSnapshot: null,
				actorNameSnapshot: null,
				actorType: "system",
				resourceName: null,
				durationMs: 250,
				metadata: { correlationId: "req_abc" },
			},
		];
		listMock.mockResolvedValue({
			items: rows,
			nextCursor: null,
			totalCount: rows.length,
		});
		renderDiagram({ correlationId: "req_abc" });
		await waitFor(() => {
			expect(screen.getByTestId("audit-trace-nodes")).toBeInTheDocument();
		});
		expect(screen.getByTestId("audit-trace-node-0")).toBeInTheDocument();
		expect(screen.getByTestId("audit-trace-node-1")).toBeInTheDocument();
		expect(screen.getByTestId("audit-trace-node-2")).toBeInTheDocument();
	});

	it("export click triggers a Blob URL", async () => {
		const rows = [
			{
				id: "row-1",
				action: "auth.login.success",
				createdAt: new Date("2026-05-17T10:00:00Z"),
				outcome: "success",
				severity: "info",
				actorEmailSnapshot: "alice@example.com",
				actorNameSnapshot: "Alice",
				actorType: "user",
				resourceName: null,
				durationMs: 12,
				metadata: { correlationId: "req_abc" },
			},
		];
		listMock.mockResolvedValue({
			items: rows,
			nextCursor: null,
			totalCount: 1,
		});
		const createObjectURLSpy = vi.fn(() => "blob:mock");
		const revokeObjectURLSpy = vi.fn();
		// JSDOM lacks URL.createObjectURL; stub it.
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			writable: true,
			value: createObjectURLSpy,
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			writable: true,
			value: revokeObjectURLSpy,
		});

		renderDiagram({ correlationId: "req_abc" });
		await waitFor(() => {
			expect(screen.getByTestId("audit-trace-export")).toBeEnabled();
		});

		fireEvent.click(screen.getByTestId("audit-trace-export"));
		expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
		// The first argument is the Blob.
		const blob = createObjectURLSpy.mock.calls[0]?.[0] as unknown as Blob;
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.type).toBe("image/svg+xml");
	});
});

describe("AuditTraceDiagram - v2 vertical/sheet-left (item 1)", () => {
	it("renders the sheet-left presentation by default", async () => {
		listMock.mockResolvedValue({
			items: [
				{
					id: "row-1",
					action: "auth.login.success",
					createdAt: new Date("2026-05-17T10:00:00Z"),
					outcome: "success",
					severity: "info",
					actorEmailSnapshot: "alice@example.com",
					actorNameSnapshot: "Alice",
					actorType: "user",
					resourceName: null,
					durationMs: 12,
					metadata: { correlationId: "req_v2" },
				},
			],
			nextCursor: null,
			totalCount: 1,
		});
		renderDiagram({ correlationId: "req_v2" });
		const surface = await screen.findByTestId("audit-trace-diagram");
		expect(surface.getAttribute("data-presentation")).toBe("sheet-left");
	});

	it("renders interleaved audit + span nodes when tracedRequest returns spans (item 4)", async () => {
		tracedRequestMock.mockResolvedValue({
			items: [
				{
					id: "row-1",
					action: "auth.login.failure",
					createdAt: new Date("2026-05-17T10:00:00Z"),
					outcome: "failure",
					severity: "warning",
					actorEmailSnapshot: "alice@example.com",
					actorNameSnapshot: "Alice",
					actorType: "user",
					resourceName: null,
					durationMs: 12,
					metadata: { correlationId: "req_v2_failure" },
				},
			],
			spans: [
				{
					id: "span-1",
					correlationId: "req_v2_failure",
					kind: "db",
					name: "User.findUnique",
					startedAt: new Date("2026-05-17T10:00:00.001Z"),
					durationMs: 4,
					status: "ok",
					errorMessage: null,
					attributes: { model: "User", action: "findUnique" },
				},
				{
					id: "span-2",
					correlationId: "req_v2_failure",
					kind: "temporal_activity",
					name: "send-verification-email",
					startedAt: new Date("2026-05-17T10:00:00.005Z"),
					durationMs: 250,
					status: "error",
					errorMessage: "smtp timeout",
					attributes: {},
				},
			],
		});
		renderDiagram({ correlationId: "req_v2_failure" });
		await waitFor(() => {
			expect(screen.getByTestId("audit-trace-nodes")).toBeInTheDocument();
		});
		expect(screen.getByTestId("audit-trace-node-0")).toBeInTheDocument();
		// Both spans are rendered, with their kind exposed on the data attr.
		const dbSpan = screen
			.getByText("User.findUnique")
			.closest("[data-span-kind]");
		expect(dbSpan?.getAttribute("data-span-kind")).toBe("db");
		const tempSpan = screen
			.getByText("send-verification-email")
			.closest("[data-span-kind]");
		expect(tempSpan?.getAttribute("data-span-kind")).toBe(
			"temporal_activity",
		);
	});

	it("falls back to audit.list when tracedRequest is unavailable", async () => {
		// tracedRequest already rejected by the beforeEach. We expect
		// listMock to be called instead.
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		renderDiagram({ correlationId: "req_v2_fallback" });
		await waitFor(() => {
			expect(listMock).toHaveBeenCalled();
		});
	});
});

describe("buildTraceSvg", () => {
	it("produces a valid SVG string with one node per row", () => {
		const rows = [
			{
				id: "row-1",
				action: "auth.login.success",
				createdAt: new Date("2026-05-17T10:00:00Z"),
				outcome: "success",
				severity: "info",
				actorEmailSnapshot: "alice@example.com",
				actorNameSnapshot: "Alice",
				actorType: "user",
				resourceName: null,
				durationMs: 12,
				metadata: null,
			},
			{
				id: "row-2",
				action: "error.internal",
				createdAt: new Date("2026-05-17T10:00:05Z"),
				outcome: "failure",
				severity: "error",
				actorEmailSnapshot: null,
				actorNameSnapshot: null,
				actorType: "system",
				resourceName: null,
				durationMs: null,
				metadata: null,
			},
		];
		const svg = buildTraceSvg(rows);
		expect(svg).toContain("<svg");
		expect(svg).toContain("</svg>");
		expect(svg).toContain("auth.login.success");
		expect(svg).toContain("error.internal");
		// 2 events ⇒ message includes "(2 events)"
		expect(svg).toContain("(2 events)");
	});

	it("handles the empty-rows case without crashing", () => {
		const svg = buildTraceSvg([]);
		expect(svg).toContain("<svg");
		expect(svg).toContain("(0 events)");
	});
});
