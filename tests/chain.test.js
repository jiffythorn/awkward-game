/**
 * Failover-chain end-to-end test for the bot-brain system.
 * Boots a PHP server + a stub OpenAI-compatible provider, then asserts:
 *   1. config save/read round-trip through rooms/ai.php (admin API)
 *   2. a dead local provider in the chain is skipped without stalling
 *   3. the live stub answers and its text reaches botline.php (source=stub id)
 *   4. with the stub dead, the template tier answers UNLESS a real local AI
 *      server (e.g. Ollama) is actually running on this machine — the chain is
 *      allowed to use it! The test only asserts a non-stub source answered.
 *   5. models.php proxies a live model list from the stub
 *   6. admin auth: wrong X-Admin-Key -> 403
 * Run: node tests/chain.test.js   (starts/stops its own servers)
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PHP_PORT = 8177, STUB_PORT = 8178;
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const CONFIG = path.join(__dirname, "..", "rooms", "config.php");
const BACKUP = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : null;

let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { passed++; console.log("  ✓ " + label); } else { failed++; console.log("  ✗ FAIL: " + label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Stub OpenAI-compatible server: /v1/chat/completions + /v1/models */
function startStub() {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/models")) {
        res.end(JSON.stringify({ data: [{ id: "stub-mini" }, { id: "stub-large" }] }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: "PONG from stub" } }] }));
      }
    });
  });
  return new Promise((resolve) => srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv)));
}

function wait(port) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); return resolve(true); } catch {}
      await sleep(100);
    }
    resolve(false);
  });
}

async function main() {
  // clean slate: remove any config so we start from defaults
  if (BACKUP !== null) fs.rmSync(CONFIG);

  const stub = await startStub();
  const php = spawn("php", ["-S", `127.0.0.1:${PHP_PORT}`, "-t", path.join(__dirname, "..")], { stdio: "ignore" });
  ok(await wait(PHP_PORT), "php server up");
  ok(await wait(STUB_PORT), "stub provider up");

  try {
    console.log("— admin API: save chain config");
    const save = await j(`${BASE}/rooms/ai.php?action=save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: {
        enabled: true,
        order: ["ghostlocal", "stub", "ollama"],           // dead local first!
        customProviders: [
          { id: "stub", label: "Stub provider", kind: "custom",
            url: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, model: "stub-mini", keyEnv: null },
          { id: "ghostlocal", label: "Dead local", kind: "local",
            url: "http://127.0.0.1:9/v1/chat/completions", model: "x", keyEnv: null },
        ],
        adminKey: "test-key-123",
      } }),
    });
    ok(save.json && save.json.ok === true, "config saved");

    console.log("— admin auth");
    const bad = await j(`${BASE}/rooms/ai.php?action=catalog`, { headers: { "X-Admin-Key": "wrong" } });
    ok(bad.status === 403, "wrong admin key rejected (403)");
    const good = await j(`${BASE}/rooms/ai.php?action=catalog`, { headers: { "X-Admin-Key": "test-key-123" } });
    ok(good.status === 200 && Array.isArray(good.json.providers), "catalog lists providers");
    ok(JSON.stringify(good.json.chain) === JSON.stringify(["ghostlocal", "stub", "ollama"]), "chain order preserved (dead local first)");
    ok(good.json.providers.some((p) => p.id === "stub" && p.custom === true), "custom provider visible in catalog");
    ok(good.json.providers.every((p) => !("key" in p)), "no keys leaked in catalog");

    console.log("— chain behavior via botline.php");
    const line1 = await j(`${BASE}/rooms/botline.php`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "scenarioDo", personality: "brutal", name: "Brutal Bot" }),
    });
    ok(line1.json && line1.json.ok === true, "botline answered");
    ok(line1.json && line1.json.source === "stub", `live provider used after skipping dead local (source=${line1.json && line1.json.source})`);
    ok(line1.json && line1.json.text === "PONG from stub", "stub text passed through");

    console.log("— template fallback when every provider fails");
    stub.close(); await sleep(150);           // kill the stub: ghost still dead, ollama absent
    const line2 = await j(`${BASE}/rooms/botline.php`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "sabotageUsed", personality: "chaotic", name: "Chaotic Bot", ctx: { target: "Jeff" } }),
    });
    ok(line2.json && line2.json.ok === true, "botline still answered");
    ok(line2.json && line2.json.source !== "stub", `a non-stub tier caught the fall (source=${line2.json && line2.json.source})`);
    ok(line2.json && (line2.json.source === "template" || /Jeff/.test(line2.json.text) || line2.json.text.length > 3), "answer is usable");

    console.log("— live model list proxy");
    // stub is down; restart for the models check
    const stub2 = await startStub();
    await sleep(150);
    const models = await j(`${BASE}/rooms/models.php?provider=stub`, { headers: { "X-Admin-Key": "test-key-123" } });
    ok(models.json && models.json.count === 2 && models.json.models.includes("stub-mini"), "models.php proxied the live list");
    const modelsNoKey = await j(`${BASE}/rooms/models.php?provider=stub`);
    ok(modelsNoKey.status === 403, "models.php enforces admin key");
    stub2.close();

    console.log("— test endpoint");
    const stub3 = await startStub(); await sleep(150);
    const t = await j(`${BASE}/rooms/ai.php?action=test`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": "test-key-123" },
      body: JSON.stringify({ provider: "stub" }),
    });
    ok(t.json && t.json.ok === true && t.json.reply === "PONG from stub", "ai.php test action works end-to-end");
    stub3.close();
  } finally {
    php.kill();
    stub.close();
    if (BACKUP !== null) fs.writeFileSync(CONFIG, BACKUP); else if (fs.existsSync(CONFIG)) fs.rmSync(CONFIG);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
