import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  generateProduceId,
  resolveContentProducer,
  buildAigcLabel,
  signLabel,
  resolveAigcConfig,
  type AigcConfig,
} from "../aigc.js"

const BASE_CONFIG: AigcConfig = {
  enabled: true,
  contentProducer: "001191320118MAK93FC72D10001",
  label: "1",
  explicitHint: true,
  produceIdPrefix: "",
  modelCodes: {},
}

describe("generateProduceId", () => {
  it("generates an ID in YYYYMMDDHHmmss-<12 hex> format", () => {
    const id = generateProduceId()
    expect(id).toMatch(/^\d{14}-[0-9a-f]{12}$/)
  })

  it("prepends an optional prefix", () => {
    const id = generateProduceId("prod-")
    expect(id).toMatch(/^prod-\d{14}-[0-9a-f]{12}$/)
  })

  it("generates unique IDs across many calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateProduceId()))
    expect(ids.size).toBe(1000)
  })
})

describe("resolveContentProducer", () => {
  it("returns the configured 27-char code when no model code matches", () => {
    expect(resolveContentProducer(BASE_CONFIG, "glm-4.5")).toBe(
      "001191320118MAK93FC72D10001",
    )
  })

  it("replaces the last 4 chars (model code) when the model is mapped", () => {
    const cfg: AigcConfig = {
      ...BASE_CONFIG,
      modelCodes: { "qwen-max": "0002" },
    }
    expect(resolveContentProducer(cfg, "qwen-max")).toBe(
      "001191320118MAK93FC72D10002",
    )
  })

  it("keeps the subject segment (first 23 chars) stable across models", () => {
    const cfg: AigcConfig = {
      ...BASE_CONFIG,
      modelCodes: { "glm-4.5": "0001", "qwen-max": "0002", "deepseek-chat": "0003" },
    }
    for (const model of Object.keys(cfg.modelCodes!)) {
      expect(resolveContentProducer(cfg, model).slice(0, 23)).toBe(
        "001191320118MAK93FC72D1",
      )
    }
  })
})

describe("buildAigcLabel", () => {
  it("builds a GB 45438-2025 label with required fields", () => {
    const label = buildAigcLabel(BASE_CONFIG, "glm-4.5")
    expect(label.Label).toBe("1")
    expect(label.ContentProducer).toBe("001191320118MAK93FC72D10001")
    expect(label.ProduceID).toMatch(/^\d{14}-[0-9a-f]{12}$/)
  })

  it("uses a provided produceId when given", () => {
    const label = buildAigcLabel(BASE_CONFIG, "glm-4.5", "20260723103000-a1b2c3d4e5f6")
    expect(label.ProduceID).toBe("20260723103000-a1b2c3d4e5f6")
  })

  it("adds ReservedCode1 signature when signingKey is set", () => {
    const cfg: AigcConfig = { ...BASE_CONFIG, signingKey: "secret" }
    const label = buildAigcLabel(cfg, "glm-4.5")
    expect(label.ReservedCode1).toMatch(/^[0-9a-f]{64}$/)
    expect(label.ReservedCode1).toBe(signLabel(label, "secret"))
  })

  it("omits ReservedCode1 when no signingKey", () => {
    const label = buildAigcLabel(BASE_CONFIG, "glm-4.5")
    expect(label.ReservedCode1).toBeUndefined()
  })

  it("produces deterministic signatures for identical labels", () => {
    const label = buildAigcLabel(BASE_CONFIG, "glm-4.5", "fixed-id")
    expect(signLabel(label, "k1")).toBe(signLabel(label, "k1"))
    expect(signLabel(label, "k1")).not.toBe(signLabel(label, "k2"))
  })
})

describe("resolveAigcConfig", () => {
  const ENV_KEYS = [
    "OPENAGENT_AIGC_ENABLED",
    "OPENAGENT_AIGC_CONTENT_PRODUCER",
    "OPENAGENT_AIGC_LABEL",
    "OPENAGENT_AIGC_SIGNING_KEY",
    "OPENAGENT_AIGC_EXPLICIT_HINT",
  ]

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it("returns undefined when neither config nor env enables aigc", () => {
    expect(resolveAigcConfig(undefined)).toBeUndefined()
  })

  it("returns config as-is when enabled in config", () => {
    const result = resolveAigcConfig(BASE_CONFIG)
    expect(result?.enabled).toBe(true)
    expect(result?.contentProducer).toBe(BASE_CONFIG.contentProducer)
  })

  it("returns undefined when config.enabled is false and no env override", () => {
    expect(resolveAigcConfig({ ...BASE_CONFIG, enabled: false })).toBeUndefined()
  })

  it("enables via env even without config", () => {
    process.env.OPENAGENT_AIGC_ENABLED = "true"
    process.env.OPENAGENT_AIGC_CONTENT_PRODUCER = "001191320118MAK93FC72D10001"
    const result = resolveAigcConfig(undefined)
    expect(result?.enabled).toBe(true)
    expect(result?.contentProducer).toBe("001191320118MAK93FC72D10001")
  })

  it("env values override config values", () => {
    process.env.OPENAGENT_AIGC_CONTENT_PRODUCER = "0011000000000000000001A0009"
    process.env.OPENAGENT_AIGC_SIGNING_KEY = "env-key"
    const result = resolveAigcConfig(BASE_CONFIG)
    expect(result?.contentProducer).toBe("0011000000000000000001A0009")
    expect(result?.signingKey).toBe("env-key")
  })

  it("throws when enabled but contentProducer is missing", () => {
    process.env.OPENAGENT_AIGC_ENABLED = "true"
    expect(() => resolveAigcConfig(undefined)).toThrow(/contentProducer/i)
  })

  it("throws when contentProducer is not 27 chars", () => {
    expect(() =>
      resolveAigcConfig({ ...BASE_CONFIG, contentProducer: "tooshort" }),
    ).toThrow(/27/)
  })
})
