const PM_PROVIDER_LABELS: Record<string, string> = {
	"azure-devops": "Azure DevOps",
	fizzy: "Fizzy",
	jira: "Jira",
	linear: "Linear",
	github: "GitHub",
	gitlab: "GitLab",
	asana: "Asana",
	trello: "Trello",
	notion: "Notion",
	monday: "Monday",
	clickup: "ClickUp",
};

export function getPmProviderLabel(
	type: string | null | undefined,
): string | null {
	if (!type) {
		return null;
	}
	return PM_PROVIDER_LABELS[type] ?? null;
}
