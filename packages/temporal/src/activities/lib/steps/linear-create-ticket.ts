/**
 * Linear Create Ticket Step
 * Creates a new issue in Linear
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeLinearCreateTicketStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { ticketTitle, ticketDescription, priority } = params.nodeConfig as {
		ticketTitle?: string;
		ticketDescription?: string;
		priority?: string;
	};

	if (!ticketTitle) {
		return { success: false, error: "Ticket title is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"LINEAR",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.LINEAR_API_KEY) {
		return {
			success: false,
			error: "Linear API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedTitle = interpolateTemplate(ticketTitle, params.inputs);
	const interpolatedDescription = ticketDescription
		? interpolateTemplate(ticketDescription, params.inputs)
		: undefined;

	try {
		let teamId = credentials.LINEAR_TEAM_ID;

		if (!teamId) {
			const teamsResponse = await fetch(
				"https://api.linear.app/graphql",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: credentials.LINEAR_API_KEY,
					},
					body: JSON.stringify({
						query: "{ teams { nodes { id name } } }",
					}),
				},
			);

			const teamsData = await teamsResponse.json();
			teamId = teamsData.data?.teams?.nodes?.[0]?.id;

			if (!teamId) {
				return { success: false, error: "No Linear teams found" };
			}
		}

		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: credentials.LINEAR_API_KEY,
			},
			body: JSON.stringify({
				query: `
					mutation CreateIssue($input: IssueCreateInput!) {
						issueCreate(input: $input) {
							success
							issue {
								id
								identifier
								title
								url
							}
						}
					}
				`,
				variables: {
					input: {
						teamId,
						title: interpolatedTitle,
						description: interpolatedDescription,
						priority: priority
							? Number.parseInt(priority, 10)
							: undefined,
					},
				},
			}),
		});

		const result = await response.json();

		if (result.errors) {
			return {
				success: false,
				error: result.errors[0]?.message || "Failed to create issue",
			};
		}

		const issue = result.data?.issueCreate?.issue;
		return {
			success: true,
			output: {
				// `id` is what the plugin declares in outputFields, so it is
				// what the UI's {{Node.field}} autocomplete offers. `issueId`
				// predates it and is kept so existing workflows keep resolving.
				id: issue?.id,
				issueId: issue?.id,
				identifier: issue?.identifier,
				title: issue?.title,
				url: issue?.url,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Linear ticket",
		};
	}
}
