import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => vi.importActual("next-intl"));
const api = vi.hoisted(() => ({
	impact: vi.fn(),
	preview: vi.fn(),
	apply: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			embeddings: { changeImpact: api.impact },
			providers: {
				previewSetDefault: api.preview,
				setDefault: api.apply,
			},
		},
	},
}));

import { DefaultApiProviderSwitchDialog } from "../DefaultApiProviderPanel";

const model = (name: string) => ({
	id: name,
	canonicalName: name,
	displayName: name,
});
const plan = {
	currentProvider: "OPENAI_DIRECT",
	targetProvider: "VERCEL_GATEWAY",
	validProviders: [
		{ provider: "OPENAI_DIRECT" },
		{ provider: "VERCEL_GATEWAY" },
	],
	savedTextChoiceCount: 3,
	preservesEmbedding: false,
	documentsProvider: null,
	embeddingsModelChanged: false,
	removedPreferences: [],
	keptPreferences: [
		{
			id: "example-kept",
			taskType: "IMAGE",
			provider: "VERCEL_GATEWAY",
			modelId: "example-image",
		},
	],
	textTasks: [
		{
			taskType: "CHAT",
			currentModel: model("Server current"),
			targetModel: model("Server target"),
		},
		{ taskType: "EVAL", currentModel: null, targetModel: null },
	],
};
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<NextIntlClientProvider locale="en" messages={en}>
				<DefaultApiProviderSwitchDialog
					organizationId="example-org"
					currentProvider="OPENAI_DIRECT"
					configuredProviders={[
						{ provider: "OPENAI_DIRECT" },
						{ provider: "VERCEL_GATEWAY" },
						{ provider: "GROQ" },
					]}
					initialProvider="VERCEL_GATEWAY"
					open
					onOpenChange={() => {}}
				/>
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
	return { invalidate };
}
beforeEach(() => {
	vi.clearAllMocks();
	api.impact.mockResolvedValue({
		companyContext: { indexedWithCurrentModel: 2, total: 5 },
		projectContent: { indexed: 7 },
	});
	api.preview.mockResolvedValue(plan);
	api.apply.mockResolvedValue({ success: true, preferencesCleared: 3 });
});

// Restoring the old documents-flag inference would require an acknowledgement
// even though the server resolved the same embedding model on both providers.
it("renders only the server's models, removals and keeps without an unnecessary re-index acknowledgement", async () => {
	const { invalidate } = mount();
	const row = await screen.findByTestId("provider-switch-task-CHAT");
	expect(row).toHaveAccessibleName(
		"Chat: Server current, then Server target (default)",
	);
	expect(screen.getByTestId("provider-switch-task-EVAL")).toHaveTextContent(
		"No default model",
	);
	expect(screen.getByRole("alertdialog")).toHaveTextContent(
		"Your 3 saved choices for text tasks will be removed.",
	);
	expect(screen.getByRole("alertdialog")).toHaveTextContent(
		"Saved choices that will be kept:",
	);
	expect(screen.queryByRole("checkbox")).toBeNull();
	const confirm = screen.getByRole("button", { name: "Make default" });
	await waitFor(() => expect(confirm).not.toBeDisabled());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(api.apply).toHaveBeenCalledWith({
			organizationId: "example-org",
			provider: "VERCEL_GATEWAY",
		}),
	);
	for (const key of [
		"aiConfigStatus",
		"aiAvailableModels",
		"aiTaskDefaults",
		"aiOrgPreferences",
	]) {
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: [key, "example-org"],
		});
	}
});
it("requires typed confirmation only when the server says the embeddings model changes", async () => {
	api.preview.mockResolvedValue({
		...plan,
		embeddingsModelChanged: true,
		preservesEmbedding: true,
		documentsProvider: "OPENAI_DIRECT",
	});
	mount();
	const input = await screen.findByRole("textbox", {
		name: "Confirmation word",
	});
	const confirm = screen.getByRole("button", { name: "Make default" });
	expect(confirm).toBeDisabled();
	fireEvent.change(input, { target: { value: " reindex " } });
	await waitFor(() => expect(confirm).not.toBeDisabled());
	fireEvent.click(confirm);
	await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
});
it("offers only server-validated providers", async () => {
	mount();
	const select = screen.getByRole("combobox");
	await waitFor(() => expect(select).not.toBeDisabled());
	fireEvent.click(select);
	expect(
		await screen.findByRole("option", { name: "Vercel AI Gateway" }),
	).toBeInTheDocument();
	expect(screen.queryByRole("option", { name: /Groq/i })).toBeNull();
});
it("blocks apply when the preview fails", async () => {
	api.preview.mockRejectedValue(new Error("example-preview-failed"));
	mount();
	expect(
		await within(screen.getByRole("alertdialog")).findByRole("alert"),
	).toHaveTextContent("example-preview-failed");
	expect(screen.getByRole("button", { name: "Make default" })).toBeDisabled();
	expect(api.apply).not.toHaveBeenCalled();
});

it("shows the server refusal and allows recovery by selecting another valid provider", async () => {
	api.preview.mockImplementation(
		async ({ provider }: { provider?: string }) => {
			if (provider === "VERCEL_GATEWAY") {
				throw new Error("Example target no longer has credentials");
			}
			return {
				...plan,
				targetProvider: provider ?? null,
				currentProvider: "ANTHROPIC_DIRECT",
			};
		},
	);
	mount();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Example target no longer has credentials",
	);
	const select = screen.getByRole("combobox");
	expect(select).not.toBeDisabled();
	fireEvent.click(select);
	fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
	const confirm = screen.getByRole("button", { name: "Make default" });
	await waitFor(() => expect(confirm).not.toBeDisabled());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(api.apply).toHaveBeenCalledWith({
			organizationId: "example-org",
			provider: "OPENAI_DIRECT",
		}),
	);
});
it("labels a kept EMBEDDING choice without a missing translation key", async () => {
	api.preview.mockResolvedValue({
		...plan,
		keptPreferences: [
			{
				id: "example-embedding",
				taskType: "EMBEDDING",
				provider: "OPENAI_DIRECT",
				modelId: "example-model",
			},
		],
	});
	mount();
	expect(
		await screen.findByText("Embeddings", { selector: "li" }),
	).toBeInTheDocument();
	expect(screen.getByRole("alertdialog")).not.toHaveTextContent(
		"tasks.EMBEDDING.name",
	);
});
it("hides the kept-choices heading when no saved choices are kept", async () => {
	api.preview.mockResolvedValue({ ...plan, keptPreferences: [] });
	mount();
	await screen.findByTestId("provider-switch-task-CHAT");
	expect(screen.queryByText("Saved choices that will be kept:")).toBeNull();
});

it("shows the outgoing provider pin without an embeddings acknowledgement", async () => {
	api.preview.mockResolvedValue({
		...plan,
		preservesEmbedding: true,
		documentsProvider: "OPENAI_DIRECT",
		embeddingsModelChanged: false,
	});
	mount();
	const dialog = await screen.findByRole("alertdialog");
	await waitFor(() =>
		expect(dialog).toHaveTextContent("Embeddings stay on OpenAI"),
	);
	expect(within(dialog).queryByRole("checkbox")).toBeNull();
	const confirm = within(dialog).getByRole("button", {
		name: "Make default",
	});
	await waitFor(() => expect(confirm).not.toBeDisabled());
	fireEvent.click(confirm);
	await waitFor(() =>
		expect(api.apply).toHaveBeenCalledWith({
			organizationId: "example-org",
			provider: "VERCEL_GATEWAY",
		}),
	);
});

it("skips typed confirmation inside the default-switch dialog when both indexed counts are zero", async () => {
	api.preview.mockResolvedValue({ ...plan, embeddingsModelChanged: true });
	api.impact.mockResolvedValue({
		companyContext: { indexedWithCurrentModel: 0, total: 0 },
		projectContent: { indexed: 0 },
	});
	mount();
	const confirm = screen.getByRole("button", { name: "Make default" });
	await waitFor(() => expect(confirm).not.toBeDisabled());
	expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
	expect(screen.queryByRole("textbox")).toBeNull();
	fireEvent.click(confirm);
	await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
});

it("waits for impact counts before allowing a default switch that changes embeddings", async () => {
	api.preview.mockResolvedValue({ ...plan, embeddingsModelChanged: true });
	let resolve!: (value: unknown) => void;
	api.impact.mockReturnValue(
		new Promise((done) => {
			resolve = done;
		}),
	);
	mount();
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Checking indexed content",
	);
	const confirm = screen.getByRole("button", { name: "Make default" });
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "REINDEX" },
	});
	expect(confirm).toBeDisabled();
	expect(api.apply).not.toHaveBeenCalled();
	resolve({
		companyContext: { indexedWithCurrentModel: 2, total: 5 },
		projectContent: { indexed: 7 },
	});
	await waitFor(() => expect(confirm).not.toBeDisabled());
});
it("permits a typed default switch when the impact read fails without reporting zero", async () => {
	api.preview.mockResolvedValue({ ...plan, embeddingsModelChanged: true });
	api.impact.mockRejectedValue(new Error("Example count unavailable"));
	mount();
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"count is unavailable",
	);
	const confirm = screen.getByRole("button", { name: "Make default" });
	expect(confirm).toBeDisabled();
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "REINDEX" },
	});
	fireEvent.click(confirm);
	await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
});
