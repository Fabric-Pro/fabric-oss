import {
	createOrganizationApiKeyProcedure,
	deleteOrganizationApiKeyProcedure,
	listOrganizationApiKeysProcedure,
} from "./procedures/api-keys";
import {
	getOrganizationAttachmentRetentionProcedure,
	updateOrganizationAttachmentRetentionProcedure,
} from "./procedures/attachment-retention";
import {
	getOrganizationBrandColorProcedure,
	updateOrganizationBrandColorProcedure,
} from "./procedures/brand-color";
import { createLogoUploadUrl } from "./procedures/create-logo-upload-url";
import {
	getOrganizationDelegationSettingProcedure,
	updateOrganizationDelegationSettingProcedure,
} from "./procedures/delegation-settings";
import { getOrganizationDocumentAssistantHistorySettingProcedure } from "./procedures/document-assistant-history-setting";
import { getOrganizationFeatureMaturationV2SettingProcedure } from "./procedures/feature-maturation-v2-setting";
import { deleteOrganizationFirecrawlKeyProcedure } from "./procedures/firecrawl/delete-key";
import { getOrganizationFirecrawlConfigProcedure } from "./procedures/firecrawl/get-config";
import { getOrganizationFirecrawlKeyProcedure } from "./procedures/firecrawl/get-key";
import { testOrganizationFirecrawlKeyProcedure } from "./procedures/firecrawl/test-key";
import { updateOrganizationFirecrawlKeyProcedure } from "./procedures/firecrawl/update-key";
import { generateOrganizationSlug } from "./procedures/generate-organization-slug";
import { getFrameSharingPolicyProcedure } from "./procedures/get-frame-sharing-policy";
import { getGuestOrganizationProcedure } from "./procedures/get-guest-organization";
import {
	cancelOrgInvitationProcedure,
	listOrgInvitationsProcedure,
	resendOrgInvitationProcedure,
} from "./procedures/invitations";
import { isGuestInOrgProcedure } from "./procedures/is-guest";
import {
	getOrganizationRagSettingsProcedure,
	updateOrganizationRagSettingsProcedure,
} from "./procedures/rag-settings";
import {
	getOrganizationRequireTwoFactorProcedure,
	updateOrganizationRequireTwoFactorProcedure,
} from "./procedures/require-two-factor";
import { searchMembersProcedure } from "./procedures/search-members";
import { updateFrameSharingPolicyProcedure } from "./procedures/update-frame-sharing-policy";

export const organizationsRouter = {
	generateSlug: generateOrganizationSlug,
	createLogoUploadUrl,
	isGuest: isGuestInOrgProcedure,
	getGuestOrg: getGuestOrganizationProcedure,
	brandColor: {
		get: getOrganizationBrandColorProcedure,
		update: updateOrganizationBrandColorProcedure,
	},
	delegationSettings: {
		get: getOrganizationDelegationSettingProcedure,
		update: updateOrganizationDelegationSettingProcedure,
	},
	requireTwoFactor: {
		get: getOrganizationRequireTwoFactorProcedure,
		update: updateOrganizationRequireTwoFactorProcedure,
	},
	attachmentRetention: {
		get: getOrganizationAttachmentRetentionProcedure,
		update: updateOrganizationAttachmentRetentionProcedure,
	},
	documentAssistantHistory: {
		// spec 2026-05-19 §3.11 FR-27 — read-only feature flag exposure;
		// no `update` mutation in this spec (flag is flipped via SQL
		// per spec §13 step 3 rollback plan).
		get: getOrganizationDocumentAssistantHistorySettingProcedure,
	},
	featureMaturationV2: {
		// Feature Maturation V2 spec §9 — read-only org flag exposure that
		// routes flagged orgs to the three-tab editor. No `update` mutation
		// (flag flipped via SQL for internal-first rollout, §9 / §15).
		get: getOrganizationFeatureMaturationV2SettingProcedure,
	},
	firecrawl: {
		getConfig: getOrganizationFirecrawlConfigProcedure,
		getKey: getOrganizationFirecrawlKeyProcedure,
		updateKey: updateOrganizationFirecrawlKeyProcedure,
		deleteKey: deleteOrganizationFirecrawlKeyProcedure,
		testKey: testOrganizationFirecrawlKeyProcedure,
	},
	apiKeys: {
		create: createOrganizationApiKeyProcedure,
		list: listOrganizationApiKeysProcedure,
		delete: deleteOrganizationApiKeyProcedure,
	},
	ragSettings: {
		get: getOrganizationRagSettingsProcedure,
		update: updateOrganizationRagSettingsProcedure,
	},
	frameSharingPolicy: {
		get: getFrameSharingPolicyProcedure,
		update: updateFrameSharingPolicyProcedure,
	},
	invitations: {
		list: listOrgInvitationsProcedure,
		resend: resendOrgInvitationProcedure,
		cancel: cancelOrgInvitationProcedure,
	},

	// @mentions autocomplete search
	searchMembers: searchMembersProcedure,
};
