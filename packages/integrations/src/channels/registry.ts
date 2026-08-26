import type { ChannelAdapter, ChannelType } from "./types";

/**
 * Singleton-style registry of channel adapters. Adapters self-register via
 * `registerChannel(adapter)` at module load (not at request time) so the
 * unified webhook route can resolve `:channel` → adapter in O(1).
 */
class ChannelRegistry {
	private readonly adapters = new Map<ChannelType, ChannelAdapter>();

	register(adapter: ChannelAdapter): void {
		if (this.adapters.has(adapter.channel)) {
			throw new Error(
				`ChannelRegistry: adapter for "${adapter.channel}" is already registered`,
			);
		}
		this.adapters.set(adapter.channel, adapter);
	}

	get(channel: ChannelType): ChannelAdapter | undefined {
		return this.adapters.get(channel);
	}

	require(channel: ChannelType): ChannelAdapter {
		const adapter = this.adapters.get(channel);
		if (!adapter) {
			throw new Error(
				`ChannelRegistry: no adapter registered for "${channel}"`,
			);
		}
		return adapter;
	}

	list(): ChannelAdapter[] {
		return [...this.adapters.values()];
	}

	has(channel: ChannelType): boolean {
		return this.adapters.has(channel);
	}
}

/** Process-wide registry. Adapters register here on import. */
export const channelRegistry = new ChannelRegistry();

export function registerChannel(adapter: ChannelAdapter): void {
	channelRegistry.register(adapter);
}
