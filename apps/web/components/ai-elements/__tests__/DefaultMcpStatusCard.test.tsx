/**
 * Unit tests for `DefaultMcpStatusCard`.
 *
 * The card renders inside an assistant turn when the orchestrator workflow
 * emits a structured CTA payload. Two `kind` variants are supported:
 *
 *   - `"connection-needed"` — legacy connect-CTA. Renders the title +
 *     body + a primary action button. Preserves the legacy
 *     `data-testid="connect-excalidraw-card"` for the Excalidraw branch
 *     so the existing E2E (`nexus-excalidraw-routing.spec.ts` scenario 2)
 *     stays green without an assertion rewrite. Other servers (or other
 *     kinds) get the generic `data-testid="default-mcp-status-card"` +
 *     a kind/serverKey-scoped secondary testid.
 *   - `"service-down"` — parameterized title/body, no primary action
 *     button (the discriminated union forbids `primaryAction` here at
 *     the TYPE level; v1 has no inline retry).
 *
 * Coverage:
 *   - connection-needed rendering (copy + CTA button + href)
 *   - service-down rendering (title + body, no CTA, no retry button)
 *   - data-testid legacy preservation for the Excalidraw connection-needed
 *     branch
 *   - data-testid generalization for non-Excalidraw and service-down branches
 *   - `isDefaultMcpStatusCta` type guard contract (positive + negative cases)
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	DefaultMcpStatusCard,
	type DefaultMcpStatusCtaPayload,
	isDefaultMcpStatusCta,
} from "../DefaultMcpStatusCard";

const CONNECTION_NEEDED_EXCALIDRAW: DefaultMcpStatusCtaPayload = {
	type: "structured_cta",
	kind: "connection-needed",
	serverKey: "excalidraw",
	serverName: "Excalidraw",
	title: "Connect Excalidraw to render diagrams",
	body: "Set up Excalidraw in your MCP servers to start drawing.",
	primaryAction: {
		label: "Connect Excalidraw",
		href: "/app/settings/mcp-servers",
	},
};

const SERVICE_DOWN_EXCALIDRAW: DefaultMcpStatusCtaPayload = {
	type: "structured_cta",
	kind: "service-down",
	serverKey: "excalidraw",
	serverName: "Excalidraw",
	title: "Excalidraw is temporarily unavailable",
	body: "We couldn't reach the Excalidraw service to render your diagram. Try again in a moment.",
};

// -----------------------------------------------------------------------
// kind = "connection-needed"
// -----------------------------------------------------------------------

describe("DefaultMcpStatusCard — connection-needed", () => {
	it("renders the title, body, and primary action CTA", () => {
		render(<DefaultMcpStatusCard payload={CONNECTION_NEEDED_EXCALIDRAW} />);

		expect(
			screen.getByText("Connect Excalidraw to render diagrams"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Set up Excalidraw in your MCP servers to start drawing.",
			),
		).toBeInTheDocument();
		// The CTA renders as an anchor (Button asChild → Link). Assert
		// label + href so a regression (e.g., the link silently dropping
		// the href) is caught.
		const cta = screen.getByRole("link", { name: "Connect Excalidraw" });
		expect(cta).toHaveAttribute("href", "/app/settings/mcp-servers");
	});

	it('preserves data-testid="connect-excalidraw-card" for the Excalidraw branch', () => {
		// Legacy testid preserved so the existing Playwright scenario in
		// `nexus-excalidraw-routing.spec.ts` stays green without a
		// rewrite during the rollout window.
		render(<DefaultMcpStatusCard payload={CONNECTION_NEEDED_EXCALIDRAW} />);
		expect(
			screen.getByTestId("connect-excalidraw-card"),
		).toBeInTheDocument();
	});

	it("renders the secondary testid scoped by kind + serverKey", () => {
		// `data-testid="default-mcp-status-connection-needed-excalidraw"`
		// is the scoped form new E2E scenarios should target.
		render(<DefaultMcpStatusCard payload={CONNECTION_NEEDED_EXCALIDRAW} />);
		expect(
			screen.getByTestId(
				"default-mcp-status-connection-needed-excalidraw",
			),
		).toBeInTheDocument();
	});

	it('uses the generic data-testid="default-mcp-status-card" for non-Excalidraw connection-needed servers', () => {
		// A future default-enabled server (e.g., Mermaid in connection-needed
		// state) must NOT inherit the legacy excalidraw-specific testid.
		const payload: DefaultMcpStatusCtaPayload = {
			...CONNECTION_NEEDED_EXCALIDRAW,
			serverKey: "mermaid",
			serverName: "Mermaid",
			title: "Connect Mermaid",
		};

		render(<DefaultMcpStatusCard payload={payload} />);

		expect(
			screen.getByTestId("default-mcp-status-card"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-excalidraw-card"),
		).not.toBeInTheDocument();
	});
});

// -----------------------------------------------------------------------
// kind = "service-down"
// -----------------------------------------------------------------------

describe("DefaultMcpStatusCard — service-down", () => {
	it("renders the parameterized title and body from the payload", () => {
		render(<DefaultMcpStatusCard payload={SERVICE_DOWN_EXCALIDRAW} />);

		// Title is parameterized on `payload.serverName`, body is the full
		// `payload.body` string — locked copy.
		expect(
			screen.getByText("Excalidraw is temporarily unavailable"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"We couldn't reach the Excalidraw service to render your diagram. Try again in a moment.",
			),
		).toBeInTheDocument();
	});

	it("does NOT render a primary action button (no inline retry in v1)", () => {
		// The discriminated union forbids `primaryAction` on the
		// service-down branch at the TYPE level. This test locks the
		// runtime behavior: no `<a>` or button slipping into the DOM.
		render(<DefaultMcpStatusCard payload={SERVICE_DOWN_EXCALIDRAW} />);

		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		// The card frame itself is the only rendered button-adjacent
		// element; no "retry" / "try again" CTA.
		expect(
			screen.queryByRole("button", { name: /try again|retry/i }),
		).not.toBeInTheDocument();
	});

	it('uses data-testid="default-mcp-status-card" (not the legacy connect-excalidraw-card)', () => {
		// The legacy testid is ONLY for the Excalidraw connection-needed
		// branch. The service-down branch — even for Excalidraw — gets the
		// generalized testid so new E2E scenarios can target it cleanly.
		render(<DefaultMcpStatusCard payload={SERVICE_DOWN_EXCALIDRAW} />);

		expect(
			screen.getByTestId("default-mcp-status-card"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-excalidraw-card"),
		).not.toBeInTheDocument();
	});

	it("renders the scoped data-testid for the service-down branch", () => {
		render(<DefaultMcpStatusCard payload={SERVICE_DOWN_EXCALIDRAW} />);

		expect(
			screen.getByTestId("default-mcp-status-service-down-excalidraw"),
		).toBeInTheDocument();
	});
});

// -----------------------------------------------------------------------
// isDefaultMcpStatusCta type guard
// -----------------------------------------------------------------------

describe("isDefaultMcpStatusCta", () => {
	it("returns true for a valid connection-needed payload", () => {
		expect(isDefaultMcpStatusCta(CONNECTION_NEEDED_EXCALIDRAW)).toBe(true);
	});

	it("returns true for a valid service-down payload", () => {
		expect(isDefaultMcpStatusCta(SERVICE_DOWN_EXCALIDRAW)).toBe(true);
	});

	it.each([null, undefined, 1, "string", []])(
		"returns false for non-object input (%p)",
		(value) => {
			expect(isDefaultMcpStatusCta(value)).toBe(false);
		},
	);

	it("returns false when type is not 'structured_cta'", () => {
		expect(
			isDefaultMcpStatusCta({
				...CONNECTION_NEEDED_EXCALIDRAW,
				type: "something_else",
			}),
		).toBe(false);
	});

	it("returns false when kind is not one of the accepted variants", () => {
		expect(
			isDefaultMcpStatusCta({
				...CONNECTION_NEEDED_EXCALIDRAW,
				kind: "unknown-kind",
			}),
		).toBe(false);
	});

	it("returns false when a connection-needed payload is missing primaryAction", () => {
		const { primaryAction: _omit, ...rest } = CONNECTION_NEEDED_EXCALIDRAW;
		expect(isDefaultMcpStatusCta(rest)).toBe(false);
	});

	it("returns false when string fields are missing", () => {
		// Drop the `body` field — guard MUST reject.
		const broken = {
			...CONNECTION_NEEDED_EXCALIDRAW,
		} as Record<string, unknown>;
		delete broken.body;
		expect(isDefaultMcpStatusCta(broken)).toBe(false);
	});
});
