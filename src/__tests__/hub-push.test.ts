import { describe, expect, it } from "vitest"
import { resolveHubConfig } from "../hub-push.js"

describe("resolveHubConfig", () => {
  it("returns undefined when hub config is absent", () => {
    expect(resolveHubConfig(undefined)).toBeUndefined()
  })

  it("returns undefined when enabled is false", () => {
    expect(resolveHubConfig({ enabled: false })).toBeUndefined()
  })

  it("throws when enabled but baseUrl is missing", () => {
    expect(() => resolveHubConfig({ enabled: true, chatPushKey: "k" }))
      .toThrow("hub is enabled but baseUrl is not configured")
  })

  it("throws when enabled but chatPushKey is missing", () => {
    expect(() => resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com" }))
      .toThrow("hub is enabled but chatPushKey is not configured")
  })

  it("resolves and strips trailing slashes from baseUrl", () => {
    expect(resolveHubConfig({ enabled: true, baseUrl: "https://hub.example.com/", chatPushKey: "k" }))
      .toEqual({ baseUrl: "https://hub.example.com", chatPushKey: "k" })
  })
})
