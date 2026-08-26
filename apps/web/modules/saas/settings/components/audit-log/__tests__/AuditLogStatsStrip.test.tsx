/**
 * Tests for AuditLogStatsStrip.
 *
 * Stub `orpcClient.audit.stats` to surface the four states (loading,
 * empty, populated, error) and assert the rendered output for each.
 *
 * Item 10 expectation: failuresToday is NOT highlighted, even when > 0.
 * Item 11 expectation: cards are compact (no "Last activity" card).
 * v2 item 5 expectation: cards include Avg latency (with window
 * selector) + Sessions today; topAction / uniqueActors are gone.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statsMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			stats: (...args: unknown[]) => statsMock(...args),
		},
	},
}));

import {
	AuditLogStatsStrip,
	formatAverageLatency,
} from "../AuditLogStatsStrip";

function statsPayload(over: Record<string, unknown> = {}) {
	return {
		eventsToday: 0,
		failuresToday: 0,
		uniqueActorsToday: 0,
		sessionsToday: 0,
		lastEventAt: null,
		topAction: null,
		hourlyVolume: Array.from({ length: 24 }, () => 0),
		averageLatencyMs: null,
		latencySparkline: Array.from({ length: 24 }, () => 0),
		latencyWindow: "24h",
		...over,
	};
}

function renderStrip(orgId: string | null = "org-1") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditLogStatsStrip organizationId={orgId} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	statsMock.mockReset();
	try {
		window.localStorage.removeItem("audit-log:latency-window");
	} catch {
		// Ignore.
	}
});

describe("AuditLogStatsStrip", () => {
	it("renders the four v2 cards (events / failures / avg-latency / sessions)", async () => {
		statsMock.mockResolvedValue(
			statsPayload({
				eventsToday: 42,
				failuresToday: 3,
				sessionsToday: 11,
				averageLatencyMs: 137,
				hourlyVolume: Array.from({ length: 24 }, (_, i) => i),
				latencySparkline: Array.from({ length: 24 }, () => 50),
			}),
		);

		renderStrip();

		await waitFor(() => {
			expect(screen.getByText("42")).toBeInTheDocument();
		});
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("11")).toBeInTheDocument();
		expect(screen.getByText("137 ms")).toBeInTheDocument();

		// Four editorial labels render: events, failures, avg latency, sessions.
		expect(
			screen.getByText("settings.auditLog.stats.eventsToday"),
		).toBeInTheDocument();
		expect(
			screen.getByText("settings.auditLog.stats.failuresToday"),
		).toBeInTheDocument();
		expect(
			screen.getByText("settings.auditLog.stats.averageLatency"),
		).toBeInTheDocument();
		expect(
			screen.getByText("settings.auditLog.stats.sessionsToday"),
		).toBeInTheDocument();
	});

	it("does NOT render the legacy 'Top action today' or 'Unique actors today' cards", async () => {
		statsMock.mockResolvedValue(
			statsPayload({
				eventsToday: 2,
				failuresToday: 0,
				sessionsToday: 1,
				lastEventAt: new Date().toISOString(),
			}),
		);
		renderStrip();
		await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
		expect(
			screen.queryByText("settings.auditLog.stats.lastActivity"),
		).toBeNull();
		expect(
			screen.queryByText("settings.auditLog.stats.topAction"),
		).toBeNull();
		expect(
			screen.queryByText("settings.auditLog.stats.uniqueActors"),
		).toBeNull();
	});

	it("renders an em-dash when averageLatencyMs is null", async () => {
		statsMock.mockResolvedValue(
			statsPayload({
				eventsToday: 0,
				averageLatencyMs: null,
			}),
		);
		renderStrip();
		await waitFor(() =>
			expect(
				screen.getByText("settings.auditLog.stats.averageLatency"),
			).toBeInTheDocument(),
		);
		// Em-dash should be rendered as the value text.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
	});

	it("renders the error panel when the query fails", async () => {
		statsMock.mockRejectedValue(new Error("boom"));
		renderStrip();
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeInTheDocument();
		});
		expect(screen.getByRole("alert").textContent).toContain(
			"settings.auditLog.stats.error",
		);
	});

	it("passes organizationId and latencyWindow through to the procedure", async () => {
		statsMock.mockResolvedValue(statsPayload());
		renderStrip("org-42");
		await waitFor(() => expect(statsMock).toHaveBeenCalled());
		expect(statsMock.mock.calls[0]?.[0]).toMatchObject({
			organizationId: "org-42",
			latencyWindow: "24h",
		});
	});

	it("always queries the 24h latency window regardless of any stale localStorage value", async () => {
		// Set a stale value from a previous build that supported a
		// dropdown. The locked-24h implementation must ignore it.
		try {
			window.localStorage.setItem("audit-log:latency-window", "6h");
		} catch {
			// Ignore.
		}
		statsMock.mockResolvedValue(statsPayload());
		renderStrip("org-1");
		await waitFor(() => expect(statsMock).toHaveBeenCalled());
		const lastCallArg = statsMock.mock.calls.at(-1)?.[0] as
			| { latencyWindow?: string }
			| undefined;
		expect(lastCallArg?.latencyWindow).toBe("24h");
	});

	it("does NOT render a latency-window dropdown", async () => {
		statsMock.mockResolvedValue(statsPayload());
		renderStrip("org-1");
		await waitFor(() => expect(statsMock).toHaveBeenCalled());
		expect(
			screen.queryByTestId("audit-stats-latency-window"),
		).not.toBeInTheDocument();
	});

	it("renders the static (24h) suffix on the avg-latency card label", async () => {
		statsMock.mockResolvedValue(statsPayload());
		renderStrip("org-1");
		const label = await screen.findByTestId(
			"audit-stats-avg-latency-label",
		);
		expect(label.textContent).toMatch(/\(24h\)/);
	});

	it("does NOT highlight failuresToday when > 0 (item 10)", async () => {
		statsMock.mockResolvedValue(
			statsPayload({
				eventsToday: 10,
				failuresToday: 5,
				sessionsToday: 0,
			}),
		);
		renderStrip();
		await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());
		const value = screen.getByText("5");
		// Item 10 explicitly removed the warning highlight. Assert it stays
		// as the regular foreground tone.
		expect(value.className).not.toContain("text-highlight");
	});
});

describe("formatAverageLatency", () => {
	it("formats sub-1s values in ms with rounding", () => {
		expect(formatAverageLatency(47)).toBe("47 ms");
		expect(formatAverageLatency(999)).toBe("999 ms");
	});
	it("formats >= 1s values in seconds with one decimal", () => {
		expect(formatAverageLatency(1200)).toBe("1.2 s");
		expect(formatAverageLatency(15500)).toBe("15.5 s");
	});
	it("returns the em-dash for null/negative/non-finite", () => {
		expect(formatAverageLatency(null)).toBe("—");
		expect(formatAverageLatency(-1)).toBe("—");
		expect(formatAverageLatency(Number.NaN)).toBe("—");
	});
});
