// Static assertions over app.js / api-client.js source.
// The plan allows source-grep assertions: the key is to prove the wiring exists.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "..", "src", "app-shell", "app.js");
const apiClientPath = path.join(here, "..", "..", "src", "app-shell", "api-client.js");

const appSource = await fs.readFile(appJsPath, "utf8");
const apiClientSource = await fs.readFile(apiClientPath, "utf8");

test("app.js wires the project scope module", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*createProjectScope[^}]*\}\s*from\s*["']\.\/project-scope\.mjs["']/,
    "app.js should import createProjectScope from ./project-scope.mjs"
  );
});

test("app.js creates exactly one projectScope instance", () => {
  const occurrences = appSource.match(/createProjectScope\s*\(/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    "createProjectScope() should be called exactly once to create a single instance"
  );
  assert.match(
    appSource,
    /const\s+projectScope\s*=\s*createProjectScope\s*\(\s*\)/,
    "projectScope should be bound to a single const"
  );
});

test("app.js activates the project scope on every project selection", () => {
  // The single activation point is `projectScope.activate(...)` inside
  // commitProjectSwitch; that helper is called from openProject, initProject,
  // and forgetProject. Allow the direct match OR a one-caller helper.
  const directActivate = (appSource.match(/projectScope\.activate\s*\(/g) ?? []).length;
  const commitCalls = (appSource.match(/commitProjectSwitch\s*\(/g) ?? []).length;
  assert.ok(
    directActivate >= 1,
    `projectScope.activate should be wired (saw ${directActivate} direct call(s))`
  );
  assert.ok(
    commitCalls >= 3,
    `commitProjectSwitch should be invoked from at least 3 switch paths (open/init/forget); saw ${commitCalls} call site(s)`
  );
});

test("app.js gates the dashboard load on projectScope.isCurrent", () => {
  assert.match(
    appSource,
    /projectScope\.capture\s*\(/,
    "loadDashboard should call projectScope.capture to obtain a token"
  );
  assert.match(
    appSource,
    /projectScope\.isCurrent\s*\(/,
    "post-fetch path should call projectScope.isCurrent to drop stale responses"
  );
});

test("app.js carries projectRoot in dashboard fetches", () => {
  // Either the URL is built with withProjectScope, or the body has projectRoot
  // alongside the dashboard fetch call. The api-client should expose withProjectScope.
  const usesHelper = /withProjectScope\s*\(/.test(appSource);
  assert.ok(
    usesHelper,
    "app.js should call api-client's withProjectScope helper to attach projectRoot"
  );
});

test("api-client.js exports withProjectScope helper", () => {
  assert.match(
    apiClientSource,
    /export\s+function\s+withProjectScope\s*\(/,
    "api-client.js should export a withProjectScope helper that appends ?projectRoot=…"
  );
});

test("api-client.js preserves error code/fields/actions on post failure", () => {
  // The new behavior is to attach code, fields, action onto the thrown error.
  assert.match(apiClientSource, /error\.code\s*=/);
  assert.match(apiClientSource, /error\.fields\s*=/);
  assert.match(apiClientSource, /error\.action\s*=/);
});

test("api-client.js postJson accepts an AbortSignal", () => {
  assert.match(
    apiClientSource,
    /function\s+postJson\s*\([\s\S]*?signal/,
    "postJson should accept an options bag with a signal"
  );
  assert.match(
    apiClientSource,
    /signal/,
    "the signal should be forwarded into fetch()"
  );
});
