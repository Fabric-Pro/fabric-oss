import { atlassianCloudProcedures } from "./procedures/atlassian-cloud";
import {
	approveAuthoritySessionProcedure,
	denyAuthoritySessionProcedure,
	getAuthoritySessionProcedure,
	listAuthoritySessionsProcedure,
	revokeAuthoritySessionProcedure,
} from "./procedures/authority";
import { getAvailableConfigsProcedure } from "./procedures/available-configs";
import { listAvailablePmToolsProcedure } from "./procedures/available-pm-tools";
import { configProcedures } from "./procedures/configs";
import { connectProcedures } from "./procedures/connect";
import { dcrProcedures } from "./procedures/dcr";
import { discoveryProcedures } from "./procedures/discovery";
import { executeToolProcedure } from "./procedures/execute-tool";
import { fetchResourcesProcedure } from "./procedures/fetch-resources";
import { healthProcedures } from "./procedures/health";
import { listToolsProcedure } from "./procedures/list-tools";
import { oauthProcedures } from "./procedures/oauth";
import { publicRegistryProcedures } from "./procedures/public-registry";
import { refreshToolsProcedure } from "./procedures/refresh-tools";
import { registryProcedures } from "./procedures/registry";
import { sessionProcedures } from "./procedures/session";

export const mcpRouter = {
	registry: registryProcedures,
	publicRegistry: publicRegistryProcedures,
	configs: configProcedures,
	connect: connectProcedures,
	oauth: oauthProcedures,
	atlassianCloud: atlassianCloudProcedures,
	dcr: dcrProcedures,
	discovery: discoveryProcedures,
	health: healthProcedures,
	session: sessionProcedures,
	availableConfigs: getAvailableConfigsProcedure,
	availablePmTools: {
		list: listAvailablePmToolsProcedure,
	},
	tools: {
		list: listToolsProcedure,
		refresh: refreshToolsProcedure,
		execute: executeToolProcedure,
	},
	resources: {
		fetch: fetchResourcesProcedure,
	},
	authority: {
		list: listAuthoritySessionsProcedure,
		get: getAuthoritySessionProcedure,
		approve: approveAuthoritySessionProcedure,
		deny: denyAuthoritySessionProcedure,
		revoke: revokeAuthoritySessionProcedure,
	},
};
