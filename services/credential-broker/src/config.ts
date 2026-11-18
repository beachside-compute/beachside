import { z } from "zod";

export const integrationId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const maxGrantTtlSeconds = 3_600;

const integration = z.strictObject({
  id: integrationId,
  kind: z.enum(["github", "anthropic", "openai", "openrouter"]),
  credential: z.strictObject({
    source: z.literal("worker-secret"),
    binding: z.templateLiteral(["CREDENTIAL_", z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)]),
  }),
});

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);

const workflowPolicy = z
  .strictObject({
    repositoryId: id,
    repositoryOwnerId: id,
    repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
    ref: z
      .string()
      .regex(/^refs\/(heads|tags)\/[^\s*?[\]]+$/)
      .max(512),
    workflowRef: z.string().min(1).max(512),
    jobWorkflowRef: z.string().min(1).max(512).optional(),
    event: z.enum(["push", "schedule", "workflow_dispatch", "workflow_run", "pull_request_target"]),
    integrations: z.array(integrationId).min(1).max(16),
  })
  .superRefine((value, ctx) => {
    const prefix = `${value.repository}/.github/workflows/`;

    if (!value.workflowRef.startsWith(prefix) || !value.workflowRef.endsWith(`@${value.ref}`)) {
      ctx.addIssue({
        code: "custom",
        message: "workflowRef must identify the configured repository and ref",
      });
    }
  });

const configuration = z
  .strictObject({
    integrations: z.array(integration).min(1).max(16),
    githubActions: z
      .strictObject({
        audience: z.string().min(1).max(256),
        workflows: z.array(workflowPolicy).min(1).max(32),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.integrations.map(({ id }) => id));

    if (ids.size !== value.integrations.length) {
      ctx.addIssue({ code: "custom", message: "Integration IDs must be unique" });
    }

    if (value.integrations.filter(({ kind }) => kind === "github").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "Configure at most one GitHub integration per host",
      });
    }

    for (const workflow of value.githubActions?.workflows ?? []) {
      if (workflow.integrations.some((name) => !ids.has(name))) {
        ctx.addIssue({
          code: "custom",
          message: "Workflow integrations must exist in integrations",
        });
      }
    }
  });

export type Integration = z.infer<typeof integration>;

export type CredentialReference = Integration["credential"];

export type BrokerConfig = z.infer<typeof configuration>;

let cachedConfig: { raw: string; config: BrokerConfig } | undefined;

export function parseConfig(raw: string): BrokerConfig {
  if (cachedConfig?.raw === raw) return cachedConfig.config;

  const result = configuration.safeParse(JSON.parse(raw));

  if (!result.success) throw new Error("Invalid broker configuration");

  cachedConfig = { raw, config: result.data };

  return result.data;
}

export function permissionKey(integration: Integration): string {
  const { id, kind, credential } = integration;

  return `${id}:${kind}:${credential.source}:${credential.binding}`;
}
