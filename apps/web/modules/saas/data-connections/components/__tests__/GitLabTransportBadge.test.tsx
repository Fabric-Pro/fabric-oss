import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitLabTransportBadge } from "../GitLabTransportBadge";

describe("GitLabTransportBadge", () => {
	it("renders 'Connected via official MCP' for kind=official-mcp", () => {
		render(
			<GitLabTransportBadge
				transport={{
					kind: "official-mcp",
					checkedAt: new Date().toISOString(),
				}}
				onRecheck={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/connected via official mcp/i),
		).toBeInTheDocument();
	});

	it("renders 'Connected via REST' for kind=rest", () => {
		render(
			<GitLabTransportBadge
				transport={{
					kind: "rest",
					checkedAt: new Date().toISOString(),
				}}
				onRecheck={vi.fn()}
			/>,
		);
		expect(screen.getByText(/connected via rest/i)).toBeInTheDocument();
	});

	it("renders 'Connection mode unknown' for kind=unknown (legacy rows)", () => {
		render(
			<GitLabTransportBadge
				transport={{ kind: "unknown" }}
				onRecheck={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/connection mode unknown/i),
		).toBeInTheDocument();
	});

	it("renders 'Reconnect required' for kind=reauth-required", () => {
		render(
			<GitLabTransportBadge
				transport={{
					kind: "reauth-required",
					checkedAt: new Date().toISOString(),
				}}
				onRecheck={vi.fn()}
			/>,
		);
		expect(screen.getByText(/reconnect required/i)).toBeInTheDocument();
		// Stale "Connected via …" copy must NOT bleed through when the
		// stored token is known to be invalid — the badge is the canonical
		// status signal on the provider hero, so any "Connected" wording
		// here would directly contradict the toast / inline alert that
		// fires on recheck-401.
		expect(screen.queryByText(/connected via/i)).not.toBeInTheDocument();
	});

	it("calls onRecheck when Re-check button is clicked", async () => {
		const onRecheck = vi.fn();
		render(
			<GitLabTransportBadge
				transport={{
					kind: "rest",
					checkedAt: new Date().toISOString(),
				}}
				onRecheck={onRecheck}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: /re-check gitlab capabilities/i,
			}),
		);
		expect(onRecheck).toHaveBeenCalledOnce();
	});
});
