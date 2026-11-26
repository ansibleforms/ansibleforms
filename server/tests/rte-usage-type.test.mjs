// The RTE images' usage type : given by runner_rte: (not controller_), read by its own reader
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import * as types from "../src/lib/repoObjects/types.js";

describe("the RTE images' usage type", () => {
  test("its files give it by runner_rte:, the others keep controller_", () => {
    assert.equal(types.fileKeyOf("rte"), "runner_rte");
    assert.equal(types.fileKeyOf("credentials"), "controller_credentials");
    assert.equal(types.typeKeyOf("runner_rte"), "rte");
    assert.equal(types.typeKeyOf("controller_rte"), null);
    assert.equal(types.typeKeyOf("runner_credentials"), null);
    assert.ok(types.FILE_KEYS.includes("runner_rte"));
  });

  test("any number of repositories, a designer type no engine descriptor reads", () => {
    const rte = types.typeOf("rte");
    assert.equal(rte.flag, "use_for_rte");
    assert.equal(rte.category, "designer");
    assert.ok(!rte.oneOnly);
    assert.ok(!rte.objects);
    assert.ok(types.CONTENT_KEYS.includes("rte"));
  });
});
