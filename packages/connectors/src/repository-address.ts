/** Repository integrations are pinned to gitlab.com so tokens cannot reach arbitrary hosts. */
export function gitlabHost(): string {
	return "https://gitlab.com";
}

export function gitlabHeaders(input: {
	token: string;
	gitlabAuth?: "bearer" | "private-token";
}): Record<string, string> {
	return input.gitlabAuth === "private-token"
		? { "PRIVATE-TOKEN": input.token }
		: { Authorization: `Bearer ${input.token}` };
}

/** Azure DevOps accepts PATs as Basic auth and OAuth access tokens as Bearer. */
export function azureDevOpsHeaders(input: {
	token: string;
	azureDevOpsAuth?: "basic" | "bearer";
}): Record<string, string> {
	return {
		Authorization:
			input.azureDevOpsAuth === "bearer"
				? `Bearer ${input.token}`
				: `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`,
		Accept: "application/json",
	};
}

export function parseAdoRepositoryUrl(repositoryUrl: string): {
	organization: string;
	project: string;
	host: string;
} | null {
	const devAzure =
		/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+/i.exec(
			repositoryUrl,
		);
	if (devAzure) {
		return {
			organization: devAzure[1],
			project: decodeURIComponent(devAzure[2]),
			host: "https://dev.azure.com",
		};
	}
	const legacy =
		/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/[^/]+/i.exec(
			repositoryUrl,
		);
	if (legacy) {
		return {
			organization: legacy[1],
			project: decodeURIComponent(legacy[2]),
			host: `https://${legacy[1]}.visualstudio.com`,
		};
	}
	return null;
}
