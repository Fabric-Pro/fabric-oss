import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	params: new URLSearchParams(),
	role: "admin",
	get: vi.fn(),
	list: vi.fn(),
	create: vi.fn(),
	push: vi.fn(),
	editor: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: m.push }),
	useSearchParams: () => m.params,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/example-org",
		userRole: m.role,
		loaded: true,
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { prompts: { create: m.create } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			get: {
				byId: {
					queryOptions: ({ input }: any) => ({
						queryKey: ["prompt", input.id, input.organizationId],
						queryFn: () => m.get(input),
					}),
				},
			},
			list: {
				queryOptions: ({ input }: any) => ({
					queryKey: ["prompts", input],
					queryFn: () => m.list(input),
				}),
			},
		},
	},
}));
vi.mock("@saas/prompts/components/PromptEditor", () => ({
	PromptEditor: (props: any) => {
		m.editor(props);
		return (
			<div>
				<output>{JSON.stringify(props.initialData)}</output>
				{props.error && <p role="alert">{props.error}</p>}
				<button
					type="button"
					onClick={() =>
						props.onSave({
							...props.initialData,
							name: "Reviewed name",
							content: "Reviewed content",
						})
					}
				>
					Create reviewed prompt
				</button>
			</div>
		);
	},
}));

import { PromptCreator } from "@saas/prompts/components/PromptCreator";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: {
						queries: { retry: false },
						mutations: { retry: false },
					},
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	m.params = new URLSearchParams();
	m.role = "admin";
	m.get.mockResolvedValue({
		id: "example-source",
		name: "Source",
		scope: "SYSTEM",
		format: "MUSTACHE",
		tags: ["example"],
		versions: [{ content: "Actual source {{topic}}" }],
	});
	m.list.mockResolvedValue({
		prompts: [{ id: "example-source", name: "Source" }],
		total: 1,
	});
	m.create.mockResolvedValue({ prompt: { id: "example-new" } });
});
it("loads duplicate source before opening the editor and creates a distinct org prompt without bindings", async () => {
	m.params = new URLSearchParams("duplicateFrom=example-source");
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	await screen.findByText(/Actual source/);
	expect(m.editor.mock.lastCall?.[0].initialData).toMatchObject({
		name: "Source (copy)",
		scope: "ORG",
		format: "MUSTACHE",
		isPublic: false,
		content: "Actual source {{topic}}",
	});
	expect(m.create).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: "Create reviewed prompt" }),
	);
	await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
	expect(m.create.mock.calls[0][0]).toMatchObject({
		organizationId: "example-org",
		scope: "ORG",
		initialContent: "Reviewed content",
		format: "MUSTACHE",
	});
	expect(m.create.mock.calls[0][0]).not.toHaveProperty("bindings");
});
it("does not silently open a blank editor after a denied source load", async () => {
	m.params = new URLSearchParams("duplicateFrom=example-source");
	m.get.mockRejectedValue(
		Object.assign(Error("Not found"), { code: "NOT_FOUND" }),
	);
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	await screen.findByText(/Could not load this source prompt/);
	expect(m.editor).not.toHaveBeenCalled();
	expect(m.create).not.toHaveBeenCalled();
});
it("from existing chooses an accessible source before editing", async () => {
	m.params = new URLSearchParams("mode=existing");
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	fireEvent.click(await screen.findByRole("button", { name: "Source" }));
	await screen.findByText(/Actual source/);
	expect(m.get).toHaveBeenCalledWith({
		id: "example-source",
		organizationId: "example-org",
	});
});
it("keeps a failed draft and prevents automatic retry after an ambiguous creation response", async () => {
	m.create.mockRejectedValue(Error("network lost"));
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	fireEvent.click(
		screen.getByRole("button", { name: "Create reviewed prompt" }),
	);
	await screen.findByText("Check whether your prompt was created");
	expect(m.create).toHaveBeenCalledTimes(1);
	fireEvent.click(
		screen.getByRole("button", { name: "I checked — return to my draft" }),
	);
	expect(m.editor.mock.lastCall?.[0].initialData).toMatchObject({
		name: "Reviewed name",
		content: "Reviewed content",
	});
});
it("shows a current permission refusal without treating it as an uncertain mutation", async () => {
	m.create.mockRejectedValue(
		Object.assign(Error("Denied"), { code: "FORBIDDEN" }),
	);
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	fireEvent.click(
		screen.getByRole("button", { name: "Create reviewed prompt" }),
	);
	await screen.findByRole("alert");
	expect(
		screen.queryByText("Check whether your prompt was created"),
	).not.toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent(
		"owners and administrators",
	);
	expect(m.create).toHaveBeenCalledTimes(1);
});

it("explains organization creation authority before opening an editor or spending", async () => {
	m.role = "member";
	m.params = new URLSearchParams("mode=conversation");
	render(<PromptCreator organizationId="example-org" />, { wrapper });
	await screen.findByText(/Ask an administrator to create one/);
	expect(m.editor).not.toHaveBeenCalled();
	expect(m.get).not.toHaveBeenCalled();
	expect(m.create).not.toHaveBeenCalled();
});
