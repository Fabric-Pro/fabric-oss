import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		scroll,
	}: {
		children: React.ReactNode;
		href: string;
		scroll?: boolean;
	}) => (
		<a
			href={href}
			data-scroll={scroll !== undefined ? String(scroll) : undefined}
		>
			{children}
		</a>
	),
}));

import { IntegrationTile, ProviderCard } from "../ProviderCard";

describe("ProviderCard and IntegrationTile — scroll preservation", () => {
	it("does not set scroll={false} on ProviderCard so standard page navigation scrolls to top", () => {
		render(
			<ProviderCard
				provider="GITHUB"
				href="/settings/integrations/providers/github"
				hasSearchConnection={false}
			/>,
		);

		expect(screen.getByRole("link")).not.toHaveAttribute("data-scroll");
	});

	it("passes scroll={false} to Link when explicitly provided on IntegrationTile (used for MCP tiles)", () => {
		render(
			<IntegrationTile
				href="/app/example-org/connections?tab=mcp&server=PostgreSQL"
				icon={<span data-testid="icon" />}
				name="PostgreSQL"
				description="Postgres database"
				connected={false}
				scroll={false}
			/>,
		);

		expect(screen.getByRole("link")).toHaveAttribute(
			"data-scroll",
			"false",
		);
	});
});
