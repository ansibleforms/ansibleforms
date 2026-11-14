// The settings answer (GET /api/v2/settings, Settings.find) never carries a mail_* column : the
// mail settings of before 7.6 went to the mail channels, and a database whose upgrade stopped
// part way may still hold some of the columns, mail_password with the login encrypted. The
// answer reads the row with SELECT *, so it leaves out every mail_* field it finds.
import { test, expect, vi } from "vitest";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";

// ------------------------------------------------------------------
// the settings row : an upgrade that left some of the mail columns
// ------------------------------------------------------------------
const row = {
  url: "https://af.example.com",
  app_name: "Ops Portal",
  mail_secure: 1,
  mail_username: "mailer",
  mail_password: "enc-pw",
  mail_from: "af@example.com",
};
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [{ ...row }] } }));
vi.mock("../src/models/repository.model.js", () => ({ default: {} }));
vi.mock("../src/models/lock.model.js", () => ({ default: {} }));
vi.mock("../src/lib/forms-git.js", () => ({ configRepoFromPath: () => null }));
const { default: Settings } = await import("../src/models/settings.model.js");

test("the settings answer leaves out every mail_* column a half-done upgrade left", async () => {
  const settings = await Settings.find();
  expect(Object.keys(settings).filter((k) => k.startsWith("mail_"))).toEqual([]);
  expect(JSON.stringify(settings)).not.toContain("enc-pw");
  // the other settings are still there
  expect(settings).toMatchObject({ url: "https://af.example.com", app_name: "Ops Portal" });
});
