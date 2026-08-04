# Infrastructure as Code (Terraform)

This folder manages the project's Cloudflare infrastructure **as code** with Terraform,
instead of clicking around a dashboard. Editing a file here = changing the cloud.

## What `main.tf` contains

| Block | What it does |
|---|---|
| `terraform { required_providers ... }` | Declares which cloud provider to use (Cloudflare) and its version. |
| `provider "cloudflare" {}` | The connection to Cloudflare. The API token is read from the `CLOUDFLARE_API_TOKEN` environment variable — **never hardcoded**. |
| `variable "account_id"` | An input so the account ID isn't hardcoded either. |
| `resource "cloudflare_r2_bucket" "rag_docs"` | The thing we want to exist: an R2 bucket to store the RAG source documents. |
| `output "bucket_name"` | Prints a useful value after applying. |

## How to use it

```bash
export CLOUDFLARE_API_TOKEN="<your-token>"     # auth (env var, not in code)
export TF_VAR_account_id="<your-account-id>"

terraform init       # download the Cloudflare provider
terraform validate   # check the config is correct (no credentials needed)
terraform plan       # preview WHAT would change (creates nothing)
terraform apply      # actually create/update the infrastructure
terraform destroy    # tear it down
```

## Why this matters

Infrastructure as Code is **repeatable, version-controlled (git), and reviewable** — the standard
for cloud/infrastructure roles. `terraform validate` on this config returns *"Success! The configuration is valid."*
