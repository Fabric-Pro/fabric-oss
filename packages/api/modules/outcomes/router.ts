import { getOutcomesByTokenProcedure } from "./procedures/get-by-token";

/** Public, token-scoped customer outcomes (plan Slice 8). */
export const outcomesRouter = {
	getByToken: getOutcomesByTokenProcedure,
};
