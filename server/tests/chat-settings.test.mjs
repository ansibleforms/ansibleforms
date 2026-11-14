// The chat assistant's provider settings (one row, api key encrypted) and the two
// provider adapters' requests - the key only ever in a header, never in a body.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

let row;
const updates = [];
// the credentials there are, by name, and the runners that name one
const creds = {
  "chat-key": { name: "chat-key", credential_type: "api", password: "" },
  "runner-token": { name: "runner-token", credential_type: "api", password: "" },
  "a-login": { name: "a-login", credential_type: "userpass", password: "" },
};
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, rec) => {
      if (/^UPDATE/.test(sql)) { updates.push(rec); return { affectedRows: 1 }; }
      if (/runners/.test(sql)) return rec?.[0] === "runner-token" ? [{ name: "rte1" }] : [];
      // the CyberArk stores that write with a credential : none here
      if (/secret_stores/.test(sql)) return [];
      if (/credentials/.test(sql)) return creds[rec?.[0]] ? [structuredClone(creds[rec[0]])] : [];
      return row ? [structuredClone(row)] : [];
    },
  },
}));

// "ignore certificate errors" goes through undici's own fetch with a lax agent
const insecure = { calls: [], agents: [] };
vi.mock("undici", () => ({
  Agent: class { constructor(opts) { insecure.agents.push(opts); } },
  fetch: async (url, opts) => {
    insecure.calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
  },
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
appConfig.encryptionSecret ||= "0123456789abcdef0123456789abcdef";
const crypto = (await import("../src/lib/crypto.js")).default;
const ChatSettings = (await import("../src/models/chatSettings.model.js")).default;
const controller = (await import("../src/controllers/v2/chatSettings.controller.js")).default;
const anthropic = (await import("../src/chat/providers/anthropic.js")).default;
const openai = (await import("../src/chat/providers/openai.js")).default;
const { complete } = await import("../src/chat/providers/index.js");

// an admin, and a user with only connections access
const admin = { user: { username: "admin", roles: ["admin"] } };
const ops = { user: { username: "ops", roles: ["ops"], options: { showConnectionsSettings: true } } };

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

beforeEach(() => {
  updates.length = 0;
  row = { provider: "anthropic", api_key: crypto.encrypt("sk-real"), base_url: "", model: "m", max_turns: 20, max_tool_rounds: 6, timeout_seconds: 60, allow_job_status: 1, managed: 0 };
});

describe("chat settings", () => {
  test("the api key is stored encrypted, limits are clamped, an unknown provider is none", () => {
    const rec = new ChatSettings({ provider: "evil", api_key: "sk-x", max_turns: 9999, timeout_seconds: "abc" });
    expect(rec.provider).toBe("");
    expect(rec.api_key).not.toContain("sk-x");
    expect(crypto.decrypt(rec.api_key)).toBe("sk-x");
    expect(rec.max_turns).toBe(200);
    expect(rec.timeout_seconds).toBe(60);
  });

  test("the key comes back masked, and a masked key on save keeps the stored one", async () => {
    const r = res();
    await controller.find({}, r);
    expect(r.body.api_key).toBe("**********");
    await controller.update({ user: admin, body: { provider: "openai", api_key: "**********", model: "gpt" } }, res());
    expect(crypto.decrypt(updates[0].api_key)).toBe("sk-real");
    expect(updates[0].provider).toBe("openai");
  });

  test("another provider by a connections user: the stored key stays behind", async () => {
    await controller.update({ user: ops, body: { provider: "openai", api_key: "**********", model: "gpt" } }, res());
    expect(updates[0].api_key).toBe("");
  });

  test("another base url with the api key left out: the stored key stays behind", async () => {
    await controller.update({ user: ops, body: { provider: "anthropic", base_url: "https://evil", model: "m" } }, res());
    expect(updates[0].api_key).toBe("");
  });

  test("another base url by a connections user: the saved credential stays behind too", async () => {
    row.credential = "chat-key";
    await controller.update({ user: ops, body: { provider: "anthropic", base_url: "https://evil", credential: "chat-key", model: "m" } }, res());
    expect(updates[0].credential).toBe(null);
  });

  test("the same target keeps the key and the credential", async () => {
    row.credential = "chat-key";
    await controller.update({ user: ops, body: { provider: "anthropic", api_key: "**********", credential: "chat-key", model: "m2" } }, res());
    expect(crypto.decrypt(updates[0].api_key)).toBe("sk-real");
    expect(updates[0].credential).toBe("chat-key");
  });

  test("a credential a runner names: refused to a connections user", async () => {
    const r = res();
    await controller.update({ user: ops, body: { provider: "anthropic", credential: "runner-token", model: "m" } }, r);
    expect(r.statusCode).toBe(403);
    expect(updates).toEqual([]);
  });

  describe("the provider check", () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const sent = [];
    beforeEach(() => {
      sent.length = 0;
      vi.stubGlobal("fetch", vi.fn(async (url, init) => {
        sent.push({ url, headers: init.headers });
        return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "OK" }] }) };
      }));
    });

    test("the stored key is not sent to another base url", async () => {
      const r = res();
      await controller.check({ user: ops, body: { base_url: "https://evil", api_key: "**********" } }, r);
      expect(r.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    test("nor with the api key left out of the request", async () => {
      const r = res();
      await controller.check({ user: ops, body: { base_url: "https://evil" } }, r);
      expect(r.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    test("an empty api key is not a typed one either", async () => {
      const r = res();
      await controller.check({ user: ops, body: { base_url: "https://evil", api_key: "" } }, r);
      expect(r.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    test("nor a credential's key to another provider", async () => {
      const r = res();
      await controller.check({ user: ops, body: { provider: "openai", credential: "chat-key" } }, r);
      expect(r.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    test("only an api credential is checked", async () => {
      const r = res();
      await controller.check({ user: ops, body: { credential: "a-login" } }, r);
      expect(r.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    test("a key typed on the page may go to another base url", async () => {
      const r = res();
      await controller.check({ user: ops, body: { base_url: "https://other", api_key: "sk-typed" } }, r);
      expect(r.statusCode).toBe(200);
      expect(sent[0].url).toContain("https://other");
    });

    test("the stored key goes to the saved provider", async () => {
      const r = res();
      await controller.check({ user: ops, body: { api_key: "**********" } }, r);
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(sent[0].headers)).toContain("sk-real");
    });
  });

  test("a row managed by the config seed is read only", async () => {
    row.managed = 1;
    const r = res();
    await controller.update({ body: { provider: "openai" } }, r);
    expect(r.statusCode).toBe(403);
    expect(updates).toEqual([]);
  });

  test("configured means provider, key and model", async () => {
    expect(ChatSettings.isConfigured(await ChatSettings.find())).toBe(true);
    expect(ChatSettings.isConfigured({ ...row, api_key: "" })).toBe(false);
    expect(ChatSettings.isConfigured({ ...row, provider: "" })).toBe(false);
    // a local model server or an internal proxy : a base url and no key
    expect(ChatSettings.isConfigured({ ...row, api_key: "", base_url: "http://ollama:11434/v1" })).toBe(true);
    // Ollama takes no key ; Azure and a custom endpoint have no url of their own
    expect(ChatSettings.isConfigured({ ...row, provider: "ollama", api_key: "" })).toBe(true);
    expect(ChatSettings.isConfigured({ ...row, provider: "azure", base_url: "" })).toBe(false);
    expect(ChatSettings.isConfigured({ ...row, provider: "custom", base_url: "https://proxy/v1" })).toBe(true);
  });

});

describe("provider requests", () => {
  let calls;
  const reply = (json, status = 200) => vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, text: async () => JSON.stringify(json) };
  });
  const tools = [{ name: "resolve", description: "d", parameters: { type: "object", properties: {} } }];
  const history = [
    { role: "user", text: "snapshot please" },
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "resolve", arguments: { form: "F" } }, { id: "t2", name: "catalog", arguments: {} }] },
    { role: "tool", toolCallId: "t1", text: "{\"status\":\"needs_input\"}" },
    { role: "tool", toolCallId: "t2", text: "{}" },
  ];
  beforeEach(() => { calls = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  test("anthropic: x-api-key header, tools as input_schema, tool results grouped, no sampling parameters", async () => {
    vi.stubGlobal("fetch", reply({ content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Which cluster?" }, { type: "tool_use", id: "t3", name: "resolve", input: { form: "F" } }] }));
    const out = await complete({ settings: { provider: "anthropic", api_key: "sk-a", model: "m", timeout_seconds: 5 }, system: "S", history, tools });
    const c = calls[0];
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["x-api-key"]).toBe("sk-a");
    expect(JSON.stringify(c.body)).not.toContain("sk-a");
    expect(c.body.tools[0]).toEqual({ name: "resolve", description: "d", input_schema: { type: "object", properties: {} } });
    expect(c.body.messages[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "{\"status\":\"needs_input\"}" },
      { type: "tool_result", tool_use_id: "t2", content: "{}" },
    ] });
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(c.body[k]).toBeUndefined();
    expect(out.text).toBe("Which cluster?");
    expect(out.text).not.toContain("hidden");
    expect(out.toolCalls).toEqual([{ id: "t3", name: "resolve", arguments: { form: "F" } }]);
    expect(out.raw[0].type).toBe("thinking");
  });

  test("openai: bearer, function tools, the settings' user, assistant content a string, broken arguments flagged", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "resolve", arguments: "{bad" } }] } }] }));
    const out = await complete({ settings: { provider: "openai", api_key: "sk-o", model: "gpt", timeout_seconds: 5, request_user: "mirko" }, system: "S", history, tools });
    const c = calls[0];
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer sk-o");
    expect(JSON.stringify(c.body)).not.toContain("sk-o");
    expect(c.body.user).toBe("mirko");
    expect(c.body.tools[0].function.name).toBe("resolve");
    expect(c.body.messages[0]).toEqual({ role: "system", content: "S" });
    expect(c.body.messages[2].content).toBe("");
    expect(c.body.messages[2].tool_calls[0].function.arguments).toBe("{\"form\":\"F\"}");
    expect(out.toolCalls[0].arguments).toEqual({ __invalid_json__: true });
  });

  test("azure openai: api-key header, the path goes in front of the api-version query", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    await complete({ settings: { provider: "openai", api_key: "az", model: "gpt", base_url: "https://x.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21", timeout_seconds: 5 }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(calls[0].url).toBe("https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21");
    expect(calls[0].headers["api-key"]).toBe("az");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.user).toBeUndefined();
  });

  test("a vendor speaks the openai protocol with its own url and auth ; the settings win", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    const hi = [{ role: "user", text: "hi" }];
    await complete({ settings: { provider: "gemini", api_key: "g", model: "gemini-2.5-pro", timeout_seconds: 5 }, system: "S", history: hi, tools: [] });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer g");
    await complete({ settings: { provider: "azure", api_key: "az", model: "gpt", base_url: "https://x.openai.azure.com/openai/deployments/gpt", timeout_seconds: 5 }, system: "S", history: hi, tools: [] });
    expect(calls[1].url).toBe("https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21");
    expect(calls[1].headers["api-key"]).toBe("az");
    await complete({ settings: { provider: "ollama", api_key: "", model: "llama3", timeout_seconds: 5 }, system: "S", history: hi, tools: [] });
    expect(calls[2].url).toBe("http://localhost:11434/v1/chat/completions");
    await complete({ settings: { provider: "grok", api_key: "x", model: "grok-4", base_url: "https://gw.local/v1", timeout_seconds: 5 }, system: "S", history: hi, tools: [] });
    expect(calls[3].url).toBe("https://gw.local/v1/chat/completions");
  });

  test("a provider error is reported with its status, never the key", async () => {
    vi.stubGlobal("fetch", reply({ error: { message: "invalid x-api-key" } }, 401));
    const err = await complete({ settings: { provider: "anthropic", api_key: "sk-secret", model: "m", timeout_seconds: 5 }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] }).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_error", status: 502 });
    expect(err.message).toMatch(/Anthropic returned 401/);
    expect(err.message).not.toContain("sk-secret");
  });

  test("no key (Ollama, an internal proxy): no auth header at all", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    await complete({ settings: { provider: "openai", api_key: "", model: "llama3", base_url: "http://ollama:11434/v1", timeout_seconds: 5 }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(calls[0].url).toBe("http://ollama:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers["api-key"]).toBeUndefined();
  });

  test("a user is only sent when the settings name one", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    await complete({ settings: { provider: "openai", api_key: "k", model: "m", timeout_seconds: 5 }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(calls[0].body.user).toBeUndefined();
    vi.stubGlobal("fetch", reply({ content: [{ type: "text", text: "OK" }] }));
    await complete({ settings: { provider: "anthropic", api_key: "k", model: "m", timeout_seconds: 5, request_user: "mirko" }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(calls[1].body.metadata).toEqual({ user_id: "mirko" });
  });

  test("auth type, api version and extra headers for a proxy", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    const base = { provider: "openai", api_key: "k1", model: "m", timeout_seconds: 5, base_url: "https://proxy.local/v1" };
    const hi = [{ role: "user", text: "hi" }];
    await complete({ settings: { ...base, auth_type: "api-key", api_version: "2024-10-21", extra_headers: JSON.stringify({ "X-Org": "ops" }) }, system: "S", history: hi, tools: [] });
    expect(calls[0].url).toBe("https://proxy.local/v1/chat/completions?api-version=2024-10-21");
    expect(calls[0].headers).toMatchObject({ "api-key": "k1", "X-Org": "ops" });
    expect(calls[0].headers.authorization).toBeUndefined();
    await complete({ settings: { ...base, auth_type: "none" }, system: "S", history: hi, tools: [] });
    expect(calls[1].headers.authorization).toBeUndefined();
    await complete({ settings: { ...base, auth_type: "x-api-key" }, system: "S", history: hi, tools: [] });
    expect(calls[2].headers["x-api-key"]).toBe("k1");
    // an api-version already in the url is kept, not doubled
    await complete({ settings: { ...base, base_url: "https://x.openai.azure.com/openai/deployments/gpt?api-version=2024-10-21", api_version: "2025-01-01" }, system: "S", history: hi, tools: [] });
    expect(calls[3].url).toBe("https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21");
    expect(calls[3].headers["api-key"]).toBe("k1");
  });

  test("anthropic: the api version is its header", async () => {
    vi.stubGlobal("fetch", reply({ content: [{ type: "text", text: "OK" }] }));
    await complete({ settings: { provider: "anthropic", api_key: "k", model: "m", timeout_seconds: 5, api_version: "2025-01-01" }, system: "S", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(calls[0].headers["anthropic-version"]).toBe("2025-01-01");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  });

  test("extra headers: a JSON object of one-line strings, never a header the adapter owns", () => {
    expect(new ChatSettings({ extra_headers: '{"X-Org":"ops"}' }).extra_headers).toBe('{"X-Org":"ops"}');
    expect(new ChatSettings({ extra_headers: "" }).extra_headers).toBe("");
    expect(() => new ChatSettings({ extra_headers: "not json" })).toThrow(/JSON object/);
    expect(() => new ChatSettings({ extra_headers: '["a"]' })).toThrow(/JSON object/);
    expect(() => new ChatSettings({ extra_headers: '{"Authorization":"Bearer x"}' })).toThrow(/set by AnsibleForms/);
    expect(() => new ChatSettings({ extra_headers: '{"X-A":"a\\nb"}' })).toThrow(/one line/);
    expect(new ChatSettings({ auth_type: "weird" }).auth_type).toBe("");
  });

  test("a call that does not get through says why, and where - never the key or the path", async () => {
    const failing = (code) => vi.fn(async () => { const e = new TypeError("fetch failed"); e.cause = Object.assign(new Error(`boom ${code}`), { code }); throw e; });
    const settings = { provider: "custom", api_key: "sk-secret", model: "m", base_url: "https://llm.corp.local/v1?token=abc", timeout_seconds: 5 };
    const hi = [{ role: "user", text: "hi" }];
    vi.stubGlobal("fetch", failing("SELF_SIGNED_CERT_IN_CHAIN"));
    let err = await complete({ settings, system: "S", history: hi, tools: [] }).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_unreachable", status: 502 });
    expect(err.message).toMatch(/at https:\/\/llm\.corp\.local: .*NODE_EXTRA_CA_CERTS.*\(SELF_SIGNED_CERT_IN_CHAIN\)/);
    expect(err.message).not.toMatch(/sk-secret|token=abc|\/v1/);
    vi.stubGlobal("fetch", failing("ENOTFOUND"));
    err = await complete({ settings, system: "S", history: hi, tools: [] }).catch((e) => e);
    expect(err.message).toMatch(/does not resolve \(ENOTFOUND\)/);
    vi.stubGlobal("fetch", failing("ESOMETHING"));
    err = await complete({ settings, system: "S", history: hi, tools: [] }).catch((e) => e);
    expect(err.message).toMatch(/boom ESOMETHING \(ESOMETHING\)/);
  });

  test("ignore certificate errors: only then the lax agent, and only for this call", async () => {
    vi.stubGlobal("fetch", reply({ choices: [{ message: { content: "OK" } }] }));
    const settings = { provider: "custom", api_key: "k", model: "m", base_url: "https://llm.corp.local/v1", timeout_seconds: 5 };
    const hi = [{ role: "user", text: "hi" }];
    await complete({ settings, system: "S", history: hi, tools: [] });
    expect(calls).toHaveLength(1);
    expect(insecure.calls).toHaveLength(0);
    await complete({ settings: { ...settings, ignore_certs: 1 }, system: "S", history: hi, tools: [] });
    expect(calls).toHaveLength(1);
    expect(insecure.calls).toHaveLength(1);
    expect(insecure.calls[0].url).toBe("https://llm.corp.local/v1/chat/completions");
    expect(insecure.agents).toEqual([{ connect: { rejectUnauthorized: false } }]);
    expect(insecure.calls[0].opts.headers.authorization).toBe("Bearer k");
    expect(new ChatSettings({ ignore_certs: true }).ignore_certs).toBe(1);
    expect(new ChatSettings({}).ignore_certs).toBe(0);
  });

  test("no provider configured", async () => {
    await expect(complete({ settings: { provider: "" }, system: "", history: [], tools: [] })).rejects.toMatchObject({ code: "chat_not_configured" });
  });

  test("the adapters are the ones the tests read", () => {
    expect(typeof anthropic.anthropicBody).toBe("function");
    expect(typeof openai.openaiBody).toBe("function");
  });
});
