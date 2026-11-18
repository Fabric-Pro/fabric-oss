import { QUESTIONS as baseline } from "../../questions.mjs";

export const QUESTIONS = {
	...baseline,
	tenant_scope: `${baseline.tenant_scope} Check each linked record independently. For example, a scoped list of agent instances does not make a subsequent template lookup by template IDs tenant-safe. A custom tool server looked up by ID can belong to a different organization. When a tool-call cache holds private arguments, the query needs the requesting member's ID as well as the organization. For work linked to an authorized project, check that the write or workflow uses the project's organization.`,
};
