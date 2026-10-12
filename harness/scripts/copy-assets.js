#!/usr/bin/env node
/* Copy non-TS assets that the compiled main process needs at runtime.
 * tsc does not emit JSON imports; registry.json must sit next to codec.js
 * in dist/main/protocol/. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "src", "protocol", "registry.json");
const out = path.join(root, "dist", "main", "protocol", "registry.json");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(src, out);
console.log(`copied ${path.relative(root, out)}`);
