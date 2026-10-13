/* record-app-segments.js — capture the app segments of the demo GIF.

Run from the harness/ directory (needs the built app + electron):
  npx electron scripts/demo-gif/record-app-segments.js
or: APP_FRAMES_DIR=/somewhere npx electron scripts/demo-gif/record-app-segments.js

Captures, in order (10fps; the two run segments at 60fps for slow motion):
  A  suites list WITHOUT the agent-authored suite (its file is moved aside)
  B  suites list WITH it (the "it appeared" moment) -> open no-double-settle
  C  run no-double-settle (slow motion) + results hold
  D  ledger-chaos-kill: run (slow motion) + expand the ECONNRESET step row
  E  Protocol Registry
  F  Database: no-double-settle.db, SELECT * FROM accounts
  G  outro suites list (with the ✓ N passed badges)

Frames land in /tmp/app-frames/ (or APP_FRAMES_DIR) as fNNNN.png.
The segment boundaries (frame ranges) are consumed by compose_gif.py —
if you change a capture() duration here, update SEG there to match.
*/
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const HARNESS_DIR = path.join(__dirname, "..", "..");
const DIR = process.env.APP_FRAMES_DIR || "/tmp/app-frames";
const SUITE = path.join(HARNESS_DIR, "suites", "no-double-settle.json");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
let n = 0;

require(path.join(HARNESS_DIR, "dist", "main", "main", "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;

async function frame() {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(DIR, `f${String(n++).padStart(4, "0")}.png`), img.toPNG());
}

async function capture(sec, fps = 10) {
  const step = 1000 / fps;
  for (let t = 0; t < sec * 1000 - 1; t += step) {
    await frame();
    await sleep(step);
  }
}

const js = (expr) => win.webContents.executeJavaScript(expr);
const clickText = (text) =>
  js(`(() => {
    const els = Array.from(document.querySelectorAll("a, button, tr, [role=button]"));
    const el =
      els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})) ||
      els.find((e) => e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
// exact value match (the select holds per-suite DB filenames)
const selectOption = (value) =>
  js(`(() => {
    const sel = document.querySelector("select");
    if (!sel) return false;
    const opt = Array.from(sel.options).find((o) => o.value === ${JSON.stringify(value)});
    if (!opt) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    set.call(sel, opt.value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

app.whenReady().then(async () => {
  await sleep(1500);
  win = BrowserWindow.getAllWindows()[0];
  win.setSize(1280, 800);

  // A. BEFORE list — the agent-authored suite is not here yet
  fs.renameSync(SUITE, SUITE + ".hidden");
  await capture(4);
  fs.renameSync(SUITE + ".hidden", SUITE);
  await clickText("Protocol Registry");
  await sleep(250);
  await clickText("Suites"); // force a re-read of the suites dir
  await sleep(400);

  // B. AFTER list — no-double-settle has appeared
  await capture(2.5);
  console.log("open agent suite:", await clickText("no-double-settle"));
  await capture(1.5);

  // C. Run it (slow motion)
  console.log("run agent suite:", await clickText("Run suite"));
  await sleep(40);
  await capture(1.0, 60);
  await capture(3);

  // D. Chaos suite
  console.log("nav Suites:", await clickText("Suites"));
  await sleep(300);
  await capture(1);
  console.log("open chaos:", await clickText("ledger-chaos-kill"));
  await capture(2);
  console.log("run chaos:", await clickText("Run suite"));
  await sleep(40);
  await capture(0.6, 60);
  console.log("expand row:", await clickText("t8002-after-kill-fails"));
  await capture(3.5);

  // E. Protocol Registry
  console.log("nav registry:", await clickText("Protocol Registry"));
  await capture(3.5);

  // F. Database — the agent suite's per-suite DB
  console.log("nav db:", await clickText("Database"));
  await capture(1);
  console.log("select db:", await selectOption("no-double-settle.db"));
  await capture(0.5);
  console.log("run query:", await clickText("Run"));
  await capture(3);

  // G. Outro — suites list
  console.log("nav Suites (outro):", await clickText("Suites"));
  await capture(3);

  console.log("total frames:", n, "≈", n / 10, "s at 10fps ->", DIR);
  app.exit(0);
});
