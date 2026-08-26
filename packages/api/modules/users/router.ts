import {
	createUserApiKeyProcedure,
	deleteUserApiKeyProcedure,
	listUserApiKeysProcedure,
} from "./procedures/api-keys";
import {
	getChatAgentSelectionProcedure,
	setChatAgentSelectionProcedure,
} from "./procedures/chat-agent-selection";
import { createAvatarUploadUrl } from "./procedures/create-avatar-upload-url";
import {
	getUserDelegationSettingProcedure,
	updateUserDelegationSettingProcedure,
} from "./procedures/delegation-settings";
import { deleteUserFirecrawlKeyProcedure } from "./procedures/firecrawl/delete-key";
import { getUserFirecrawlConfigProcedure } from "./procedures/firecrawl/get-config";
import { getUserFirecrawlKeyProcedure } from "./procedures/firecrawl/get-key";
import { testUserFirecrawlKeyProcedure } from "./procedures/firecrawl/test-key";
import { updateUserFirecrawlKeyProcedure } from "./procedures/firecrawl/update-key";
import {
	dismissMfaPromptProcedure,
	getMfaPromptStateProcedure,
} from "./procedures/mfa-prompt";
import {
	getOnboardingTourStateProcedure,
	updateOnboardingTourStateProcedure,
} from "./procedures/onboarding";
import {
	getOrchestratorPreferencesProcedure,
	updateOrchestratorPreferencesProcedure,
} from "./procedures/orchestrator-preferences";
import { updateLastActiveWorkspaceProcedure } from "./procedures/update-last-active-workspace";

export const usersRouter = {
	avatarUploadUrl: createAvatarUploadUrl,
	delegationSettings: {
		get: getUserDelegationSettingProcedure,
		update: updateUserDelegationSettingProcedure,
	},
	mfaPrompt: {
		getState: getMfaPromptStateProcedure,
		dismiss: dismissMfaPromptProcedure,
	},
	onboarding: {
		getState: getOnboardingTourStateProcedure,
		update: updateOnboardingTourStateProcedure,
	},
	firecrawl: {
		getConfig: getUserFirecrawlConfigProcedure,
		getKey: getUserFirecrawlKeyProcedure,
		updateKey: updateUserFirecrawlKeyProcedure,
		deleteKey: deleteUserFirecrawlKeyProcedure,
		testKey: testUserFirecrawlKeyProcedure,
	},
	apiKeys: {
		create: createUserApiKeyProcedure,
		list: listUserApiKeysProcedure,
		delete: deleteUserApiKeyProcedure,
	},
	orchestratorPreferences: {
		get: getOrchestratorPreferencesProcedure,
		update: updateOrchestratorPreferencesProcedure,
	},
	chatAgentSelection: {
		get: getChatAgentSelectionProcedure,
		set: setChatAgentSelectionProcedure,
	},
	updateLastActiveWorkspace: updateLastActiveWorkspaceProcedure,
};
