import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	agents: vi.fn(),
	skills: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		agentTemplates: { instances: { list: { queryOptions: mocks.agents } } },
		skills: { list: { queryOptions: mocks.skills } },
	},
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("usehooks-ts", () => ({
	useDebounceValue: (value: string) => [value],
}));
vi.mock("@ui/components/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
		disabled,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		children: ReactNode;
		disabled?: boolean;
	}) => (
		<select
			value={value}
			disabled={disabled}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({
		value,
		children,
	}: {
		value: string;
		children: ReactNode;
	}) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));

import { AdoReviewInstructionFields } from "../../lib/plugins/mcp/AdoReviewInstructionFields";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.agents.mockImplementation(
		({ input }: { input: Record<string, unknown> }) => ({
			queryKey: ["agents", input],
		}),
	);
	mocks.skills.mockImplementation(
		({ input }: { input: Record<string, unknown> }) => ({
			queryKey: ["skills", input],
		}),
	);
	mocks.query.mockImplementation(
		({ queryKey }: { queryKey: [string, unknown] }) => ({
			isLoading: false,
			isFetching: false,
			isError: false,
			data:
				queryKey[0] === "agents"
					? {
							instances: [
								{
									id: "agent-1",
									name: "Example reviewer",
									organizationId: "org-1",
								},
								{
									id: "foreign-agent",
									name: "Foreign reviewer",
									organizationId: "other-org",
								},
							],
							hasMore: true,
						}
					: {
							skills: [
								{
									id: "skill-1",
									slug: "requirements",
									name: "Requirements",
									scope: "SYSTEM",
								},
							],
							hasMore: true,
						},
		}),
	);
});

describe("review instruction selection", () => {
	it("uses actual tenant-scoped active instance and published skill queries with pagination", () => {
		render(
			<AdoReviewInstructionFields
				agentId=""
				skills={[]}
				onAgentChange={vi.fn()}
				onSkillsChange={vi.fn()}
			/>,
		);
		expect(mocks.agents).toHaveBeenCalledWith({
			input: expect.objectContaining({
				organizationId: "org-1",
				status: "ACTIVE",
				latestVersionOnly: true,
				limit: 20,
				offset: 0,
			}),
		});
		expect(mocks.skills).toHaveBeenCalledWith({
			input: expect.objectContaining({
				organizationId: "org-1",
				isPublished: true,
				limit: 20,
				offset: 0,
			}),
		});
		expect(
			screen.queryByRole("option", { name: "Foreign reviewer" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
		expect(mocks.agents).toHaveBeenLastCalledWith({
			input: expect.objectContaining({ offset: 20 }),
		});
		fireEvent.change(screen.getByLabelText("Find agent instructions"), {
			target: { value: "reviewer" },
		});
		expect(mocks.agents).toHaveBeenLastCalledWith({
			input: expect.objectContaining({ search: "reviewer", offset: 0 }),
		});
		fireEvent.click(screen.getByRole("button", { name: "Next skills" }));
		expect(mocks.skills).toHaveBeenLastCalledWith({
			input: expect.objectContaining({ offset: 20 }),
		});
	});

	it("selects real returned IDs and slugs", () => {
		const onAgentChange = vi.fn();
		const onSkillsChange = vi.fn();
		render(
			<AdoReviewInstructionFields
				agentId=""
				skills={[]}
				onAgentChange={onAgentChange}
				onSkillsChange={onSkillsChange}
			/>,
		);
		const selectors = screen.getAllByRole("combobox");
		fireEvent.change(selectors[0], { target: { value: "agent-1" } });
		expect(onAgentChange).toHaveBeenCalledWith("agent-1");
		fireEvent.change(selectors[1], { target: { value: "requirements" } });
		expect(onSkillsChange).toHaveBeenCalledWith([
			{ slug: "requirements", textFiles: [] },
		]);
	});

	it("lets the author edit and clear optional text file paths without invoking a skill", () => {
		const onSkillsChange = vi.fn();
		render(
			<AdoReviewInstructionFields
				agentId=""
				skills={[
					{
						slug: "requirements",
						textFiles: ["references/checklist.md"],
					},
				]}
				onAgentChange={vi.fn()}
				onSkillsChange={onSkillsChange}
			/>,
		);
		const paths = screen.getByLabelText(
			"Additional text file paths for requirements",
		);
		fireEvent.change(paths, {
			target: { value: "references/one.md\nreferences/two.txt" },
		});
		expect(onSkillsChange).toHaveBeenLastCalledWith([
			{
				slug: "requirements",
				textFiles: ["references/one.md", "references/two.txt"],
			},
		]);
		fireEvent.change(paths, { target: { value: "" } });
		expect(onSkillsChange).toHaveBeenLastCalledWith([
			{ slug: "requirements", textFiles: [] },
		]);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove skill requirements" }),
		);
		expect(onSkillsChange).toHaveBeenLastCalledWith([]);
	});
});
