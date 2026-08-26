import {
	PromptBindingManager,
	resolveInitialAgentKey,
} from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog used to seed its Agent selector with AGENT_TARGETS[0] no matter
// which prompt opened it, so opening it from an agent-keyed prompt offered to
// bind that prompt to "Project Document Generator" — with the "set as default"
// checkbox already ticked. These tests pin the selection to the prompt's own
// agent key when one matches.

const { getById, bindSet } = vi.hoisted(() => ({
	getById: vi.fn(),
	bindSet: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (input: unknown) => getById(input) },
			bind: { set: (input: unknown) => bindSet(input) },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// The dialog reads the session to decide whether to offer the universal tier.
// A plain user here — these tests are about agent preselection, and the tier
// options are covered by PromptBindingManagerSystemScope.test.tsx.
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

describe("resolveInitialAgentKey", () => {
	it("returns the prompt's own key when it names an agent target", () => {
		expect(resolveInitialAgentKey("meeting_agenda_generator")).toBe(
			"meeting_agenda_generator",
		);
		expect(resolveInitialAgentKey("test_case_drafter")).toBe(
			"test_case_drafter",
		);
	});

	it("falls back to the first target for a prompt that is not agent-keyed", () => {
		// Most library prompts are ordinary user prompts with keys that match no
		// agent; those keep the previous default rather than an empty selector.
		expect(resolveInitialAgentKey("my_scratch_prompt")).toBe(
			"project_document_generator",
		);
	});

	it("falls back to the first target when the key is missing", () => {
		expect(resolveInitialAgentKey(undefined)).toBe(
			"project_document_generator",
		);
		expect(resolveInitialAgentKey("")).toBe("project_document_generator");
	});
});

describe("PromptBindingManager — agent preselection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "HANDLEBARS",
			versions: [{ id: "v1", version: 1, content: "body" }],
		});
	});

	it("preselects the matching agent when opened from an agent-keyed prompt", async () => {
		const user = userEvent.setup();
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptKey="meeting_agenda_generator"
				promptName="Meeting Agenda Generator"
				promptScope="SYSTEM"
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: /set as default/i }),
		);

		expect(
			await screen.findByText("Meeting Agenda Generator", {
				selector: "span",
			}),
		).toBeTruthy();
		expect(screen.queryByText("Project Document Generator")).toBeNull();
	});

	it("keeps the first target for a prompt with no matching agent key", async () => {
		const user = userEvent.setup();
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptKey="my_scratch_prompt"
				promptName="My scratch prompt"
				promptScope="USER"
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: /set as default/i }),
		);

		expect(
			await screen.findByText("Project Document Generator"),
		).toBeTruthy();
	});
});
