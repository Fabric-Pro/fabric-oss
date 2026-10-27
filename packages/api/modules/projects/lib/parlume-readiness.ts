import {
	getAISpeechModel,
	resolveAzureOpenAiResource,
	resolveOpenAiApiKey,
} from "@repo/ai";
import { getOrganizationMembership } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import {
	getParlumeBridgeSettings,
	type ParlumeSettingSource,
} from "./parlume-attendee";
import { parlumeLog } from "./parlume-log";
import { resolveParlumeAttendeeSettings } from "./parlume-provider-settings";

/**
 * How Parlume would answer aloud: `realtime` on the organization's Azure AI
 * Foundry resource or OpenAI key, `classic` through its AI Gateway only.
 */
export type ParlumeVoiceEngine = "realtime" | "classic";

/** Why an invitation is refused when no provider can voice Parlume. */
export const PARLUME_VOICE_REQUIRED =
	"Parlume voice needs an AI provider for your organization. Add an Azure AI Foundry, OpenAI or Vercel AI Gateway API key in Settings → AI Providers. ChatGPT plans serve text only.";

/**
 * What an invitation needs, item by item, so the page can name what is
 * missing and where it is fixed. The meeting bot and the voice are
 * organization settings; the media bridge is the operator's.
 */
export interface ParlumeReadiness {
	meetingBot: { ready: boolean; source: ParlumeSettingSource | null };
	voice: { ready: boolean; engine: ParlumeVoiceEngine | null };
	platform: { ready: boolean };
	/** The viewer can change the organization's settings that fix the above. */
	canConfigure: boolean;
}

export function isParlumeReady(readiness: ParlumeReadiness): boolean {
	return (
		readiness.meetingBot.ready &&
		readiness.voice.ready &&
		readiness.platform.ready
	);
}

/**
 * Realtime voice runs on the organization's Azure AI Foundry resource or its
 * OpenAI key; the classic voice also speaks through its AI Gateway or OpenAI
 * key. Either makes Parlume able to answer aloud.
 */
export async function resolveParlumeVoiceEngine(tenant: {
	userId: string;
	organizationId: string;
}): Promise<ParlumeVoiceEngine | null> {
	const [azure, openAiKey] = await Promise.all([
		resolveAzureOpenAiResource(tenant),
		resolveOpenAiApiKey(tenant),
	]);
	if (azure || openAiKey) {
		return "realtime";
	}
	return (await getAISpeechModel(tenant)) ? "classic" : null;
}

async function meetingBotSource(
	organizationId: string,
): Promise<ParlumeSettingSource | null> {
	try {
		return (
			(await resolveParlumeAttendeeSettings(organizationId))?.source ??
			null
		);
	} catch (error) {
		// A malformed operator setting is an operator fix; the item reads as
		// missing rather than failing the whole page.
		parlumeLog("warn", "readiness.attendee_settings_invalid", {
			organizationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function canConfigureParlume(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, userId);
	return membership
		? hasPermission(
				resolveOrgPermissions(membership.role),
				Permissions.ORG_INTEGRATIONS_MANAGE,
			)
		: false;
}

export async function getParlumeReadiness(tenant: {
	userId: string;
	organizationId: string;
}): Promise<ParlumeReadiness> {
	const [source, engine, canConfigure] = await Promise.all([
		meetingBotSource(tenant.organizationId),
		resolveParlumeVoiceEngine(tenant),
		canConfigureParlume(tenant.userId, tenant.organizationId),
	]);
	return {
		meetingBot: { ready: source !== null, source },
		voice: { ready: engine !== null, engine },
		platform: { ready: getParlumeBridgeSettings() !== null },
		canConfigure,
	};
}
