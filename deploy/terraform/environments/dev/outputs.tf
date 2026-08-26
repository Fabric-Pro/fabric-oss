output "ecr_registry_url" {
  description = "Container registry URL — set this as GitLab CI variable ECR_REGISTRY"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "cluster_name" {
  description = "EKS cluster name — set this as GitLab CI variable CLUSTER_NAME"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "region" {
  description = "AWS region — set this as GitLab CI variable AWS_REGION"
  value       = var.region
}

output "deployer_role_arn" {
  # NOT `AWS_ROLE_ARN`: that name is reserved by the AWS SDK for IRSA web-identity
  # and the EKS pod-identity webhook injects it into build pods, where a global
  # CI/CD variable of the same name shadows the injected role and breaks the ECR
  # push with a trust mismatch. See ci/gitlab/00-variables.yml.
  description = "IAM role for GitLab CI to assume — set this as GitLab CI variable DEPLOYER_ROLE_ARN"
  value       = module.gitlab_oidc.role_arn
}

output "rds_endpoint" {
  description = "RDS hostname:port"
  value       = module.rds.endpoint
}

output "elasticache_endpoint" {
  # Not wired into the Helm chart: `elasticache.endpoint` has no template consumer.
  # REDIS_URL is delivered by ExternalSecrets from the Terraform-managed
  # `fabric/<env>/redis` secret. This output is for inspection/debugging only.
  description = "ElastiCache primary endpoint (informational — REDIS_URL ships via Secrets Manager)"
  value       = module.elasticache.primary_endpoint
}

output "s3_buckets" {
  description = "Fully-qualified bucket names keyed to match the Helm chart's camelCase s3.buckets.*. Every name is \"<prefix>-<suffix>\" (see modules/s3/main.tf); set that shared prefix as GitLab CI variable S3_BUCKET_PREFIX and ci/gitlab/60-deploy-aws.yml derives all seven. (module.s3 keys are hyphenated; remapped here so the chart's .Values.s3.buckets.chatDocuments etc. resolve.)"
  value = {
    avatars               = module.s3.bucket_names_map["avatars"]
    chatDocuments         = module.s3.bucket_names_map["chat-documents"]
    projectContexts       = module.s3.bucket_names_map["project-contexts"]
    workspaceDocuments    = module.s3.bucket_names_map["workspace-documents"]
    orchestratorArtifacts = module.s3.bucket_names_map["orchestrator-artifacts"]
    skills                = module.s3.bucket_names_map["skills"]
    projectDocumentAssets = module.s3.bucket_names_map["project-document-assets"]
  }
}

output "secret_arns" {
  description = "Map of Secrets Manager group -> ARN"
  value       = module.secrets.secret_arns
}

output "app_irsa_role_arn" {
  description = "IRSA role ARN for the `fabric` ServiceAccount — set as GitLab CI variable APP_IRSA_ROLE_ARN, scoped to its environment; 60-deploy-aws.yml writes it into a generated values override passed with -f"
  value       = var.enable_k8s_addons ? module.app_irsa[0].role_arn : ""
}

output "route53_name_servers" {
  description = "If domain_name is set: NS records to delegate at your registrar. Otherwise empty."
  value       = module.route53.name_servers
}
