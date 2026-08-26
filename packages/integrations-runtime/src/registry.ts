import type { IntegrationPlugin } from "./types.js";

/**
 * Registry of integration plugins keyed by slug. Single source of truth for the
 * executor and webhook processor.
 */
export class IntegrationRegistry {
	private readonly plugins = new Map<string, IntegrationPlugin>();

	register(plugin: IntegrationPlugin): void {
		if (this.plugins.has(plugin.slug)) {
			throw new Error(
				`IntegrationRegistry: plugin "${plugin.slug}" is already registered`,
			);
		}
		this.plugins.set(plugin.slug, plugin);
	}

	registerAll(plugins: readonly IntegrationPlugin[]): void {
		for (const p of plugins) {
			this.register(p);
		}
	}

	get(slug: string): IntegrationPlugin | undefined {
		return this.plugins.get(slug);
	}

	require(slug: string): IntegrationPlugin {
		const plugin = this.plugins.get(slug);
		if (!plugin) {
			throw new Error(
				`IntegrationRegistry: no plugin registered for slug "${slug}"`,
			);
		}
		return plugin;
	}

	list(): IntegrationPlugin[] {
		return [...this.plugins.values()];
	}

	has(slug: string): boolean {
		return this.plugins.has(slug);
	}
}
