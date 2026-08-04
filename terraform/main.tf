# Infrastructure as Code — Cloudflare (Terraform)
# Manages the R2 bucket that stores the RAG source documents.
# Credentials are read from env vars (never hardcoded):
#   CLOUDFLARE_API_TOKEN   → auth
#   TF_VAR_account_id      → your Cloudflare account id

terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

# The provider is configured entirely from the CLOUDFLARE_API_TOKEN env var.
provider "cloudflare" {}

variable "account_id" {
  type        = string
  description = "Cloudflare account ID"
}

# An R2 bucket to hold the original documents fed into the RAG assistant.
resource "cloudflare_r2_bucket" "rag_docs" {
  account_id = var.account_id
  name       = "rag-source-docs"
  location   = "WNAM" # Western North America
}

output "bucket_name" {
  value = cloudflare_r2_bucket.rag_docs.name
}
