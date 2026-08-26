-- Non-credential integration status: the credential is alive but cannot read
-- THIS repository (provider app not installed on it, or token scoped away).
ALTER TYPE "RepositoryIntegrationStatus" ADD VALUE IF NOT EXISTS 'REPO_UNAVAILABLE';
