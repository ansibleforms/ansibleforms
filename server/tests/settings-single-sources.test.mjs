// What the config seed manages and where a type kept in one file is (each Appearance page's, the links',
// the MCP settings', the chat assistant's, the settings') : read with the settings
// (GET /api/v2/settings), so the pages of a part of the settings on its own (Appearance,
// Connections) lock the seeded fields and say the repository holding them, without reading the
// repositories - and never what another part's pages show.
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
vi.mock("../src/models/settings.model.js", () => ({
  default: { find: async () => ({ app_name: "AF", url: "https://af", seed_managed_fields: '["app_name"]' }) },
}));

const fixture = await import("./fixtures/repoObjects.mjs");
const settingsController = (await import("../src/controllers/v2/settings.controller.js")).default;

const repo = (name, flags) => ({ id: fixture.state.nextId++, name, ...flags });
const find = async (options) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await settingsController.find({ user: { user: { username: "u", type: "local", options } } }, res);
  return res;
};

beforeEach(() => {
  fixture.reset();
  fixture.state.tables.repositories = [
    repo("look", { use_for_defaults: 1, use_for_logo: 1, use_for_icon: 1, use_for_name: 1, use_for_links: 1 }),
    repo("conn", { use_for_mcp: 1, use_for_chat_assistant: 1 }),
    repo("sys", { use_for_general: 1 }),
  ];
});

describe("the settings, as a part of them reads them", () => {
  test("Appearance on its own : the seeded fields, each Appearance page's repository, nothing else", async () => {
    const { body } = await find({ showAppearanceSettings: true });
    expect(body.seed_managed_fields).toBe('["app_name"]');
    for (const key of ["defaults", "logo", "icon", "name", "links"]) expect(body[`source_${key}`]).toEqual({ repository: "look", repo_file: `${key}.yaml` });
    expect(body.source_links).toEqual({ repository: "look", repo_file: "links.yaml" });
    for (const k of ["source_mcp", "source_chat_assistant", "source_general", "url", "mail_password"]) expect(body).not.toHaveProperty(k);
  });

  test("Connections on its own : the seeded MCP switches, the MCP's and the chat's repository", async () => {
    const { body } = await find({ showConnectionsSettings: true });
    expect(body.seed_managed_fields).toBe('["app_name"]');
    expect(body.source_mcp).toEqual({ repository: "conn", repo_file: "mcp.yaml" });
    expect(body.source_chat_assistant).toEqual({ repository: "conn", repo_file: "chat_assistant.yaml" });
    for (const k of ["source_defaults", "source_logo", "source_icon", "source_name", "source_links", "source_general", "app_name"]) expect(body).not.toHaveProperty(k);
  });

  test("every setting : every source ; a type no repository holds : null", async () => {
    fixture.state.tables.repositories = fixture.state.tables.repositories.filter((r) => r.name !== "sys");
    const { body } = await find({ showSettings: true });
    expect(body.source_general).toBe(null);
    expect(body.source_name.repository).toBe("look");
  });
});
