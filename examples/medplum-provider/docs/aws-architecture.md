# AWS production architecture

The Medplum server (and, in progress, `litellm` and `lyfe-worker`) runs in
AWS account `050916357269`, region `us-west-1`, replacing the earlier Railway
deployment. Everything here is provisioned by `packages/cdk` — see
`packages/cdk/README.md` for the CDK mechanics and
`packages/cdk/lyfe-medplum-production.json` for this environment's config.
Verified live as of 2026-10-02: ECS task healthy, ALB target healthy,
post-deploy migrations completed, `https://api.medplum.lyfeco.ai/healthcheck`
returns 200.

## Request flow

One delegated Route 53 zone, `medplum.lyfeco.ai` (NS-delegated from the
Namecheap-managed apex `lyfeco.ai`), with three subdomains resolving to three
independent paths. Only one of the three enters the VPC.

```
                              Client browser
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
 provider.medplum.lyfeco.ai   api.medplum.lyfeco.ai   storage.medplum.lyfeco.ai
            │                       │                       │
       CloudFront + WAF        ALB :443 (VPC)          CloudFront + WAF
            │                       │                       │
     S3 · provider.medplum     ECS Fargate            S3 · storage.medplum
       (static build)       medplum-server :8103      (binaries, signed GET)
                                    │         ╲
                         Aurora PG ─┘           ╲─ ElastiCache Redis
                      (FHIR data store)          (cache, rate limits, BullMQ)
```

The provider app and file storage are served straight out of S3 through
CloudFront — the API path is the only one that reaches the VPC. Inside it,
the ALB sits in the public subnet and forwards to Fargate in the private
subnets, which is the single point of contact for Postgres and Redis, and
also writes/reads the storage bucket directly (not through CloudFront).

Fargate also pulls its image from ECR, reads secrets from Secrets Manager,
and invokes Medplum Bots as Lambda functions on FHIR resource events.

## Services in use

| Service | Role | Resource |
|---|---|---|
| Route 53 | DNS zone delegated from Namecheap; holds every record under the subdomain | `medplum.lyfeco.ai` |
| ACM | TLS certs — one in us-east-1 for CloudFront, one in us-west-1 for the ALB | `*.medplum.lyfeco.ai` ×2 |
| VPC | Network isolation — public subnet for load balancers, private subnets for compute and data | 2 AZs, flow logs on |
| ALB | Public HTTPS endpoint for the API, forwards to Fargate on :8103 | `api.medplum.lyfeco.ai` |
| ECS Fargate | Runs the `medplum-server` container — the only thing that talks to the database directly | 1 task · 1 vCPU / 2GB |
| Aurora PostgreSQL | Primary FHIR data store; will also hold the worker's `lyfe_rag` vector schema (LYF2-261) | 1× `db.t4g.medium` |
| ElastiCache Redis | Cache, rate limiting, background job queues (BullMQ) | 1 node |
| S3 | Two buckets — the built provider app, and uploaded/generated binary files | `provider.` / `storage.medplum` |
| CloudFront | CDN in front of both S3 buckets; storage access is signed-URL only | 2 distributions |
| WAF | Web ACLs in front of both CloudFront distributions and the ALB | 3 ACLs |
| ECR | Holds Docker images; Fargate pulls from here on deploy | `lyfe-medplum-server` (+ `lyfe-worker`, LYF2-261) |
| Secrets Manager | DB credentials and the CloudFront signed-URL private key | 3 secrets |
| Lambda | Runs Medplum Bots — custom logic triggered by FHIR resource events | `medplum-bot-*` |
| SSM Parameter Store | Non-secret server configuration | `/medplum/lyfe-medplum/*` |
| CloudWatch | VPC flow logs, container logs, ALB/CloudFront access logs | — |
| SES | Outbound transactional email from the server | — |
| X-Ray | Request tracing for the server | — |

Estimated monthly cost at this sizing: ~$260.

## Deploying

Infra changes go through `packages/cdk` by hand — this is deliberately not
automated (see LYF2-263 for why):

```sh
cd packages/cdk
npx cdk synth -c config=lyfe-medplum-production.json
AWS_PROFILE=lyfe-medplum npx cdk deploy -c config=lyfe-medplum-production.json \
  lyfe-medplum-production-us-east-1 lyfe-medplum-production
```

`packages/cdk/cdk.json` points the CDK CLI at `entry.mjs` rather than
`src/index.ts` directly — `import.meta.main` isn't populated until Node 24,
and the CDK CLI's own subprocess runs on whatever Node the machine has, so on
Node 22 the check never fires and nothing gets synthesized. `entry.mjs` calls
`main()` unconditionally instead.

App-only redeploys (new server image, no infra change) are a Docker build +
ECR push + forced ECS redeploy:

```sh
./scripts/build-docker-server.sh   # -f docker/server.aws.Dockerfile
docker push <account>.dkr.ecr.us-west-1.amazonaws.com/lyfe-medplum-server:latest
aws ecs update-service --cluster <cluster> --service <service> \
  --force-new-deployment --region us-west-1
```

`docker/server.aws.Dockerfile` exists separately from `docker/server.Dockerfile`
because the latter is built on `dhi.io` Docker Hardened Images, which this AWS
account has no entitlement for — the AWS variant uses public `node:24.18-slim`
instead, otherwise identical.

A known gap: `packages/cdk/src/backend.ts` never writes `baseUrl` /
`appBaseUrl` / `storageBaseUrl` to SSM, so a from-scratch stack recreation
needs those three parameters set by hand (`aws ssm put-parameter`) before the
server will start — it crashes on boot with `Missing required config setting:
baseUrl` otherwise. Not yet fixed upstream in this fork.

## In progress — litellm and lyfe-worker (LYF2-261)

Two Railway services predate this migration and haven't moved yet: `litellm`
(a Bedrock proxy) and `lyfe-worker` (the Inngest-orchestrated background job
service for DrChrono/Zus/RAG/AI-summary processing). CDK code for both is
written and `cdk synth`-verified (`packages/cdk/src/lyfe-services.ts`), not
yet deployed.

```
                    (same VPC as above)
 medplum-server ──$ai──▶ litellm (private only, Cloud Map)
      │                        │
      │                        └──────▶ Amazon Bedrock (us-east-1)
      │                                  chat completions
      │
 Aurora PG ◀── embeddings ── lyfe-worker (own public ALB)
 + lyfe_rag                       │    │
   schema (new)                   │    └──▶ Amazon Bedrock (us-east-1, direct — no litellm)
                                   │         Titan embeddings
                                   ├──▶ Textract (OCR)
                                   ├──▶ Inngest Cloud (external SaaS — events out / webhook in)
                                   └──▶ Browser app (bulk import, RAG search)
```

Two design points worth recording, because they weren't obvious going in:

- **litellm is not a parallel implementation to remove.** Medplum's own `$ai`
  operation (`packages/server/src/fhir/operations/ai.ts`) only speaks the
  OpenAI chat-completions wire format, and Medplum's own docs
  (`packages/docs/docs/ai/ai-operation.md`) name a LiteLLM proxy as the
  documented way to route it at Bedrock, via the `LLM_BASE_URL` project
  secret. So this is Medplum's way — it just needs to run in AWS instead of
  Railway. It stays private: reachable only by the Medplum server, over Cloud
  Map private DNS, with no ALB and no public domain.
- **lyfe-worker needs a public ALB; litellm does not.** lyfe-worker registers
  Inngest's classic inbound `serve()` handler (`services/lyfe-worker/src/server.ts`),
  so Inngest Cloud calls **into** `/api/inngest` to invoke each step — this is
  not Inngest Connect's outbound-only mode. It also serves
  `/api/imports/bulk` and `/api/rag/*` directly to the browser app. It does
  **not** go through litellm: embeddings call Bedrock directly via the AWS
  SDK (`services/lyfe-worker/src/rag/bedrock.ts`), already using the SDK's
  default credential chain, so no code change is needed there — only the
  static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` the Railway service
  injects today gets replaced by an IAM task role.
- `RAG_DATABASE_URL` moves onto the **same Aurora cluster** the server
  already uses, not a new database — Aurora PostgreSQL 16.9 supports the
  `vector` extension natively, and the worker self-migrates its `lyfe_rag`
  schema on startup.
- Bedrock's calling region (`us-east-1`, matching the cross-region inference
  profile Railway used) is independent of the compute region (`us-west-1`) —
  both services reach it over the internet gateway already in the VPC; the
  compute doesn't need to run in a region where Bedrock itself is available.

See LYF2-261 for the remaining provisioning steps (ACM cert, Secrets Manager
blob, ECR repo + image build, `lyfe_rag` DB user).
