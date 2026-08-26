import { listAvailableModelsProcedure } from "./procedures/models/list-available";
import { listModelCatalogProcedure } from "./procedures/models/list-catalog";
import { listModelsFromGatewayProcedure } from "./procedures/models/list-from-gateway";
import { getOrgModelPreferencesProcedure } from "./procedures/preferences/get-org";
import { getTaskDefaultsProcedure } from "./procedures/preferences/get-task-defaults";
import { getUserModelPreferencesProcedure } from "./procedures/preferences/get-user";
import {
	deleteOrgModelPreferenceProcedure,
	setOrgModelPreferenceProcedure,
} from "./procedures/preferences/set-org";
import {
	deleteUserModelPreferenceProcedure,
	setUserModelPreferenceProcedure,
} from "./procedures/preferences/set-user";
import {
	testProviderConnectionProcedure,
	testSavedProviderConnectionProcedure,
} from "./procedures/providers/test-connection";
import {
	deleteUserProviderProcedure,
	getProviderConfigProcedure,
	setDefaultProviderProcedure,
	setEmbeddingProviderProcedure,
	updateEnabledProvidersProcedure,
	upsertUserProviderProcedure,
} from "./procedures/providers/upsert";
import { getAiConfigStatusProcedure } from "./procedures/resolution/get-status";
import { resolveModelForAgentProcedure } from "./procedures/resolution/resolve-for-agent";
import { resolveModelProcedure } from "./procedures/resolution/resolve-model";

export const aiConfigRouter = {
	// Model catalog
	models: {
		list: listModelCatalogProcedure,
		listAvailable: listAvailableModelsProcedure,
		listFromGateway: listModelsFromGatewayProcedure,
	},

	// Provider management
	providers: {
		testConnection: testProviderConnectionProcedure,
		testSavedConnection: testSavedProviderConnectionProcedure,
		upsert: upsertUserProviderProcedure,
		delete: deleteUserProviderProcedure,
		setDefault: setDefaultProviderProcedure,
		setEmbedding: setEmbeddingProviderProcedure,
		updateEnabled: updateEnabledProvidersProcedure,
		getConfig: getProviderConfigProcedure,
	},

	// User preferences
	preferences: {
		getUser: getUserModelPreferencesProcedure,
		setUser: setUserModelPreferenceProcedure,
		deleteUser: deleteUserModelPreferenceProcedure,
		getOrg: getOrgModelPreferencesProcedure,
		setOrg: setOrgModelPreferenceProcedure,
		deleteOrg: deleteOrgModelPreferenceProcedure,
		getTaskDefaults: getTaskDefaultsProcedure,
	},

	// Model resolution
	resolution: {
		resolveModel: resolveModelProcedure,
		resolveForAgent: resolveModelForAgentProcedure,
		getStatus: getAiConfigStatusProcedure,
	},
};
