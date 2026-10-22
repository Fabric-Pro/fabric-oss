import { getEmbeddingChangeImpactProcedure } from "./procedures/embeddings/change-impact";
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
import { setPlanSpentFallbackProcedure } from "./procedures/providers/set-plan-spent-fallback";
import {
	testProviderConnectionProcedure,
	testSavedProviderConnectionProcedure,
} from "./procedures/providers/test-connection";
import {
	deleteUserProviderProcedure,
	getProviderConfigProcedure,
	previewSetDefaultProviderProcedure,
	setDefaultProviderProcedure,
	setEmbeddingProviderProcedure,
	updateEnabledProvidersProcedure,
	upsertUserProviderProcedure,
} from "./procedures/providers/upsert";
import { getAiConfigStatusProcedure } from "./procedures/resolution/get-status";
import { resolveModelForAgentProcedure } from "./procedures/resolution/resolve-for-agent";
import { resolveModelProcedure } from "./procedures/resolution/resolve-model";

export const aiConfigRouter = {
	embeddings: { changeImpact: getEmbeddingChangeImpactProcedure },
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
		previewSetDefault: previewSetDefaultProviderProcedure,
		setEmbedding: setEmbeddingProviderProcedure,
		setPlanSpentFallback: setPlanSpentFallbackProcedure,
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
