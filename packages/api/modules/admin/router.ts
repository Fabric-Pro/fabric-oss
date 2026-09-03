import { getAiAdoptionMetricsProcedure } from "./procedures/ai-adoption";
import {
	adminAuditLogStatsViaApiKeyProcedure,
	adminAuditLogViaApiKeyProcedure,
} from "./procedures/audit-log-via-api-key";
import {
	listFeatureFlagsProcedure,
	resetFeatureFlagProcedure,
	setFeatureFlagProcedure,
} from "./procedures/feature-flags";
import { findOrganization } from "./procedures/find-organization";
import { listOrganizations } from "./procedures/list-organizations";
import { listUsers } from "./procedures/list-users";
import {
	clearOrgFeatureFlagProcedure,
	listFlagEnrolmentProcedure,
	listOrgFeatureFlagsProcedure,
	setOrgFeatureFlagProcedure,
} from "./procedures/org-feature-flags";

export const adminRouter = {
	aiAdoption: {
		metrics: getAiAdoptionMetricsProcedure,
	},
	users: {
		list: listUsers,
	},
	organizations: {
		list: listOrganizations,
		find: findOrganization,
	},
	auditLog: {
		viaApiKey: adminAuditLogViaApiKeyProcedure,
		statsViaApiKey: adminAuditLogStatsViaApiKeyProcedure,
	},
	featureFlags: {
		list: listFeatureFlagsProcedure,
		set: setFeatureFlagProcedure,
		reset: resetFeatureFlagProcedure,
		// Per-organization overrides. Grouped under the same namespace as the
		// instance-wide trio because they are two levels of one mechanism —
		// an operator reasoning about "who has this flag" needs both.
		listForOrg: listOrgFeatureFlagsProcedure,
		setForOrg: setOrgFeatureFlagProcedure,
		clearForOrg: clearOrgFeatureFlagProcedure,
		// The other direction of the same question: `listForOrg` reads one
		// organization's row, this reads every organization that has one.
		organizations: listFlagEnrolmentProcedure,
	},
};
