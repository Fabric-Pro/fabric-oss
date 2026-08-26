/**
 * Typed proxy over `orpcClient.projects.slackChannelMonitor.*`.
 *
 * Track 3 (API procedures) is built in parallel — until the generated oRPC
 * client types land, this module casts through a hand-rolled shape so the
 * Slack monitor UI compiles standalone. When the real types are generated,
 * delete this file and import the namespace directly.
 */

import { orpcClient } from "@shared/lib/orpc-client";

export type LinkedSlackChannel = {
	id: string;
	projectId: string;
	slackTeamId: string;
	channelId: string;
	teamName: string | null;
	channelName: string | null;
	channelWebUrl: string | null;
	linkedAt: string | Date;
	monitorEnabledAt: string | Date | null;
	backfillCompleteAt: string | Date | null;
	lastMessageTs: string | null;
	consecutiveFailures: number;
	lastErrorMessage: string | null;
	lastErrorAt: string | Date | null;
	userId: string | null;
	organizationId: string | null;
	_count?: {
		seenMessages: number;
	};
};

type LinkSlackChannelInput = {
	projectId: string;
	organizationId: string | null;
	channelId: string;
	channelName?: string;
	backfillMode: "from-now" | "latest-7-days";
};

export type SlackChannelMonitorClient = {
	listLinkedChannels: (input: {
		projectId: string;
		organizationId: string | null;
	}) => Promise<LinkedSlackChannel[]>;
	linkChannel: (input: LinkSlackChannelInput) => Promise<unknown>;
	unlinkChannel: (input: {
		projectId: string;
		organizationId: string | null;
		linkedChannelId: string;
	}) => Promise<unknown>;
	enable: (input: {
		projectId: string;
		organizationId: string | null;
		debounceMs: number;
		maxHoldMs: number;
	}) => Promise<unknown>;
	disable: (input: {
		projectId: string;
		organizationId: string | null;
	}) => Promise<unknown>;
	triggerMonitor: (input: {
		projectId: string;
		organizationId: string | null;
	}) => Promise<unknown>;
};

export function getSlackChannelMonitorClient(): SlackChannelMonitorClient {
	return (
		orpcClient.projects as unknown as {
			slackChannelMonitor: SlackChannelMonitorClient;
		}
	).slackChannelMonitor;
}
