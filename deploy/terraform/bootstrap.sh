#!/usr/bin/env bash
# Creates the S3 bucket + DynamoDB table for Terraform remote state.
# Run once per AWS account before the first `terraform init`.
set -euo pipefail

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_REGION:-us-east-1}"
BUCKET="fabric-tfstate-${ACCOUNT_ID}"
TABLE="fabric-tfstate-lock"

echo "Creating S3 bucket: $BUCKET (region $REGION)"
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null \
    || echo "(bucket already exists, skipping)"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" 2>/dev/null \
    || echo "(bucket already exists, skipping)"
fi

aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "Creating DynamoDB table: $TABLE (region $REGION)"
aws dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification "Enabled=true,SSEType=KMS" \
  --region "$REGION" 2>/dev/null \
  || echo "(table already exists, skipping)"

aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"

# If the table already existed without SSE-KMS, enable it now (idempotent).
aws dynamodb update-table \
  --table-name "$TABLE" \
  --sse-specification "Enabled=true,SSEType=KMS" \
  --region "$REGION" 2>/dev/null \
  || true

cat <<EOF

═══════════════════════════════════════════════════════════════
State backend ready.

Initialize Terraform with:

  cd deploy/terraform/environments/dev
  terraform init \\
    -backend-config="bucket=$BUCKET" \\
    -backend-config="key=dev/terraform.tfstate" \\
    -backend-config="region=$REGION" \\
    -backend-config="dynamodb_table=$TABLE" \\
    -backend-config="encrypt=true"
═══════════════════════════════════════════════════════════════
EOF
