import assert from "node:assert/strict";
import test from "node:test";

import { createComposer } from "../../src/app-shell/composer.js";

function makeComposer() {
  return createComposer({
    refs: {},
    getCurrentProjectRoot: () => "D:\\novels\\demo",
    getDashboard: () => ({}),
    loadDashboard: async () => {},
    openDrawer: () => {},
    openSettingsModal: () => {},
    openCreateModal: () => {},
    showToast: () => {},
    showActionError: () => {},
    threadRenderer: {},
    getAskEntries: () => new Map(),
    ensureRefreshLoop: () => {}
  });
}

test("/model with a model id is parsed as a model switch command", () => {
  const composer = makeComposer();
  assert.deepEqual(
    composer.parseUserCommand("/model mimo-v2.5-pro", "main"),
    {
      type: "model",
      content: "mimo-v2.5-pro",
      raw: "/model mimo-v2.5-pro",
      shouldAffectMainTask: false
    }
  );
});

test("/model without an id is parsed as a model picker command", () => {
  const composer = makeComposer();
  assert.deepEqual(
    composer.parseUserCommand("/model", "main"),
    {
      type: "model",
      content: "",
      raw: "/model",
      shouldAffectMainTask: false
    }
  );
});
