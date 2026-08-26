import "server-only";

/**
 * Whether the public opt-in widget should render. Gated on the same env SP-3's
 * archive uses: with no Fabric-main project configured, every subscribe is
 * discarded server-side — so we hide the form rather than promise "check your
 * inbox" for a signup that goes nowhere.
 */
export function isPublicNewsletterEnabled(): boolean {
	return Boolean(process.env.FABRIC_MAIN_PROJECT_ID?.trim());
}
