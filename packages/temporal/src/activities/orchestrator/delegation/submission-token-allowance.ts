// Conservative surrogate charge per physical A2A submission, not a bound on
// the remote run's spend. A failed submission may have reached the server; a
// retry may create another task, so each physical submission reserves again.
export const A2A_SUBMISSION_TOKEN_ALLOWANCE = 25_000;
