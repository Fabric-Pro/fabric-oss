/**
 * Channel abstraction (Slice 5a).
 *
 *   import "@repo/integrations/channels";        // registers built-in adapters
 *   import { channelRegistry } from "@repo/integrations/channels";
 *
 * Slack still runs on its bespoke route in this slice; migration is 5b.
 */

export { channelRegistry, registerChannel } from "./registry";
// Side-effect imports: each adapter self-registers.
export { slackChannelAdapter } from "./slack/index";
export { telegramChannelAdapter } from "./telegram/index";
export type {
	ChannelAdapter,
	ChannelCredentials,
	ChannelType,
	InboundContext,
	NormalizedMessage,
	OutboundContext,
	SendMessageInput,
	SendMessageResult,
	VerifyOutcome,
} from "./types";
