/**
 * AI's starting values for a new report's settings: only the parameters still
 * empty after every other source of a value, from the project's name and
 * description. The create dialog and one-click Generate both come here, so one
 * rule decides what AI may fill.
 */

import { generateReportParameterDefaults } from "@repo/ai";
import { db } from "@repo/database";
import { aiFillableParameters } from "@repo/database/prisma/queries/lib/report-parameter-ai-defaults";
import { logger } from "@repo/logs";

/**
 * Never throws: a refused rate limit or a failed generation leaves the values
 * empty, and a required one left empty sends the person to the dialog. The rate
 * limit is taken only when there is something to ask for.
 */
export async function suggestReportParameters({
	template,
	filled,
	projectId,
	caller,
	organizationId,
	enforceRateLimit,
}: {
	template: {
		name: string;
		description: string | null;
		parameters: unknown;
	};
	filled: Record<string, unknown>;
	projectId: string;
	caller: { id: string };
	organizationId: string;
	enforceRateLimit: () => Promise<void>;
}): Promise<Record<string, string>> {
	const parameters = aiFillableParameters(template.parameters, filled);
	if (parameters.length === 0) {
		return {};
	}
	try {
		await enforceRateLimit();
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { name: true, description: true },
		});
		if (!project) {
			return {};
		}
		return await generateReportParameterDefaults({
			parameters,
			project,
			template,
			context: { userId: caller.id, organizationId, projectId },
		});
	} catch (error) {
		logger.info("Report parameter suggestions skipped", { error });
		return {};
	}
}
