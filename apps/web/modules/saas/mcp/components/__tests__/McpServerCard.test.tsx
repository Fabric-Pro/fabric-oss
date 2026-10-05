import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

import { McpServerCard } from "../McpServerCard";

function server(key: string, authMethods: string[]) {
	return {
		id: `srv-${key}`,
		key,
		name: `Server ${key}`,
		authMethods,
		transport: "HTTP",
	};
}

// A GitLab personal server connects through the person's GitLab connection,
// which is OAuth: its badge must not advertise an API key the connection
// never reads, whatever the registry row lists.
describe("McpServerCard auth badge", () => {
	it.each(["gitlab", "gitlab-official"])(
		"shows OAuth for %s even when the registry advertises only API_KEY",
		(key) => {
			render(<McpServerCard server={server(key, ["API_KEY"])} />);

			expect(screen.getByText("OAuth")).toBeInTheDocument();
			expect(screen.queryByText("API Key")).not.toBeInTheDocument();
		},
	);

	it("shows OAuth for a GitLab server whose registry row lists no method", () => {
		render(<McpServerCard server={server("gitlab", [])} />);

		expect(screen.getByText("OAuth")).toBeInTheDocument();
		expect(screen.queryByText("Public")).not.toBeInTheDocument();
	});

	it("keeps the registry's auth method for any other server", () => {
		render(
			<McpServerCard server={server("example-server", ["API_KEY"])} />,
		);

		expect(screen.getByText("API Key")).toBeInTheDocument();
	});
});
