vi.unmock("next-intl");

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@ui/components/tooltip";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { AnsweredByModel } from "../AnsweredByModel";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "example-org",
}));
const fetchModels = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { aiConfig: { models: { listAvailable: fetchModels } } },
}));
function show(
	model?: {
		id: string;
		canonicalName?: string;
		provider?: string;
		viaPlan?: boolean;
	},
	emptyCache = false,
	client = new QueryClient(),
) {
	if (!emptyCache) {
		client.setQueryData(
			["ai-models-available", "example-org", "compose-picker"],
			{
				models: [
					{
						id: "example-served",
						canonicalName: "example-served",
						displayName: "Example Served",
					},
					{
						id: "example-picked",
						canonicalName: "example-picked",
						displayName: "Example Picked",
					},
				],
			},
		);
	}
	return render(
		<QueryClientProvider client={client}>
			<NextIntlClientProvider
				locale="en"
				messages={{
					tooltips: {
						agents: { answeredByModel: "Answered by {model}" },
					},
				}}
			>
				<TooltipProvider delayDuration={0}>
					<AnsweredByModel model={model} />
				</TooltipProvider>
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
}
describe("AnsweredByModel", () => {
	it("labels the served model rather than another picker option and exposes provider on keyboard focus", async () => {
		show({
			id: "example-served",
			provider: "ANTHROPIC_DIRECT",
			viaPlan: false,
		});
		const label = screen.getByRole("button", {
			name: "Answered by Example Served",
		});
		fireEvent.focus(label);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"Example Served · Anthropic",
		);
		expect(screen.queryByText("Answered by Example Picked")).toBeNull();
	});
	it("shows ChatGPT plan and strips vendor prefixes for unknown models", async () => {
		show({
			id: "vendor/example-unknown",
			provider: "OPENAI_DIRECT",
			viaPlan: true,
		});
		fireEvent.focus(
			screen.getByRole("button", { name: "Answered by example-unknown" }),
		);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"example-unknown · ChatGPT plan",
		);
	});
	it("fetches the display name with an empty cache and shares fresh data across labels", async () => {
		fetchModels.mockClear();
		fetchModels.mockResolvedValue({
			models: [
				{
					id: "example-dated-id",
					canonicalName: "example-canonical",
					displayName: "Example Catalog Name",
				},
			],
		});
		const client = new QueryClient();
		const model = {
			id: "example-dated-id",
			canonicalName: "example-canonical",
			viaPlan: false,
		};
		const view = show(model, true, client);
		expect(
			await screen.findByRole("button", {
				name: "Answered by Example Catalog Name",
			}),
		).toBeInTheDocument();
		show(model, true, client);
		expect(
			screen.getAllByRole("button", {
				name: "Answered by Example Catalog Name",
			}),
		).toHaveLength(2);
		expect(fetchModels).toHaveBeenCalledTimes(1);
		view.unmount();
	});
	it("prefers canonical names when the catalog has no matching entry", () => {
		show({
			id: "vendor/example-dated-id",
			canonicalName: "vendor/example-canonical",
			viaPlan: false,
		});
		expect(
			screen.getByRole("button", {
				name: "Answered by example-canonical",
			}),
		).toBeInTheDocument();
	});
	it("renders nothing for a legacy first-resolved model without provenance", () => {
		expect(
			show({
				id: "example-served",
				canonicalName: "example-served",
				provider: "OPENAI_CHATGPT_PLAN",
			}).container.textContent,
		).toBe("");
	});

	it("renders no label for old answers without model data", () => {
		expect(show().container.textContent).toBe("");
	});
});
