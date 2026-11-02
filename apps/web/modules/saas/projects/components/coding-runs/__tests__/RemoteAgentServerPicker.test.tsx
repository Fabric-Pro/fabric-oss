import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RemoteAgentServerPicker } from "../RemoteAgentServerPicker";

it.each([true, false])(
	"offers the deployment server only when configured: %s",
	(configured) => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<RemoteAgentServerPicker
					projectId="example-project"
					servers={[]}
					canShare={false}
					hasDefaultServer={configured}
					value=""
					onChange={vi.fn()}
				/>
			</QueryClientProvider>,
		);
		expect(
			Boolean(
				screen.queryByRole("option", { name: "Deployment server" }),
			),
		).toBe(configured);
	},
);
