import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	role: "owner",
	scope: "SYSTEM",
	fork: vi.fn(),
	push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
		userRole: m.role,
	}),
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			get: {
				byId: {
					queryOptions: () => ({
						queryKey: ["source", m.scope],
						queryFn: async () => ({
							id: "example-source",
							name: "Example source",
							scope: m.scope,
							format: "PLAIN_TEXT",
							tags: [],
							versions: [
								{
									id: "example-version",
									content: "Read supplied notes.",
								},
							],
						}),
					}),
				},
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: { fork: { fork: m.fork }, version: { create: vi.fn() } },
	},
}));

import { PromptPreviewSheet } from "@saas/prompts/components/PromptPreviewSheet";

const mount = () =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="example-source"
				fullPageEdit
			/>
		</QueryClientProvider>,
	);
beforeEach(() => {
	vi.clearAllMocks();
	m.role = "owner";
	m.scope = "SYSTEM";
	m.fork.mockResolvedValue({
		id: "example-fork",
		forkedFromId: "example-source",
	});
});
it("uses the provenance-preserving native fork before opening its focused editor", async () => {
	mount();
	fireEvent.click(
		await screen.findByRole("button", { name: "Fork & Edit", exact: true }),
	);
	await waitFor(() =>
		expect(m.fork).toHaveBeenCalledWith({
			sourcePromptId: "example-source",
			targetScope: "ORG",
			organizationId: "example-org",
		}),
	);
	await waitFor(() =>
		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/prompts/example-fork?edit=1",
		),
	);
});
it.each(["ORG", "SYSTEM"])(
	"offers inspection instead of an unauthorized %s write",
	async (scope) => {
		m.role = "member";
		m.scope = scope;
		mount();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "View details",
				exact: true,
			}),
		);
		expect(m.fork).not.toHaveBeenCalled();
		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/prompts/example-source",
		);
	},
);
