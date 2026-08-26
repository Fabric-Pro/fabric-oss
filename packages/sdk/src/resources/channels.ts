/**
 * ChannelsResource — uniform conversational-channel surface.
 *
 *   await fabric.channels.list();
 *     // → [{ channel: "telegram", name: "Telegram", connected: true }, ...]
 *
 *   await fabric.channels.send({
 *     channel: "telegram",
 *     channelId: "12345",
 *     threadId: "",
 *     text: "Hello from Fabric!",
 *   });
 *
 * Same surface works for every channel — Telegram today; Discord, Teams,
 * WhatsApp, iMessage as adapters land. Slack still uses its bespoke route in
 * Slice 5a; once Slice 5b migrates Slack to this abstraction the SDK call
 * site stays identical.
 */

import type { FabricHttpClient } from "../client.js";

export interface ChannelInfo {
	channel: string;
	name: string;
	connected: boolean;
	providerKey: string;
}

export interface SendChannelMessageInput {
	channel: string;
	channelId: string;
	threadId?: string;
	text: string;
}

export interface SendChannelMessageResult {
	ok: boolean;
	messageId?: string;
	error?: string;
}

export class ChannelsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/** List channel adapters registered on the workspace and their connection status. */
	list(): Promise<ChannelInfo[]> {
		return this.http.get<ChannelInfo[]>("/channels");
	}

	/**
	 * Send an outbound message on a channel. Threading is optional; omit
	 * `threadId` for flat conversations or new threads.
	 */
	send(input: SendChannelMessageInput): Promise<SendChannelMessageResult> {
		const { channel, ...body } = input;
		return this.http.post<SendChannelMessageResult>(
			`/channels/${encodeURIComponent(channel)}/send`,
			body,
		);
	}
}
