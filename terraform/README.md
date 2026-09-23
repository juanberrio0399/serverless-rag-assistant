# Terraform — R2 bucket for source documents

`main.tf` declares one resource: the `rag-source-docs` R2 bucket meant to hold the original files
fed to the assistant.

**This is not wired into the Worker.** `wrangler.jsonc` has no R2 binding and `src/` never reads or
writes the bucket — the Worker keeps chunk text in Vectorize metadata and nothing else. The bucket
exists so the storage layer is provisioned the same way the rest of the infrastructure is, ahead of
the code that will use it.

The rest of the project's infrastructure (Worker, Workers AI, Vectorize, D1, Workflows, rate
limiting) is declared in `wrangler.jsonc`, not here. Two tools, because Wrangler is the only one
that can bind Workers AI and Vectorize to a Worker, while R2 buckets are plain resources Terraform
handles well.

## What is in `main.tf`

| Block | What it does |
|---|---|
| `terraform { required_providers … }` | Pins the Cloudflare provider to v5.x and Terraform to 1.5+ |
| `provider "cloudflare" {}` | Configured entirely from the `CLOUDFLARE_API_TOKEN` environment variable, so no credential is ever written to a file |
| `variable "account_id"` | Supplied as `TF_VAR_account_id`, for the same reason |
| `resource "cloudflare_r2_bucket" "rag_docs"` | The bucket, in `WNAM` (Western North America) |
| `output "bucket_name"` | Prints the bucket name after apply |

## Running it

```bash
export CLOUDFLARE_API_TOKEN="<token>"     # auth, env var only
export TF_VAR_account_id="<account id>"

terraform init       # download the Cloudflare provider
terraform validate   # check the config; needs no credentials
terraform plan       # preview, creates nothing
terraform apply
terraform destroy
```

The token needs the **Workers R2 Storage: Edit** permission on the account. `terraform validate`
passes without any credentials at all, which is what makes this folder safe to check in CI.

State is local and gitignored. There is no remote backend: one bucket, one operator, so the
coordination a remote state buys is not worth its setup here. That changes the moment a second
person runs `apply`.
