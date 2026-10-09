/**
 * A prompt saved without content has no version, and "Set as Default" binds
 * a version, so the button stays disabled. The dialog says why instead of
 * leaving a disabled button with no explanation.
 */

import { PromptBindingManager } from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById } = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (i: unknown) => getById(i) },
			bindings: { set: vi.fn(), setMany: vi.fn() },
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const NO_CONTENT = /this prompt has no content yet/i;

async function openDialog() {
	wrap(
		<PromptBindingManager
			promptId="prompt-1"
			promptName="Draft prompt"
			promptScope="USER"
			promptKey="test_case_drafter"
		/>,
	);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /set as default/i }));
}

describe("PromptBindingManager — a prompt with no version", () => {
	beforeEach(() => {
		getById.mockReset();
	});

	it("says the prompt needs content before it can be a default", async () => {
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "PLAIN_TEXT",
			versions: [],
		});
		await openDialog();

		expect(await screen.findByText(NO_CONTENT)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^set as default$/i }),
		).toBeDisabled();
	});

	it("says nothing of the kind for a prompt that has a version", async () => {
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "PLAIN_TEXT",
			versions: [{ id: "pv-1", version: 1, content: "body" }],
		});
		await openDialog();

		await screen.findByRole("combobox", { name: /document type/i });
		expect(screen.queryByText(NO_CONTENT)).not.toBeInTheDocument();
	});
});
