terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.50" }
    helm       = { source = "hashicorp/helm", version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
    http       = { source = "hashicorp/http", version = "~> 3.4" }
  }

  # State backend bootstrapped manually via deploy/terraform/bootstrap.sh,
  # then `terraform init` is invoked with:
  #   -backend-config="bucket=fabric-tfstate-<ACCOUNT_ID>"
  #   -backend-config="key=dev/terraform.tfstate"
  #   -backend-config="region=<REGION>"
  #   -backend-config="dynamodb_table=fabric-tfstate-lock"
  #   -backend-config="encrypt=true"
  backend "s3" {}
}
