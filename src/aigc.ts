import { createHash, randomUUID } from "node:crypto"

/**
 * Implicit AIGC label per GB 45438-2025, carried in the HTTP/SSE response
 * envelope for text-only generation services.
 */
export interface AigcLabel {
  /** "1" = AI-generated, "2" = possibly AI-generated, "3" = suspected */
  Label: "1" | "2" | "3"
  /** 27-char service provider code of THIS runtime's operator */
  ContentProducer: string
  /** Globally unique per-run content number */
  ProduceID: string
  /** Optional integrity signature (SHA-256 HMAC-style) */
  ReservedCode1?: string
  /** Filled by downstream content propagators, not by us */
  ContentPropagator?: string
  PropagateID?: string
  ReservedCode2?: string
}

export interface AigcConfig {
  enabled: boolean
  /** Full 27-char code; last 4 chars are the model/app code slot */
  contentProducer: string
  label?: "1" | "2" | "3"
  signingKey?: string
  explicitHint?: boolean
  produceIdPrefix?: string
  /** model name -> 4-char model code replacing the last 4 chars */
  modelCodes?: Record<string, string>
}

export function generateProduceId(prefix = ""): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  const uuid = randomUUID().replace(/-/g, "").slice(0, 12)
  return `${prefix}${ts}-${uuid}`
}

/**
 * Full 27-char ContentProducer for a given model. When the model is mapped
 * in `modelCodes`, the last 4 chars (model/app code slot) are replaced; the
 * 23-char subject segment always stays stable.
 */
export function resolveContentProducer(cfg: AigcConfig, model?: string): string {
  const code = model ? cfg.modelCodes?.[model] : undefined
  if (code) {
    return cfg.contentProducer.slice(0, 23) + code
  }
  return cfg.contentProducer
}

export function signLabel(label: AigcLabel, key: string): string {
  const payload = `${label.Label}|${label.ContentProducer}|${label.ProduceID}`
  return createHash("sha256").update(payload + "|" + key).digest("hex")
}

export function buildAigcLabel(
  cfg: AigcConfig,
  model?: string,
  produceId: string = generateProduceId(cfg.produceIdPrefix),
): AigcLabel {
  const label: AigcLabel = {
    Label: cfg.label ?? "1",
    ContentProducer: resolveContentProducer(cfg, model),
    ProduceID: produceId,
  }
  if (cfg.signingKey) {
    label.ReservedCode1 = signLabel(label, cfg.signingKey)
  }
  return label
}

/**
 * Merge config-file `aigc` section with ZERONE_AGENT_AIGC_* env vars.
 * Returns undefined when the feature is disabled (default).
 * Env vars take priority over config values.
 */
export function resolveAigcConfig(cfg?: AigcConfig): AigcConfig | undefined {
  const env = process.env
  const envEnabled = env.ZERONE_AGENT_AIGC_ENABLED
  const enabled =
    envEnabled !== undefined ? envEnabled === "true" : (cfg?.enabled ?? false)

  if (!enabled) return undefined

  const contentProducer = env.ZERONE_AGENT_AIGC_CONTENT_PRODUCER ?? cfg?.contentProducer
  if (!contentProducer) {
    throw new Error("AIGC is enabled but contentProducer is not configured")
  }
  if (contentProducer.length !== 27) {
    throw new Error(`AIGC contentProducer must be 27 chars, got ${contentProducer.length}`)
  }

  const envLabel = env.ZERONE_AGENT_AIGC_LABEL
  const envHint = env.ZERONE_AGENT_AIGC_EXPLICIT_HINT

  return {
    enabled: true,
    contentProducer,
    label: (envLabel as "1" | "2" | "3" | undefined) ?? cfg?.label,
    signingKey: env.ZERONE_AGENT_AIGC_SIGNING_KEY ?? cfg?.signingKey,
    explicitHint: envHint !== undefined ? envHint === "true" : cfg?.explicitHint,
    produceIdPrefix: cfg?.produceIdPrefix,
    modelCodes: cfg?.modelCodes,
  }
}
