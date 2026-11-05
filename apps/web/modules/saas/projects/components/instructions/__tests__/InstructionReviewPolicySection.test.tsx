/**
 * The upload-mode review policy in Settings: it is seeded from the saved
 * policy, saved on its own (never with the ignore rules), and refuses to save
 * a restricted list shorter than the approvals it requires, plus one above a
 * single approval (a listed approver cannot approve their own proposal).
 *
 * `next-intl` is left on the shared echoing mock (`vitest.setup.ts`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const m = vi.hoisted(() => ({
	policy: {
		requiredApprovals: 1,
		approverUserIds: null as string[] | null,
	},
	updateCalls: [] as Array<Record<string, unknown>>,
	membersCalls: 0,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["members", o.input],
						queryFn: async () => {
							m.membersCalls++;
							return {
								members: [
									{
										userId: "lead_1",
										user: { name: "Lead One", email: null },
									},
									{
										userId: "lead_2",
										user: {
											name: null,
											email: "lead2@example.com",
										},
									},
								],
							};
						},
					}),
				},
			},
			instructions: {
				getSettings: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getSettings", o.input],
						queryFn: async () => ({
							ignoreGlobs: null,
							defaultIgnoreGlobs: [],
							sourceOfTruth: null,
							reviewPolicy: m.policy,
						}),
					}),
				},
				updateSettings: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: async (input: Record<string, unknown>) => {
							m.updateCalls.push(input);
							return { ok: true };
						},
						...opts,
					}),
				},
			},
		},
	},
}));

import { InstructionReviewPolicySection } from "../InstructionReviewPolicySection";

function Wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderSection(canEdit = true) {
	return render(
		<InstructionReviewPolicySection projectId="p" open canEdit={canEdit} />,
		{ wrapper: Wrapper },
	);
}

beforeEach(() => {
	m.policy = { requiredApprovals: 1, approverUserIds: null };
	m.updateCalls.length = 0;
	m.membersCalls = 0;
});

describe("InstructionReviewPolicySection", () => {
	it("saves only the review policy, with no approver list while unrestricted", async () => {
		renderSection();
		const required = await screen.findByLabelText("requiredLabel");
		// Editable once the saved policy has seeded the form.
		await waitFor(() => expect(required).not.toHaveAttribute("readonly"));

		// A controlled number input clamps every keystroke; set the value whole.
		fireEvent.change(required, { target: { value: "2" } });
		await userEvent.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(m.updateCalls).toHaveLength(1));
		expect(m.updateCalls[0]).toEqual({
			projectId: "p",
			reviewPolicy: { requiredApprovals: 2 },
		});
		expect(screen.getByText("proposerExcluded")).toBeInTheDocument();
	});

	it("seeds a restricted policy and saves the approvers that remain checked", async () => {
		m.policy = { requiredApprovals: 1, approverUserIds: ["lead_1"] };
		renderSection();

		const lead1 = await screen.findByLabelText("Lead One");
		expect(lead1).toBeChecked();
		await userEvent.click(screen.getByLabelText("lead2@example.com"));
		await userEvent.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(m.updateCalls).toHaveLength(1));
		expect(m.updateCalls[0]).toEqual({
			projectId: "p",
			reviewPolicy: {
				requiredApprovals: 1,
				approverUserIds: ["lead_1", "lead_2"],
			},
		});
	});

	it("blocks a save when only as many approvers are selected as approvals required above one", async () => {
		m.policy = {
			requiredApprovals: 2,
			approverUserIds: ["lead_1", "lead_2"],
		};
		renderSection();

		expect(await screen.findByLabelText("Lead One")).toBeChecked();
		expect(screen.getByLabelText("lead2@example.com")).toBeChecked();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"tooFewApprovers",
		);
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
	});

	it("blocks a save when fewer approvers are selected than approvals required", async () => {
		m.policy = {
			requiredApprovals: 2,
			approverUserIds: ["lead_1", "lead_2"],
		};
		renderSection();

		const lead2 = await screen.findByLabelText("lead2@example.com");
		await userEvent.click(lead2);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"tooFewApprovers",
		);
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
	});

	it("shows a reader the policy without controls and never lists the members", async () => {
		m.policy = { requiredApprovals: 3, approverUserIds: null };
		renderSection(false);

		const required = await screen.findByLabelText("requiredLabel");
		await waitFor(() => expect(required).toHaveValue(3));
		expect(required).toHaveAttribute("readonly");
		expect(screen.queryByRole("button", { name: "save" })).toBeNull();
		expect(screen.queryByLabelText("restrictLabel")).toBeNull();
		expect(m.membersCalls).toBe(0);
	});
});
