// Phase 2.5++ / WI-15 — the static service catalog.
//
// The closed set of services a project may pin as its committed stack. Shape
// mirrors `ROLE_CATALOG` (lib/roles/catalog.ts): a flat, hand-maintained array
// of typed entries with a stable machine key, a display label, a coarse UI
// grouping, and a one-line purpose used both as the picker tooltip and as the
// prompt-side reasoning cue.
//
// Two consumers:
//
//   1. `components/stack/StackTagPicker.tsx` — groups by provider and renders
//      one tick-box per entry.
//   2. `lib/stack/detect-stack-tags.ts` — the import-time detector. It matches
//      the `fingerprints` below against a fixed list of manifest files fetched
//      from the repo and emits ONLY keys that exist here.
//
// Why the catalog is the detector's allow-list (load-bearing, AGENTS.md
// principle 6): a detected tag is derived from ATTACKER-CONTROLLED repo
// content, and it flows into the strongest position in the plan prompt. The
// detector therefore never emits a string it read from a file — it emits a
// catalog KEY, and the `label`/`purpose` that reach the model come from this
// file. A fingerprint that matches nothing here is discarded, so the worst a
// malicious repo can do is get a legitimate service mis-ticked, which the
// operator sees and unticks in the form before anything is saved.
//
// Fingerprints are lowercase SUBSTRINGS, matched against the lowercased file
// body. Deliberately not a dependency-graph parse: lockfiles are multi-MB and
// pulling in an HCL/YAML/lockfile parser to read untrusted content would be a
// far bigger attack surface than the false-positive rate we accept here. The
// detector only scans manifest files (never prose like the README), so a
// substring hit is a strong signal.

import type { StackProvider } from "@/lib/plan/types";
import type { CapabilityKey } from "@/lib/stack/capabilities";

/**
 * Free-tier posture. CURATED STATIC DATA — deliberately not a live pricing API
 * (WI-15 rejected live cloud enumeration for cost, latency, and untrusted-data
 * reasons; that reasoning is unchanged here). `note` is a coarse, hand-written
 * sentence and must never quote a moving-target dollar price — capability
 * ceilings ("5 GB", "50k MAU", "1M requests/mo") move on a scale of years,
 * prices on a scale of quarters. `verifiedOn` makes staleness visible and is
 * asserted by a test (see `__tests__/service-catalog.test.ts`).
 */
export type FreeTier =
  | { kind: "none" }
  | { kind: "free_forever"; note: string } // self-hosted OSS, or a genuine always-free tier
  | { kind: "limited_free"; note: string } // a real free plan with a hard cap
  | { kind: "trial_credits"; note: string }; // time-boxed credits on signup

export type ServiceCatalogEntry = {
  /** Stable machine key. Persisted in `project_stack_tags.service_key`. */
  key: string;
  displayName: string;
  provider: StackProvider;
  /** One-line purpose — the picker tooltip and the prompt's reasoning cue. */
  purpose: string;
  /**
   * Lowercase substrings that, when found in a scanned manifest file, imply
   * this service. Empty means "manual-only" — pickable, never auto-detected.
   */
  fingerprints: string[];

  // ─── Stack advisor (extends the WI-15 catalog) ───────────────────────
  /**
   * Which capability slots this service can fill. Usually one. A platform
   * like Supabase legitimately fills several (relational_db, auth,
   * object_storage, realtime). Empty means "pickable via the manual picker
   * only" — this service has no advisor row (e.g. Terraform: IaC choice is a
   * preference, not an ecosystem-coherence question).
   */
  capabilities: readonly CapabilityKey[];
  /**
   * Within a (capability, provider) bucket: 0 = the canonical/native pick,
   * 1+ = also-rans. The one editorial judgement call in the catalog. A
   * multi-capability entry carries a single rank reused across every bucket
   * it participates in — that number need not be 0 in every one of those
   * buckets, only distinct from any other entry sharing a bucket with it.
   */
  rank: number;
  freeTier: FreeTier;
  /** Month the freeTier note was last checked, "YYYY-MM". Asserted by a test. */
  verifiedOn: string;
  /**
   * Fully-managed SaaS vs something the operator runs. Drives a UI chip and
   * the "self-hosted, no vendor bill" reasoning line. A service can sit in
   * the `oss` provider bucket and still be `managed: true` (Supabase,
   * Pinecone, Clerk) — `oss` means "not one of the three hyperscalers", not
   * "open source"; `managed` is what actually carries that distinction.
   */
  managed: boolean;
};

/** Display order + section header for each provider bucket in the picker. */
export const STACK_PROVIDERS: ReadonlyArray<{ provider: StackProvider; displayName: string }> = [
  { provider: "oss", displayName: "Open source / self-hosted" },
  { provider: "aws", displayName: "AWS" },
  { provider: "gcp", displayName: "Google Cloud" },
  { provider: "azure", displayName: "Azure" },
];

export const SERVICE_CATALOG: ServiceCatalogEntry[] = [
  // ─── OSS / self-hostable primitives ──────────────────────────────────
  {
    key: "postgres",
    displayName: "PostgreSQL",
    provider: "oss",
    purpose: "Primary relational datastore",
    fingerprints: ["postgres", "postgresql", '"pg"', "psycopg", "pgx", "lib/pq", "jdbc:postgresql"],
    capabilities: ["relational_db"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "mysql",
    displayName: "MySQL / MariaDB",
    provider: "oss",
    purpose: "Relational datastore",
    fingerprints: ["mysql", "mariadb"],
    capabilities: ["relational_db"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "redis",
    displayName: "Redis",
    provider: "oss",
    purpose: "Cache, queue, and distributed locks",
    fingerprints: ["redis", "ioredis"],
    capabilities: ["cache", "queue"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "mongodb",
    displayName: "MongoDB",
    provider: "oss",
    purpose: "Document datastore",
    fingerprints: ["mongodb", "mongoose", "pymongo"],
    capabilities: ["document_db"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "clickhouse",
    displayName: "ClickHouse",
    provider: "oss",
    purpose: "Columnar analytics datastore",
    fingerprints: ["clickhouse"],
    capabilities: ["analytics_warehouse"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "elasticsearch",
    displayName: "Elasticsearch / OpenSearch",
    provider: "oss",
    purpose: "Full-text search and log indexing",
    fingerprints: ["elasticsearch", "opensearch"],
    capabilities: ["search"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "kafka",
    displayName: "Apache Kafka",
    provider: "oss",
    purpose: "Durable event streaming backbone",
    fingerprints: ["kafka", "kafkajs", "confluentinc"],
    capabilities: ["event_stream"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "rabbitmq",
    displayName: "RabbitMQ",
    provider: "oss",
    purpose: "Message broker for task queues",
    fingerprints: ["rabbitmq", "amqplib", "amqp"],
    capabilities: ["queue"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "supabase",
    displayName: "Supabase",
    provider: "oss",
    purpose: "Postgres + auth + realtime + storage as one platform",
    fingerprints: ["supabase"],
    // Multi-capability: a single rank (1) is reused across every bucket this
    // entry participates in. See the `rank` field doc for why that number
    // need not be 0 in every one of those buckets.
    capabilities: ["relational_db", "auth", "object_storage", "realtime"],
    rank: 1,
    freeTier: {
      kind: "limited_free",
      note: "Free project: 500 MB database, pauses after a week idle",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "docker",
    displayName: "Docker",
    provider: "oss",
    purpose: "Container image build + local runtime",
    fingerprints: ["dockerfile", "docker-compose", "docker.io"],
    capabilities: ["compute_container"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "kubernetes",
    displayName: "Kubernetes",
    provider: "oss",
    purpose: "Container orchestration and rollout",
    fingerprints: ["kubernetes", "kubectl", "helm", "k8s.io"],
    capabilities: ["compute_container"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "terraform",
    displayName: "Terraform",
    provider: "oss",
    purpose: "Infrastructure as code",
    fingerprints: ["terraform", 'resource "', "hashicorp/"],
    // No capability slot on purpose — IaC choice (Terraform vs Pulumi) is a
    // preference, not an ecosystem-coherence question. Manual-picker only.
    capabilities: [],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "nginx",
    displayName: "nginx",
    provider: "oss",
    purpose: "Reverse proxy / ingress / static serving",
    fingerprints: ["nginx"],
    // No capability slot — a reverse proxy isn't the `cdn` capability
    // (edge delivery close to users); manual-picker only.
    capabilities: [],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "prometheus",
    displayName: "Prometheus",
    provider: "oss",
    purpose: "Metrics scraping and alerting",
    fingerprints: ["prometheus", "prom-client"],
    capabilities: ["observability"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "grafana",
    displayName: "Grafana",
    provider: "oss",
    purpose: "Metrics + log dashboards",
    fingerprints: ["grafana"],
    capabilities: ["observability"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Open source; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "minio",
    displayName: "MinIO",
    provider: "oss",
    purpose: "Self-hosted S3-compatible object storage",
    fingerprints: ["minio"],
    capabilities: ["object_storage"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted, S3-compatible; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },

  // ─── AWS ──────────────────────────────────────────────────────────────
  {
    key: "aws_s3",
    displayName: "Amazon S3",
    provider: "aws",
    purpose: "Object storage for blobs, uploads, and backups",
    fingerprints: ["client-s3", "aws-sdk/s3", "aws_s3_bucket", "boto3", "amazonaws.com/s3"],
    capabilities: ["object_storage"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: 5 GB standard storage" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_rds_postgres",
    displayName: "Amazon RDS (Postgres)",
    provider: "aws",
    purpose: "Managed relational database",
    fingerprints: ["aws_db_instance", "aws_rds_cluster", "rds.amazonaws.com"],
    capabilities: ["relational_db"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: db.t4g.micro, 20 GB" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_dynamodb",
    displayName: "Amazon DynamoDB",
    provider: "aws",
    purpose: "Managed key-value / document store",
    fingerprints: ["client-dynamodb", "dynamodb", "aws_dynamodb_table"],
    capabilities: ["document_db"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 25 GB storage plus 25 provisioned WCU/RCU",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_lambda",
    displayName: "AWS Lambda",
    provider: "aws",
    purpose: "Serverless function compute",
    fingerprints: ["aws-lambda", "aws_lambda_function", "client-lambda", "serverless-framework"],
    capabilities: ["compute_serverless"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 1M requests and 400,000 GB-seconds per month",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_sqs",
    displayName: "Amazon SQS",
    provider: "aws",
    purpose: "Managed message queue",
    fingerprints: ["client-sqs", "aws_sqs_queue"],
    capabilities: ["queue"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Always-free: 1M requests per month" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_ecs",
    displayName: "Amazon ECS / Fargate",
    provider: "aws",
    purpose: "Managed container runtime",
    fingerprints: ["aws_ecs_service", "aws_ecs_cluster", "aws_ecs_task_definition"],
    capabilities: ["compute_container"],
    rank: 0,
    // ECS itself has no separate charge, but Fargate/EC2 compute is billed
    // from the first task — no standalone free tier to point at.
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_cloudfront",
    displayName: "Amazon CloudFront",
    provider: "aws",
    purpose: "CDN and edge caching",
    fingerprints: ["cloudfront", "aws_cloudfront_distribution"],
    capabilities: ["cdn"],
    rank: 0,
    freeTier: {
      kind: "limited_free",
      note: "12-month free tier: 1 TB data transfer out per month",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_cognito",
    displayName: "Amazon Cognito",
    provider: "aws",
    purpose: "Managed user auth and identity pools",
    fingerprints: ["cognito", "aws_cognito_user_pool"],
    capabilities: ["auth"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Always-free: 50k monthly active users" },
    verifiedOn: "2026-07",
    managed: true,
  },

  // ─── GCP ──────────────────────────────────────────────────────────────
  {
    key: "gcp_cloud_storage",
    displayName: "Google Cloud Storage",
    provider: "gcp",
    purpose: "Object storage for blobs, uploads, and backups",
    fingerprints: [
      "@google-cloud/storage",
      "google-cloud-storage",
      "google_storage_bucket",
      "storage.googleapis.com",
    ],
    capabilities: ["object_storage"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 5 GB-months in select US regions",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_run",
    displayName: "Google Cloud Run",
    provider: "gcp",
    purpose: "Serverless container runtime",
    fingerprints: ["cloud-run", "google_cloud_run_service", "run.googleapis.com"],
    // Genuinely both: a scale-to-zero runtime that runs container images —
    // the one entry in this catalog that legitimately fills two buckets on
    // the compute axis.
    capabilities: ["compute_serverless", "compute_container"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Always-free: 2M requests per month" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_sql",
    displayName: "Google Cloud SQL",
    provider: "gcp",
    purpose: "Managed relational database",
    fingerprints: ["cloud-sql", "google_sql_database_instance", "cloudsql"],
    capabilities: ["relational_db"],
    rank: 0,
    freeTier: {
      kind: "trial_credits",
      note: "Covered by the new-account trial credit; no standalone always-free tier",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_firestore",
    displayName: "Google Firestore",
    provider: "gcp",
    purpose: "Managed document store",
    fingerprints: ["firestore", "firebase-admin"],
    capabilities: ["document_db"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 1 GiB storage, 50k reads per day",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_pubsub",
    displayName: "Google Pub/Sub",
    provider: "gcp",
    purpose: "Managed event bus",
    fingerprints: ["@google-cloud/pubsub", "google_pubsub_topic"],
    capabilities: ["event_stream"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Always-free: 10 GB per month" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_bigquery",
    displayName: "Google BigQuery",
    provider: "gcp",
    purpose: "Analytics warehouse",
    fingerprints: ["bigquery", "google_bigquery_dataset"],
    capabilities: ["analytics_warehouse"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 1 TB of queries and 10 GB storage per month",
    },
    verifiedOn: "2026-07",
    managed: true,
  },

  // ─── Azure ────────────────────────────────────────────────────────────
  {
    key: "azure_blob_storage",
    displayName: "Azure Blob Storage",
    provider: "azure",
    purpose: "Object storage for blobs, uploads, and backups",
    fingerprints: [
      "@azure/storage-blob",
      "azurerm_storage_account",
      "azure-storage-blob",
      "blob.core.windows.net",
    ],
    capabilities: ["object_storage"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: 5 GB LRS hot storage" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_functions",
    displayName: "Azure Functions",
    provider: "azure",
    purpose: "Serverless function compute",
    fingerprints: ["@azure/functions", "azurerm_function_app", "azure-functions"],
    capabilities: ["compute_serverless"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Always-free: 1M executions per month" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_app_service",
    displayName: "Azure App Service",
    provider: "azure",
    purpose: "Managed web-app hosting",
    fingerprints: ["azurerm_app_service", "azurerm_linux_web_app"],
    capabilities: ["compute_container"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free F1 tier: 60 CPU-minutes per day" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_cosmos_db",
    displayName: "Azure Cosmos DB",
    provider: "azure",
    purpose: "Managed multi-model document store",
    fingerprints: ["@azure/cosmos", "cosmosdb", "azurerm_cosmosdb_account"],
    capabilities: ["document_db"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Always-free: 1000 RU/s and 25 GB storage",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_postgres",
    displayName: "Azure Database for PostgreSQL",
    provider: "azure",
    purpose: "Managed relational database",
    fingerprints: ["azurerm_postgresql_server", "azurerm_postgresql_flexible_server"],
    capabilities: ["relational_db"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: B1MS, 32 GB" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_service_bus",
    displayName: "Azure Service Bus",
    provider: "azure",
    purpose: "Managed message broker",
    fingerprints: ["@azure/service-bus", "azurerm_servicebus_namespace"],
    capabilities: ["queue"],
    rank: 0,
    // Basic tier is low-cost, not free — no standalone free tier.
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },

  // ─── OSS / self-hostable primitives (Stage 6 additions) ───────────
  {
    key: "couchdb",
    displayName: "Apache CouchDB",
    provider: "oss",
    purpose: "Replicating document datastore with an HTTP API",
    fingerprints: [],
    capabilities: ["document_db"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "pgvector",
    displayName: "pgvector (Postgres)",
    provider: "oss",
    purpose: "Vector similarity search inside Postgres",
    fingerprints: [],
    capabilities: ["vector_db"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted Postgres extension; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "qdrant",
    displayName: "Qdrant",
    provider: "oss",
    purpose: "Dedicated vector database for embedding search",
    fingerprints: [],
    capabilities: ["vector_db"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "weaviate",
    displayName: "Weaviate",
    provider: "oss",
    purpose: "Vector database with built-in hybrid search",
    fingerprints: [],
    capabilities: ["vector_db"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "valkey",
    displayName: "Valkey",
    provider: "oss",
    purpose: "In-memory cache and data-structure store (Redis fork)",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "memcached",
    displayName: "Memcached",
    provider: "oss",
    purpose: "Simple in-memory key-value cache",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "ceph",
    displayName: "Ceph",
    provider: "oss",
    purpose: "Distributed S3-compatible object storage",
    fingerprints: [],
    capabilities: ["object_storage"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "nats",
    displayName: "NATS / JetStream",
    provider: "oss",
    purpose: "Lightweight messaging: work queues and replayable streams",
    fingerprints: [],
    capabilities: ["queue", "event_stream"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "pulsar",
    displayName: "Apache Pulsar",
    provider: "oss",
    purpose: "Distributed pub-sub and durable event streaming",
    fingerprints: [],
    capabilities: ["event_stream"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "centrifugo",
    displayName: "Centrifugo",
    provider: "oss",
    purpose: "Realtime messaging / websocket push server",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "soketi",
    displayName: "Soketi",
    provider: "oss",
    purpose: "Pusher-compatible websocket server for realtime push",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "keycloak",
    displayName: "Keycloak",
    provider: "oss",
    purpose: "Self-hosted identity, SSO, and OAuth/OIDC provider",
    fingerprints: [],
    capabilities: ["auth"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "authentik",
    displayName: "authentik",
    provider: "oss",
    purpose: "Self-hosted identity provider and SSO",
    fingerprints: [],
    capabilities: ["auth"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "ollama",
    displayName: "Ollama",
    provider: "oss",
    purpose: "Run local LLMs behind a simple HTTP API",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; GPU/infra cost only, no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "vllm",
    displayName: "vLLM",
    provider: "oss",
    purpose: "High-throughput self-hosted LLM inference server",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; GPU/infra cost only, no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "localai",
    displayName: "LocalAI",
    provider: "oss",
    purpose: "OpenAI-compatible local model inference",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; GPU/infra cost only, no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "meilisearch",
    displayName: "Meilisearch",
    provider: "oss",
    purpose: "Typo-tolerant instant full-text search",
    fingerprints: [],
    capabilities: ["search"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "typesense",
    displayName: "Typesense",
    provider: "oss",
    purpose: "Fast typo-tolerant search engine",
    fingerprints: [],
    capabilities: ["search"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "postal",
    displayName: "Postal",
    provider: "oss",
    purpose: "Self-hosted transactional / outbound mail server",
    fingerprints: [],
    capabilities: ["email"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Self-hosted; infra + deliverability setup cost only, no vendor bill",
    },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "haraka",
    displayName: "Haraka",
    provider: "oss",
    purpose: "High-performance SMTP server for outbound email",
    fingerprints: [],
    capabilities: ["email"],
    rank: 1,
    freeTier: {
      kind: "free_forever",
      note: "Self-hosted; infra + deliverability setup cost only, no vendor bill",
    },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "varnish",
    displayName: "Varnish Cache",
    provider: "oss",
    purpose: "HTTP caching accelerator for edge asset delivery",
    fingerprints: [],
    capabilities: ["cdn"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "apache_traffic_server",
    displayName: "Apache Traffic Server",
    provider: "oss",
    purpose: "Caching proxy server for building edge delivery",
    fingerprints: [],
    capabilities: ["cdn"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "openfaas",
    displayName: "OpenFaaS",
    provider: "oss",
    purpose: "Serverless functions on containers/Kubernetes",
    fingerprints: [],
    capabilities: ["compute_serverless"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "knative",
    displayName: "Knative",
    provider: "oss",
    purpose: "Kubernetes-based scale-to-zero serverless runtime",
    fingerprints: [],
    capabilities: ["compute_serverless"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "openwhisk",
    displayName: "Apache OpenWhisk",
    provider: "oss",
    purpose: "Event-driven serverless functions platform",
    fingerprints: [],
    capabilities: ["compute_serverless"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "podman",
    displayName: "Podman",
    provider: "oss",
    purpose: "Daemonless container engine and runtime",
    fingerprints: [],
    capabilities: ["compute_container"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "signoz",
    displayName: "SigNoz",
    provider: "oss",
    purpose: "OpenTelemetry-native metrics, logs, and traces",
    fingerprints: [],
    capabilities: ["observability"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "sentry",
    displayName: "Sentry (self-hosted)",
    provider: "oss",
    purpose: "Exception capture, grouping, and release alerts",
    fingerprints: [],
    capabilities: ["error_tracking"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "glitchtip",
    displayName: "GlitchTip",
    provider: "oss",
    purpose: "Lightweight Sentry-compatible error tracking",
    fingerprints: [],
    capabilities: ["error_tracking"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "vault",
    displayName: "HashiCorp Vault",
    provider: "oss",
    purpose: "Secrets storage, dynamic credentials, and rotation",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "infisical",
    displayName: "Infisical",
    provider: "oss",
    purpose: "Open-source secrets management and sync",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "jenkins",
    displayName: "Jenkins",
    provider: "oss",
    purpose: "Extensible build/test/deploy automation server",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 0,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "woodpecker",
    displayName: "Woodpecker CI",
    provider: "oss",
    purpose: "Container-native CI pipelines",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "argocd",
    displayName: "Argo CD",
    provider: "oss",
    purpose: "GitOps continuous delivery for Kubernetes",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "duckdb",
    displayName: "DuckDB",
    provider: "oss",
    purpose: "Embedded columnar OLAP analytics engine",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },
  {
    key: "druid",
    displayName: "Apache Druid",
    provider: "oss",
    purpose: "Real-time columnar analytics datastore",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 2,
    freeTier: { kind: "free_forever", note: "Self-hosted; no vendor bill" },
    verifiedOn: "2026-07",
    managed: false,
  },

  // ─── AWS (Stage 6 additions) ──────────────────────────────────────
  {
    key: "aws_aurora",
    displayName: "Amazon Aurora",
    provider: "aws",
    purpose: "Managed high-throughput relational database",
    fingerprints: [],
    capabilities: ["relational_db"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_documentdb",
    displayName: "Amazon DocumentDB",
    provider: "aws",
    purpose: "Managed MongoDB-compatible document store",
    fingerprints: [],
    capabilities: ["document_db"],
    rank: 1,
    freeTier: { kind: "trial_credits", note: "1-month free trial: 750 t3.medium hrs/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_opensearch",
    displayName: "Amazon OpenSearch Service",
    provider: "aws",
    purpose: "Full-text and vector similarity search over documents",
    fingerprints: [],
    capabilities: ["search", "vector_db"],
    rank: 0,
    freeTier: {
      kind: "limited_free",
      note: "12-month free tier: 750 t3.small.search hrs/mo + 10 GB",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_elasticache",
    displayName: "Amazon ElastiCache",
    provider: "aws",
    purpose: "Managed Redis / Memcached cache and session store",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: 750 cache.t3.micro hrs/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_memorydb",
    displayName: "Amazon MemoryDB",
    provider: "aws",
    purpose: "Durable Redis-compatible in-memory store",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_kinesis",
    displayName: "Amazon Kinesis Data Streams",
    provider: "aws",
    purpose: "Ordered, replayable event stream",
    fingerprints: [],
    capabilities: ["event_stream"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_msk",
    displayName: "Amazon MSK (Managed Kafka)",
    provider: "aws",
    purpose: "Managed Apache Kafka event streaming",
    fingerprints: [],
    capabilities: ["event_stream"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_appsync",
    displayName: "AWS AppSync",
    provider: "aws",
    purpose: "Managed realtime GraphQL subscriptions and server push",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 0,
    freeTier: {
      kind: "limited_free",
      note: "12-month free tier: 250k query + 250k realtime ops/mo",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_bedrock",
    displayName: "Amazon Bedrock",
    provider: "aws",
    purpose: "Managed foundation-model and embedding inference",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_ses",
    displayName: "Amazon SES",
    provider: "aws",
    purpose: "Transactional and bulk outbound email",
    fingerprints: [],
    capabilities: ["email"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "12-month free tier: 3,000 messages/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_cloudwatch",
    displayName: "Amazon CloudWatch",
    provider: "aws",
    purpose: "Metrics, logs, dashboards, and alarms",
    fingerprints: [],
    capabilities: ["observability"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Always-free: 10 metrics, 10 alarms, 5 GB logs/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_xray",
    displayName: "AWS X-Ray",
    provider: "aws",
    purpose: "Distributed tracing across services",
    fingerprints: [],
    capabilities: ["observability"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Always-free: 100k traces recorded/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_secrets_manager",
    displayName: "AWS Secrets Manager",
    provider: "aws",
    purpose: "Runtime secret storage with rotation",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 0,
    freeTier: { kind: "trial_credits", note: "30-day free trial per secret" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_ssm_parameter_store",
    displayName: "AWS Systems Manager Parameter Store",
    provider: "aws",
    purpose: "Config and secret parameter storage",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 1,
    freeTier: { kind: "free_forever", note: "Always-free: standard parameters, no charge" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_codepipeline",
    displayName: "AWS CodePipeline",
    provider: "aws",
    purpose: "Build/test/deploy pipeline orchestration",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Always-free: 1 active V1 pipeline/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_codebuild",
    displayName: "AWS CodeBuild",
    provider: "aws",
    purpose: "Managed build and test execution",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Always-free: 100 build minutes/mo (general1.small)" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_redshift",
    displayName: "Amazon Redshift",
    provider: "aws",
    purpose: "Columnar analytics warehouse",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 0,
    freeTier: { kind: "trial_credits", note: "2-month free trial: 750 DC2.Large hrs/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_athena",
    displayName: "Amazon Athena",
    provider: "aws",
    purpose: "Serverless SQL analytics over S3 data",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_eks",
    displayName: "Amazon EKS",
    provider: "aws",
    purpose: "Managed Kubernetes container runtime",
    fingerprints: [],
    capabilities: ["compute_container"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "aws_app_runner",
    displayName: "AWS App Runner",
    provider: "aws",
    purpose: "Fully-managed container web-app runtime",
    fingerprints: [],
    capabilities: ["compute_container"],
    rank: 2,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },

  // ─── GCP (Stage 6 additions) ──────────────────────────────────────
  {
    key: "gcp_alloydb",
    displayName: "Google AlloyDB for PostgreSQL",
    provider: "gcp",
    purpose: "PostgreSQL-compatible relational database for demanding workloads",
    fingerprints: [],
    capabilities: ["relational_db"],
    rank: 1,
    freeTier: {
      kind: "trial_credits",
      note: "Covered by the new-account trial credit; no standalone always-free tier",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_spanner",
    displayName: "Google Cloud Spanner",
    provider: "gcp",
    purpose: "Horizontally-scalable, strongly-consistent relational database",
    fingerprints: [],
    capabilities: ["relational_db"],
    rank: 2,
    freeTier: {
      kind: "trial_credits",
      note: "90-day free trial instance (~10 GB); verify standalone free tier",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_bigtable",
    displayName: "Google Cloud Bigtable",
    provider: "gcp",
    purpose: "Wide-column NoSQL store for high-throughput key-value workloads",
    fingerprints: [],
    capabilities: ["document_db"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_vertex_vector_search",
    displayName: "Vertex AI Vector Search",
    provider: "gcp",
    purpose: "Managed embedding storage + similarity search for RAG/semantic features",
    fingerprints: [],
    capabilities: ["vector_db"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_memorystore_redis",
    displayName: "Google Memorystore for Redis",
    provider: "gcp",
    purpose: "Managed Redis for cache, session store, and distributed locks",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_tasks",
    displayName: "Google Cloud Tasks",
    provider: "gcp",
    purpose: "Managed task queue for async work handoff with retries",
    fingerprints: [],
    capabilities: ["queue"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: 1M operations/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_firebase_realtime_db",
    displayName: "Firebase Realtime Database",
    provider: "gcp",
    purpose: "Realtime sync store for presence, live updates, and collaborative state",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 0,
    freeTier: {
      kind: "limited_free",
      note: "Free (Spark plan): 1 GB stored, 100 simultaneous connections",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_identity_platform",
    displayName: "Google Cloud Identity Platform",
    provider: "gcp",
    purpose: "Managed user sign-in, sessions, tokens, and social/SSO providers",
    fingerprints: [],
    capabilities: ["auth"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: 50k MAU/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_vertex_ai",
    displayName: "Vertex AI (Gemini)",
    provider: "gcp",
    purpose: "Hosted Gemini and embedding model inference",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 0,
    freeTier: {
      kind: "trial_credits",
      note: "Covered by the new-account trial credit; no standalone always-free tier",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_vertex_ai_search",
    displayName: "Vertex AI Search",
    provider: "gcp",
    purpose: "Managed full-text and semantic search over documents",
    fingerprints: [],
    capabilities: ["search"],
    rank: 0,
    freeTier: {
      kind: "trial_credits",
      note: "Covered by the new-account trial credit; verify monthly query quota",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_cdn",
    displayName: "Google Cloud CDN",
    provider: "gcp",
    purpose: "CDN and edge caching for static assets and media",
    fingerprints: [],
    capabilities: ["cdn"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_functions",
    displayName: "Google Cloud Functions",
    provider: "gcp",
    purpose: "Event-driven, scale-to-zero serverless function compute",
    fingerprints: [],
    capabilities: ["compute_serverless"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Free: 2M invocations/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_gke",
    displayName: "Google Kubernetes Engine",
    provider: "gcp",
    purpose: "Managed Kubernetes container orchestration and rollout",
    fingerprints: [],
    capabilities: ["compute_container"],
    rank: 1,
    freeTier: {
      kind: "limited_free",
      note: "1 zonal/Autopilot cluster management free; node compute billed separately",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_monitoring",
    displayName: "Google Cloud Observability",
    provider: "gcp",
    purpose: "Metrics, logs, dashboards, alerting, and distributed tracing",
    fingerprints: [],
    capabilities: ["observability"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: all GCP metrics + 50 GiB logs/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_error_reporting",
    displayName: "Google Cloud Error Reporting",
    provider: "gcp",
    purpose: "Exception capture, grouping, and release regression alerts",
    fingerprints: [],
    capabilities: ["error_tracking"],
    rank: 0,
    freeTier: {
      kind: "free_forever",
      note: "Included with Cloud Observability; no separate charge",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_secret_manager",
    displayName: "Google Secret Manager",
    provider: "gcp",
    purpose: "Runtime storage, versioning, and rotation of credentials",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: 6 active secret versions + 10k access ops/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "gcp_cloud_build",
    displayName: "Google Cloud Build",
    provider: "gcp",
    purpose: "Managed build, test, and deploy pipeline",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: 2,500 build-minutes/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },

  // ─── Azure (Stage 6 additions) ────────────────────────────────────
  {
    key: "azure_sql_database",
    displayName: "Azure SQL Database",
    provider: "azure",
    purpose: "Managed SQL Server relational database",
    fingerprints: [],
    capabilities: ["relational_db"],
    rank: 1,
    freeTier: {
      kind: "limited_free",
      note: "Free serverless offer: 100k vCore-seconds + 32 GB/mo",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_mysql",
    displayName: "Azure Database for MySQL",
    provider: "azure",
    purpose: "Managed MySQL relational database",
    fingerprints: [],
    capabilities: ["relational_db"],
    rank: 2,
    freeTier: { kind: "limited_free", note: "12-month free: B1MS + 32 GB" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_table_storage",
    displayName: "Azure Table Storage",
    provider: "azure",
    purpose: "Managed NoSQL key-value store",
    fingerprints: [],
    capabilities: ["document_db"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_ai_search",
    displayName: "Azure AI Search",
    provider: "azure",
    purpose: "Full-text and vector search over documents",
    fingerprints: [],
    capabilities: ["search", "vector_db"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free tier: 50 MB, 3 indexes (shared)" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_cache_redis",
    displayName: "Azure Cache for Redis",
    provider: "azure",
    purpose: "Managed Redis cache, session store, and locks",
    fingerprints: [],
    capabilities: ["cache"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_storage_queue",
    displayName: "Azure Queue Storage",
    provider: "azure",
    purpose: "Simple managed message queue",
    fingerprints: [],
    capabilities: ["queue"],
    rank: 1,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_event_hubs",
    displayName: "Azure Event Hubs",
    provider: "azure",
    purpose: "Kafka-compatible event streaming ingest",
    fingerprints: [],
    capabilities: ["event_stream"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_web_pubsub",
    displayName: "Azure Web PubSub",
    provider: "azure",
    purpose: "Managed WebSocket pub/sub for realtime push",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free tier: 20 concurrent connections, 20k msgs/day" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_signalr",
    displayName: "Azure SignalR Service",
    provider: "azure",
    purpose: "Managed realtime push for SignalR apps",
    fingerprints: [],
    capabilities: ["realtime"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Free tier: 20 concurrent connections, 20k msgs/day" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_entra_external_id",
    displayName: "Microsoft Entra External ID",
    provider: "azure",
    purpose: "Managed customer identity, sign-in, and SSO",
    fingerprints: [],
    capabilities: ["auth"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: first 50k monthly active users" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_openai",
    displayName: "Azure OpenAI Service",
    provider: "azure",
    purpose: "Hosted GPT and embedding model inference",
    fingerprints: [],
    capabilities: ["llm_inference"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_communication_email",
    displayName: "Azure Communication Services Email",
    provider: "azure",
    purpose: "Transactional outbound email",
    fingerprints: [],
    capabilities: ["email"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_front_door",
    displayName: "Azure Front Door",
    provider: "azure",
    purpose: "Global CDN and edge delivery",
    fingerprints: [],
    capabilities: ["cdn"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_container_apps",
    displayName: "Azure Container Apps",
    provider: "azure",
    purpose: "Serverless container runtime that scales to zero",
    fingerprints: [],
    capabilities: ["compute_serverless", "compute_container"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Always-free: 180k vCPU-s, 360k GiB-s, 2M req/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_aks",
    displayName: "Azure Kubernetes Service",
    provider: "azure",
    purpose: "Managed Kubernetes orchestration",
    fingerprints: [],
    capabilities: ["compute_container"],
    rank: 2,
    freeTier: {
      kind: "limited_free",
      note: "Free control plane (Free tier); node compute billed separately",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_application_insights",
    displayName: "Azure Application Insights",
    provider: "azure",
    purpose: "APM: distributed traces, metrics, exception capture",
    fingerprints: [],
    capabilities: ["observability", "error_tracking"],
    rank: 0,
    freeTier: { kind: "limited_free", note: "Free: 5 GB ingestion/mo" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_monitor",
    displayName: "Azure Monitor",
    provider: "azure",
    purpose: "Platform metrics, logs, and alerting",
    fingerprints: [],
    capabilities: ["observability"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Free: 5 GB log ingestion/mo; platform metrics free" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_key_vault",
    displayName: "Azure Key Vault",
    provider: "azure",
    purpose: "Managed secrets, keys, and certificates",
    fingerprints: [],
    capabilities: ["secrets"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_pipelines",
    displayName: "Azure Pipelines",
    provider: "azure",
    purpose: "Build, test, and deploy CI/CD pipeline",
    fingerprints: [],
    capabilities: ["cicd"],
    rank: 0,
    freeTier: {
      kind: "limited_free",
      note: "Free: 1 hosted job, 1,800 min/mo (private); unlimited for public repos",
    },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_synapse",
    displayName: "Azure Synapse Analytics",
    provider: "azure",
    purpose: "Analytics warehouse and big-data SQL",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: true,
  },
  {
    key: "azure_data_explorer",
    displayName: "Azure Data Explorer",
    provider: "azure",
    purpose: "Columnar telemetry and log analytics (KQL)",
    fingerprints: [],
    capabilities: ["analytics_warehouse"],
    rank: 1,
    freeTier: { kind: "limited_free", note: "Free cluster tier: limited compute + storage" },
    verifiedOn: "2026-07",
    managed: true,
  },
];

const BY_KEY: ReadonlyMap<string, ServiceCatalogEntry> = new Map(
  SERVICE_CATALOG.map((e) => [e.key, e]),
);

/**
 * The ONLY way an untrusted `service_key` (form submission, detector output, a
 * stale DB row) becomes a renderable tag. Returns `undefined` for anything not
 * in the catalog — callers drop those rows rather than passing an unknown key
 * (and, worse, an unknown label) toward a prompt.
 */
export function getServiceEntry(key: string): ServiceCatalogEntry | undefined {
  return BY_KEY.get(key);
}

export function isKnownServiceKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Every key in the catalog, for Zod enums and tests. */
export const SERVICE_KEYS: readonly string[] = SERVICE_CATALOG.map((e) => e.key);

/** Catalog grouped for the picker, in `STACK_PROVIDERS` order. */
export function groupCatalogByProvider(): Array<{
  provider: StackProvider;
  displayName: string;
  entries: ServiceCatalogEntry[];
}> {
  return STACK_PROVIDERS.map((p) => ({
    provider: p.provider,
    displayName: p.displayName,
    entries: SERVICE_CATALOG.filter((e) => e.provider === p.provider),
  }));
}

// ─── Stack advisor: the capability -> ecosystem -> services[] view ───────
//
// This is DERIVED, not authored. The feature needs a
// `capability -> {aws|azure|gcp|oss} -> services[]` view, but hand-authoring
// it as a second nested literal would create two places a service key
// exists — the nested literal, and whatever the detector/persistence reads —
// and `getServiceEntry` would stop being the one gate. Instead we build the
// nested view ONCE at module load from the flat `SERVICE_CATALOG`, which
// remains the single source of truth. A test asserts the index round-trips:
// every entry appears under each of its declared capabilities, exactly once.

function buildCapabilityIndex(
  catalog: readonly ServiceCatalogEntry[],
): ReadonlyMap<CapabilityKey, ReadonlyMap<StackProvider, readonly ServiceCatalogEntry[]>> {
  const byCapability = new Map<CapabilityKey, Map<StackProvider, ServiceCatalogEntry[]>>();
  for (const entry of catalog) {
    for (const capability of entry.capabilities) {
      let byProvider = byCapability.get(capability);
      if (!byProvider) {
        byProvider = new Map();
        byCapability.set(capability, byProvider);
      }
      const bucket = byProvider.get(entry.provider);
      if (bucket) {
        bucket.push(entry);
      } else {
        byProvider.set(entry.provider, [entry]);
      }
    }
  }
  // Sort each (capability, provider) bucket by rank ASC so `servicesFor`'s
  // contract ("rank ASC") holds without callers having to sort themselves.
  for (const byProvider of byCapability.values()) {
    for (const [provider, entries] of byProvider) {
      byProvider.set(
        provider,
        [...entries].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)),
      );
    }
  }
  return byCapability;
}

const BY_CAPABILITY = buildCapabilityIndex(SERVICE_CATALOG);

/** All catalog services that can fill `capability` for `provider`, rank ASC. */
export function servicesFor(
  capability: CapabilityKey,
  provider: StackProvider,
): readonly ServiceCatalogEntry[] {
  return BY_CAPABILITY.get(capability)?.get(provider) ?? [];
}

/** All catalog services that can fill `capability`, any provider, catalog order. */
export function servicesForCapability(capability: CapabilityKey): readonly ServiceCatalogEntry[] {
  return SERVICE_CATALOG.filter((e) => e.capabilities.includes(capability));
}

/**
 * (capability, provider) pairs the catalog does not yet cover — either the
 * cloud genuinely has no native offering, or curation hasn't reached it yet
 * (Stage 6 fills the rest). Declaring a gap here is what lets the coverage
 * test tell "we haven't curated it yet" apart from "we forgot a capability",
 * per the design doc's D1.
 */
export const KNOWN_GAPS: ReadonlyArray<{ capability: CapabilityKey; provider: StackProvider }> = [
  // Both genuine first-party gaps (Stage 6 curation filled every other cell —
  // see the coverage test below, which is what keeps this list honest).
  { capability: "error_tracking", provider: "aws" },
  { capability: "email", provider: "gcp" },
];

/**
 * Collapse a tag set into the closest `StackFlavor`, so a project that pinned
 * hard tags never also carries a soft flavor that contradicts them.
 *
 * The create action seeds `planning_sessions.stack_flavor` with this instead of
 * the old hardcoded `'mixed'`. The tags remain authoritative in the prompt
 * (`stackTagsBlock` says so explicitly); deriving the flavor from them just
 * means the two framings agree by construction rather than by luck.
 *
 * No tags → `mixed`, which is exactly the old default.
 */
export function deriveStackFlavor(
  tags: ReadonlyArray<{ provider: StackProvider }>,
): "industry" | "mixed" | "oss" {
  if (tags.length === 0) return "mixed";
  const cloud = tags.filter((t) => t.provider !== "oss").length;
  if (cloud === 0) return "oss";
  if (cloud === tags.length) return "industry";
  return "mixed";
}

// ─── Invariant guard ────────────────────────────────────────────────────
// Same shape as the ROLE_CATALOG guard: loud in the logs, never throws (this
// module is imported from prerender/type-check contexts).
{
  const seen = new Set<string>();
  const dupes = SERVICE_CATALOG.filter((e) => (seen.has(e.key) ? true : (seen.add(e.key), false)));
  if (dupes.length > 0) {
    console.error(
      `[service-catalog] duplicate service keys: ${dupes.map((e) => e.key).join(", ")}. ` +
        "Keys are the primary identity of a tag (unique per project in the DB) — dedupe them.",
    );
  }
}
