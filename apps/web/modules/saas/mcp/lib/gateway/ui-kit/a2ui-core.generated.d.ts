declare const A2UI: {
	MAX_CODE: number;
	readMessages(raw: unknown): unknown[];
	buildSurfaces(messages: unknown[]): { surfaces: any[]; errors: any[] };
	documentText(built: { surfaces: any[] }): string;
	resolve(expr: unknown, ctx: any): unknown;
	toText(val: unknown): string;
};
export default A2UI;
