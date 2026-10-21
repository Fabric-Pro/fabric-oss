import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		dataConnections: {
			request: (...args: unknown[]) => requestMock(...args),
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

import { toast } from "sonner";
import { RequestConnectionDialog } from "../RequestConnectionDialog";

function renderWithClient(ui: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

// jsdom can't navigate, so capture the mailto the dialog assigns.
let assignedHref: string | null = null;
Object.defineProperty(window, "location", {
	configurable: true,
	value: {
		...window.location,
		set href(value: string) {
			assignedHref = value;
		},
		get href() {
			return assignedHref ?? "http://localhost/";
		},
	},
});

describe("RequestConnectionDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		assignedHref = null;
	});

	it("renders trigger button and opens dialog", async () => {
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		const trigger = screen.getByRole("button", {
			name: /request connection/i,
		});
		expect(trigger).toBeInTheDocument();

		await user.click(trigger);

		expect(
			screen.getByRole("heading", { name: /request a connection/i }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/tell us which integration or mcp server you need/i,
			),
		).toBeInTheDocument();
	});

	it("keeps Open email draft disabled until both a type and a name are set", async () => {
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		await user.click(
			screen.getByRole("button", { name: /request connection/i }),
		);

		const submitButton = screen.getByRole("button", {
			name: /open email draft/i,
		});
		expect(submitButton).toBeDisabled();

		// Set name only -> still disabled
		const nameInput = screen.getByLabelText(
			/integration or mcp server name/i,
		);
		await user.type(nameInput, "Postgres MCP");
		expect(submitButton).toBeDisabled();

		// Open select and pick Type
		const typeSelect = screen.getByLabelText(/type/i);
		await user.click(typeSelect);
		const mcpOption = await screen.findByRole("option", { name: "MCP" });
		await user.click(mcpOption);

		// Now enabled
		expect(submitButton).toBeEnabled();

		// Clear name -> disabled again
		await user.clear(nameInput);
		expect(submitButton).toBeDisabled();
	});

	it("calls dataConnections.request with trimmed values and organizationId on submission", async () => {
		requestMock.mockResolvedValueOnce({
			mailto: "mailto:support@example.com",
		});
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		await user.click(
			screen.getByRole("button", { name: /request connection/i }),
		);

		// Select type
		await user.click(screen.getByLabelText(/type/i));
		await user.click(
			await screen.findByRole("option", { name: "Integrations" }),
		);

		// Fill name with whitespace
		await user.type(
			screen.getByLabelText(/integration or mcp server name/i),
			"   Linear Integration   ",
		);

		// Fill notes with whitespace
		await user.type(
			screen.getByLabelText(/notes/i),
			"   Sync issues directly   ",
		);

		const submitButton = screen.getByRole("button", {
			name: /open email draft/i,
		});
		await user.click(submitButton);

		await waitFor(() => {
			expect(requestMock).toHaveBeenCalledWith({
				type: "integration",
				name: "Linear Integration",
				notes: "Sync issues directly",
				organizationId: "org-1",
			});
		});
	});

	it("closes dialog and shows success toast on successful submission", async () => {
		const MAILTO = "mailto:support@example.com?subject=Test";
		requestMock.mockResolvedValueOnce({ mailto: MAILTO });
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		await user.click(
			screen.getByRole("button", { name: /request connection/i }),
		);

		await user.click(screen.getByLabelText(/type/i));
		await user.click(
			await screen.findByRole("option", { name: "Not sure" }),
		);
		await user.type(
			screen.getByLabelText(/integration or mcp server name/i),
			"Custom Tool",
		);

		await user.click(
			screen.getByRole("button", { name: /open email draft/i }),
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("heading", {
					name: /request a connection/i,
				}),
			).not.toBeInTheDocument();
		});

		expect(assignedHref).toBe(MAILTO);
		expect(toast.success).toHaveBeenCalledWith("Opening your email app", {
			description: "Your request is ready to send.",
		});
	});

	it("closes dialog and shows info toast when mailto is null", async () => {
		requestMock.mockResolvedValueOnce({ mailto: null });
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		await user.click(
			screen.getByRole("button", { name: /request connection/i }),
		);

		await user.click(screen.getByLabelText(/type/i));
		await user.click(
			await screen.findByRole("option", { name: "Not sure" }),
		);
		await user.type(
			screen.getByLabelText(/integration or mcp server name/i),
			"Custom Tool",
		);

		await user.click(
			screen.getByRole("button", { name: /open email draft/i }),
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("heading", {
					name: /request a connection/i,
				}),
			).not.toBeInTheDocument();
		});

		expect(toast.info).toHaveBeenCalledWith(
			"Connection requests aren't set up on this Fabric deployment.",
		);
		expect(assignedHref).toBeNull();
	});

	it("keeps dialog open with typed values and shows error toast on failure", async () => {
		requestMock.mockRejectedValueOnce(new Error("Network failure"));
		const user = userEvent.setup();
		renderWithClient(<RequestConnectionDialog />);

		await user.click(
			screen.getByRole("button", { name: /request connection/i }),
		);

		await user.click(screen.getByLabelText(/type/i));
		await user.click(await screen.findByRole("option", { name: "MCP" }));
		await user.type(
			screen.getByLabelText(/integration or mcp server name/i),
			"S3 MCP Server",
		);
		await user.type(screen.getByLabelText(/notes/i), "Bucket browser");

		await user.click(
			screen.getByRole("button", { name: /open email draft/i }),
		);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"We couldn't prepare your request. Please try again.",
			);
		});

		// Dialog remains open
		expect(
			screen.getByRole("heading", { name: /request a connection/i }),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText(/integration or mcp server name/i),
		).toHaveValue("S3 MCP Server");
		expect(screen.getByLabelText(/notes/i)).toHaveValue("Bucket browser");
	});
});
