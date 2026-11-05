import { SaveReportConfigurationMenu } from "@saas/reports/components/SaveReportConfigurationMenu";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	savePrompt: vi.fn(),
	setOverride: vi.fn(),
	onSaved: vi.fn(),
	overrides: { data: undefined as unknown },
	refetch: vi.fn(),
	queryKey: undefined as unknown,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			templates: {
				savePrompt: {
					mutationOptions: (options: object) => ({
						...options,
						kind: "savePrompt",
					}),
				},
				overrides: {
					get: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["overrides", input],
						}),
					},
					set: {
						mutationOptions: (options: object) => ({
							...options,
							kind: "setOverride",
						}),
					},
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	// The stored defaults are read when the page opens, for whoever may set one.
	useQuery: ({
		enabled,
		queryKey,
	}: {
		enabled: boolean;
		queryKey: unknown;
	}) => {
		m.queryKey = queryKey;
		return {
			data: enabled ? m.overrides.data : undefined,
			isError: false,
			refetch: m.refetch,
		};
	},
	useMutation: (options: {
		kind: "savePrompt" | "setOverride";
		onSuccess?: (result: unknown, variables: unknown) => void;
	}) => ({
		mutate: (variables: unknown) => {
			(options.kind === "savePrompt" ? m.savePrompt : m.setOverride)(
				variables,
			);
			options.onSuccess?.({}, variables);
		},
		isPending: false,
	}),
}));

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	vi.clearAllMocks();
	m.overrides.data = {
		organization: {
			parameterDefaults: { team: "Example team" },
			context: {},
			schedule: null,
			prompts: null,
		},
		project: null,
	};
});

const editedReport = {
	organizationId: null as string | null,
	templateId: "template-1",
	projectId: "project-1",
	canSaveToTemplate: false,
	canSetOrganizationDefault: false,
	canSetOrganizationPrompts: true,
	canSetProjectDefault: false,
	parameterDefaults: null as Record<string, unknown> | null,
	connections: {
		promptOverride: "Summarise the sprint for leads.",
		promptOverrideSource: "user",
	},
	fabricConfig: { customAiTasks: { risks: "Find the delivery risks." } },
	template: {
		name: "Example sprint report",
		scope: "ORGANIZATION",
		isPublic: false,
		parameters: null as Record<string, unknown> | null,
		definition: {
			userPrompt: "Summarise the sprint.",
			aiAgents: [
				{
					agentId: "default",
					task: "Find the risks.",
					outputVariable: "risks",
				},
			],
		},
	},
};

const editedPrompts = {
	userPrompt: "Summarise the sprint for leads.",
	aiTasks: { risks: "Find the delivery risks." },
};

function show(flags: {
	canSaveToTemplate: boolean;
	canSetOrganizationDefault: boolean;
}) {
	return render(
		<SaveReportConfigurationMenu
			report={{ ...editedReport, ...flags }}
			onSaved={m.onSaved}
		/>,
	);
}

/** A report whose prompts match its template and whose parameters were edited. */
const parameterReport = {
	...editedReport,
	connections: {
		resourceBindings: {
			fizzy: {
				resourceId: "board-7",
				resourceName: "Example board",
				resourceType: "board",
			},
		},
	},
	fabricConfig: null,
	parameterDefaults: {
		team: "Example team",
		boardId: "board-7",
		projectName: "Example project",
	},
	template: {
		...editedReport.template,
		parameters: {
			properties: {
				team: { type: "string" },
				boardId: { type: "string" },
				projectName: { type: "string" },
			},
		},
	},
};

const projectButton = () =>
	screen.queryByRole("button", { name: "Set as project default" });

async function confirmWith(buttonName: string, actionName: string) {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: buttonName }));
	const dialog = await screen.findByRole("alertdialog");
	await user.click(within(dialog).getByRole("button", { name: actionName }));
}

const updateButton = () =>
	screen.queryByRole("button", { name: "Update template" });
const organizationButton = () =>
	screen.queryByRole("button", { name: "Set as organization default" });

describe("SaveReportConfigurationMenu", () => {
	it("offers nothing to someone who may do neither", () => {
		const { container } = show({
			canSaveToTemplate: false,
			canSetOrganizationDefault: false,
		});

		expect(container).toBeEmptyDOMElement();
	});

	it("offers nothing while the report uses the template's prompts", () => {
		const { container } = render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					canSaveToTemplate: true,
					canSetOrganizationDefault: true,
					connections: {},
					fabricConfig: null,
				}}
				onSaved={m.onSaved}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("offers only Update template to a template manager", () => {
		show({ canSaveToTemplate: true, canSetOrganizationDefault: false });

		expect(updateButton()).toBeInTheDocument();
		expect(organizationButton()).not.toBeInTheDocument();
	});

	it("offers only the organization default to an organization admin", () => {
		show({ canSaveToTemplate: false, canSetOrganizationDefault: true });

		expect(updateButton()).not.toBeInTheDocument();
		expect(organizationButton()).toBeInTheDocument();
	});

	it("offers both when both are allowed", () => {
		show({ canSaveToTemplate: true, canSetOrganizationDefault: true });

		expect(updateButton()).toBeInTheDocument();
		expect(organizationButton()).toBeInTheDocument();
	});

	it("writes the report's saved prompts into the template after confirming", async () => {
		const user = userEvent.setup();
		show({ canSaveToTemplate: true, canSetOrganizationDefault: false });

		await user.click(
			screen.getByRole("button", { name: "Update template" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			"Reports already made keep their own values.",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Update template" }),
		);

		expect(m.savePrompt).toHaveBeenCalledWith({
			templateId: "template-1",
			...editedPrompts,
		});
		expect(m.setOverride).not.toHaveBeenCalled();
		expect(m.onSaved).toHaveBeenCalled();
	});

	it("sets the organization default with its other defaults kept", async () => {
		const user = userEvent.setup();
		show({ canSaveToTemplate: false, canSetOrganizationDefault: true });

		await user.click(
			screen.getByRole("button", { name: "Set as organization default" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Set as default" }),
		);

		expect(m.setOverride).toHaveBeenCalledWith({
			templateId: "template-1",
			projectId: "project-1",
			scope: "ORGANIZATION",
			defaults: {
				parameterDefaults: { team: "Example team" },
				context: null,
				schedule: null,
				prompts: editedPrompts,
			},
		});
		expect(m.savePrompt).not.toHaveBeenCalled();
	});

	it("keeps the organization's stored default prompts this report does not change", async () => {
		const user = userEvent.setup();
		m.overrides.data = {
			organization: {
				parameterDefaults: {},
				context: {},
				schedule: null,
				prompts: {
					aiTasks: {
						risks: "Stored risks prompt.",
						wins: "Stored wins prompt.",
					},
				},
			},
		};
		render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					canSetOrganizationDefault: true,
					template: {
						...editedReport.template,
						definition: {
							userPrompt: "Summarise the sprint.",
							aiAgents: [
								...editedReport.template.definition.aiAgents,
								{
									agentId: "default",
									task: "Find the wins.",
									outputVariable: "wins",
								},
							],
						},
					},
				}}
				onSaved={m.onSaved}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Set as organization default" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			"Defaults this report does not change keep their current values",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Set as default" }),
		);

		expect(m.setOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				defaults: expect.objectContaining({
					prompts: {
						userPrompt: "Summarise the sprint for leads.",
						aiTasks: {
							risks: "Find the delivery risks.",
							wins: "Stored wins prompt.",
						},
					},
				}),
			}),
		);
	});

	it("offers parameter values when only they differ, and only where the role allows", () => {
		render(
			<SaveReportConfigurationMenu
				report={{ ...parameterReport, canSetProjectDefault: true }}
				onSaved={m.onSaved}
			/>,
		);

		expect(projectButton()).toBeInTheDocument();
		expect(updateButton()).not.toBeInTheDocument();
		expect(organizationButton()).not.toBeInTheDocument();
	});

	it("writes only the parameters that may reach beyond the project into the template", async () => {
		render(
			<SaveReportConfigurationMenu
				report={{ ...parameterReport, canSaveToTemplate: true }}
				onSaved={m.onSaved}
			/>,
		);

		await confirmWith("Update template", "Update template");

		expect(m.savePrompt).toHaveBeenCalledWith({
			templateId: "template-1",
			parameterDefaults: { team: "Example team" },
		});
	});

	it("merges parameters over the organization's defaults, without its stored prompts being touched", async () => {
		m.overrides.data = {
			organization: {
				parameterDefaults: { team: "Stored team", region: "Example" },
				context: {},
				schedule: null,
				prompts: { userPrompt: "Stored prompt." },
			},
			project: null,
		};
		render(
			<SaveReportConfigurationMenu
				report={{
					...parameterReport,
					canSetOrganizationDefault: true,
				}}
				onSaved={m.onSaved}
			/>,
		);

		await confirmWith("Set as organization default", "Set as default");

		const { scope, defaults } = m.setOverride.mock.calls[0][0];
		expect(scope).toBe("ORGANIZATION");
		expect(defaults.parameterDefaults).toEqual({
			team: "Example team",
			region: "Example",
		});
		expect(defaults).not.toHaveProperty("prompts");
	});

	it("leaves the organization's own template prompts out of its default", () => {
		render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					canSetOrganizationDefault: true,
					canSetOrganizationPrompts: false,
				}}
				onSaved={m.onSaved}
			/>,
		);

		expect(organizationButton()).not.toBeInTheDocument();
	});

	it("sets the report's own prompts as the project's default, keeping the project's others", async () => {
		m.overrides.data = {
			organization: null,
			project: {
				parameterDefaults: { region: "Example" },
				context: {},
				schedule: null,
				prompts: { aiTasks: { dropped: "Stale prompt." } },
			},
		};
		render(
			<SaveReportConfigurationMenu
				report={{ ...editedReport, canSetProjectDefault: true }}
				onSaved={m.onSaved}
			/>,
		);

		await confirmWith("Set as project default", "Set as default");

		const { defaults, scope } = m.setOverride.mock.calls[0][0];
		expect(scope).toBe("PROJECT");
		expect(defaults.parameterDefaults).toEqual({ region: "Example" });
		expect(defaults.prompts.userPrompt).toBe(
			"Summarise the sprint for leads.",
		);
		expect(defaults.prompts.aiTasks).not.toHaveProperty("dropped");
	});

	it("sets the project default with a bound board, leaving stored prompts out when the report changes none", async () => {
		m.overrides.data = {
			organization: null,
			project: {
				parameterDefaults: { region: "Example" },
				context: { team: "Example" },
				schedule: null,
				prompts: null,
			},
		};
		render(
			<SaveReportConfigurationMenu
				report={{ ...parameterReport, canSetProjectDefault: true }}
				onSaved={m.onSaved}
			/>,
		);

		await confirmWith("Set as project default", "Set as default");

		expect(m.setOverride).toHaveBeenCalledWith({
			templateId: "template-1",
			projectId: "project-1",
			scope: "PROJECT",
			defaults: {
				parameterDefaults: {
					region: "Example",
					team: "Example team",
					boardId: "board-7",
				},
				context: { team: "Example" },
				schedule: null,
			},
		});
	});

	it("drops a stored prompt for an AI task the template no longer has", async () => {
		m.overrides.data = {
			organization: {
				parameterDefaults: {},
				context: {},
				schedule: null,
				prompts: { aiTasks: { dropped: "Stale prompt." } },
			},
			project: null,
		};
		show({ canSaveToTemplate: false, canSetOrganizationDefault: true });

		await confirmWith("Set as organization default", "Set as default");

		const { defaults } = m.setOverride.mock.calls[0][0];
		expect(defaults.prompts.aiTasks).toEqual({
			risks: "Find the delivery risks.",
		});
	});

	it("reads the stored defaults again after saving one, so its offer can go", async () => {
		const user = userEvent.setup();
		show({ canSaveToTemplate: false, canSetOrganizationDefault: true });

		await user.click(
			screen.getByRole("button", { name: "Set as organization default" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Set as default" }),
		);

		expect(m.refetch).toHaveBeenCalled();
	});

	it("reads and sets a default in the report's organization", async () => {
		render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					organizationId: "example-report-org",
					canSetOrganizationDefault: true,
				}}
				onSaved={m.onSaved}
			/>,
		);

		expect(m.queryKey).toEqual([
			"overrides",
			expect.objectContaining({ organizationId: "example-report-org" }),
		]);
		await confirmWith("Set as organization default", "Set as default");

		expect(m.setOverride).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-report-org" }),
		);
	});

	it("updates the template from the report's organization", async () => {
		render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					organizationId: "example-report-org",
					canSaveToTemplate: true,
				}}
				onSaved={m.onSaved}
			/>,
		);

		await confirmWith("Update template", "Update template");

		expect(m.savePrompt).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-report-org" }),
		);
	});

	it("warns that a system template's change reaches every organization", async () => {
		const user = userEvent.setup();
		render(
			<SaveReportConfigurationMenu
				report={{
					...editedReport,
					canSaveToTemplate: true,
					template: { ...editedReport.template, scope: "SYSTEM" },
				}}
				onSaved={m.onSaved}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Update template" }),
		);

		expect(
			await screen.findByText(/in every organization use them/),
		).toBeTruthy();
	});

	it("offers nothing once new reports already start with these values", () => {
		m.overrides.data = {
			organization: {
				parameterDefaults: { team: "Example team" },
				context: {},
				schedule: null,
				prompts: null,
			},
			project: {
				parameterDefaults: { boardId: "board-7" },
				context: {},
				schedule: null,
				prompts: null,
			},
		};
		const { container } = render(
			<SaveReportConfigurationMenu
				report={{
					...parameterReport,
					canSetOrganizationDefault: true,
					canSetProjectDefault: true,
				}}
				onSaved={m.onSaved}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("does nothing when the confirmation is cancelled", async () => {
		const user = userEvent.setup();
		show({ canSaveToTemplate: true, canSetOrganizationDefault: true });

		await user.click(
			screen.getByRole("button", { name: "Update template" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);

		expect(m.savePrompt).not.toHaveBeenCalled();
		expect(m.setOverride).not.toHaveBeenCalled();
	});
});
