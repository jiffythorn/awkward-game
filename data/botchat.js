/**
 * The Awkward Game — bot chat for single-player (browser)
 * botChatSay(event, bot, ctx) speaks in the chat box with two tiers:
 *   1. If the page is served over HTTP, ask rooms/botline.php — the host's
 *      configured provider chain (cloud -> custom -> local) answers, falling
 *      back to the template pack server-side. Client never sees any key.
 *   2. Offline (file:// or server error): the local template pack
 *      (data/botlines_js.js -> window.BOT_LINES).
 * Fire-and-forget: gameplay never waits on a provider.
 */
"use strict";

const BotChat = (() => {
  let mode = null; // null unknown, "http" once botline.php answers once, else "local"
  let localFailures = 0;

  function pick(groups, event, personality, ctx) {
    const byPers = groups[event];
    if (!byPers) return null;
    const pool = byPers[personality] || byPers.any || [];
    if (!pool.length) return null;
    let line = pool[Math.floor(Math.random() * pool.length)];
    for (const [k, v] of Object.entries(ctx || {})) {
      line = line.split("{" + k + "}").join(String(v));
    }
    return line;
  }

  function sayLocal(event, bot, ctx) {
    if (!window.BOT_LINES || !window.BOT_LINES.groups) return;
    const text = pick(window.BOT_LINES.groups, event, bot.personality, ctx);
    if (text) window.addChatMessage(bot.name, text);
  }

  function say(event, bot, ctx) {
    if (mode === "local") { sayLocal(event, bot, ctx); return; }
    if (mode === null) {
      // Probe once: file:// will throw immediately; a PHP host will answer.
      try {
        fetch("rooms/botline.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "probe", personality: bot.personality, name: bot.name }),
        }).then((r) => { mode = r.ok || r.status === 400 ? "http" : "local"; if (mode === "local") sayLocal(event, bot, ctx); })
          .catch(() => { mode = "local"; sayLocal(event, bot, ctx); });
      } catch { mode = "local"; sayLocal(event, bot, ctx); }
      // Meanwhile speak instantly from the pack so the moment isn't lost.
      sayLocal(event, bot, ctx);
      return;
    }
    // http mode
    fetch("rooms/botline.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event, personality: bot.personality, name: bot.name,
        ctx: { target: ctx && ctx.target, card: ctx && ctx.card, opt: ctx && ctx.opt, ap: ctx && ctx.ap },
      }),
    }).then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.ok && j.text) window.addChatMessage(bot.name, j.text);
        else sayLocal(event, bot, ctx);
      })
      .catch(() => { if (++localFailures >= 3) { mode = "local"; } sayLocal(event, bot, ctx); });
  }

  return { say };
})();

window.BotChat = BotChat;
