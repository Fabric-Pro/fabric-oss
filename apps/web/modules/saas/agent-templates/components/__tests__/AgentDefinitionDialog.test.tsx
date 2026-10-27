import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	preview: vi.fn(),
	import: vi.fn(),
	export: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agentTemplates: { instances: { definition: mocks } } },
}));

import {
	AgentDefinitionExportDialog,
	AgentDefinitionImportDialog,
} from "../AgentDefinitionDialog";

const preview = {
	definition: {
		name: "Example agent",
		description: "Research documents",
		skills: [],
		model: {},
		requirements: [{ kind: "mcp", name: "Example tools" }],
	},
	notices: ["Imports create a draft with no connected tools."],
};
function mount(child: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{child}</QueryClientProvider>,
	);
}
async function showPreview() {
	fireEvent.click(screen.getByRole("button", { name: "Import agent" }));
	fireEvent.change(screen.getByLabelText("Or paste JSON or YAML"), {
		target: { value: "name: example" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Preview definition" }));
	await screen.findByRole("region", { name: "Import preview" });
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.preview.mockResolvedValue(preview);
	mocks.import.mockResolvedValue({ instance: { id: "example-instance" } });
	mocks.export.mockResolvedValue({
		document: "name: example",
		filename: "agent.yaml",
	});
});
afterEach(() => vi.restoreAllMocks());

describe("agent definition dialogs", () => {
	it("requires preview, displays unresolved resources and imports into the chosen organization", async () => {
		const onImported = vi.fn();
		mount(
			<AgentDefinitionImportDialog
				organizationId="example-org"
				onImported={onImported}
			/>,
		);
		await showPreview();
		expect(screen.getByText("Example tools (mcp)")).toBeDefined();
		expect(mocks.import).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
		await waitFor(() =>
			expect(onImported).toHaveBeenCalledWith("example-instance"),
		);
		expect(mocks.import).toHaveBeenCalledWith({
			organizationId: "example-org",
			document: "name: example",
		});
	});
	it("invalidates preview when the document changes", async () => {
		mount(
			<AgentDefinitionImportDialog
				organizationId="example-org"
				onImported={vi.fn()}
			/>,
		);
		await showPreview();
		fireEvent.change(screen.getByLabelText("Or paste JSON or YAML"), {
			target: { value: "name: different" },
		});
		expect(
			screen.queryByRole("button", { name: "Create draft" }),
		).toBeNull();
	});
	it("does not dispatch duplicate import clicks", async () => {
		mocks.import.mockImplementation(() => new Promise(() => {}));
		mount(
			<AgentDefinitionImportDialog
				organizationId="example-org"
				onImported={vi.fn()}
			/>,
		);
		await showPreview();
		const button = screen.getByRole("button", { name: "Create draft" });
		fireEvent.click(button);
		fireEvent.click(button);
		await waitFor(() => expect(mocks.import).toHaveBeenCalledTimes(1));
	});
	it("exposes a safe preview error without echoing server content", async () => {
		mocks.preview.mockRejectedValue(new Error("example-secret"));
		mount(
			<AgentDefinitionImportDialog
				organizationId="example-org"
				onImported={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Import agent" }));
		fireEvent.change(screen.getByLabelText("Or paste JSON or YAML"), {
			target: { value: "bad" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Preview definition" }),
		);
		expect((await screen.findByRole("alert")).textContent).not.toContain(
			"example-secret",
		);
		expect(mocks.import).not.toHaveBeenCalled();
	});
	it("blocks retry after an unconfirmed import and offers recovery guidance", async () => {
		mocks.import.mockRejectedValue(new Error("Network interrupted"));
		mount(
			<AgentDefinitionImportDialog
				organizationId="example-org"
				onImported={vi.fn()}
			/>,
		);
		await showPreview();
		fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Check your agent list",
		);
		expect(
			screen
				.getByRole("button", { name: "Create draft" })
				.hasAttribute("disabled"),
		).toBe(true);
	});
	it("downloads the selected format through an authorized export", async () => {
		const createObjectURL = vi.fn(() => "blob:example");
		vi.stubGlobal(
			"URL",
			Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }),
		);
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		mount(
			<AgentDefinitionExportDialog
				organizationId="example-org"
				instanceId="example-instance"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Export agent" }));
		fireEvent.change(screen.getByLabelText("File format"), {
			target: { value: "json" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Download definition" }),
		);
		await screen.findByRole("status");
		expect(mocks.export).toHaveBeenCalledWith({
			organizationId: "example-org",
			id: "example-instance",
			format: "json",
		});
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
	});
});
