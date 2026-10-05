#!/usr/bin/env node
// Prints launch.env as shell `export` lines for the .sh scripts (values single-quoted, so nothing is executed).
//   eval "$(node tools/env.js)"
const { readEnv } = require("./lib");

const env = readEnv();
for (const [k, v] of Object.entries(env)) {
  console.log(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
}
