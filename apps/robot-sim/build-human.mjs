// 把 VRM 数字人引擎（含 three + @pixiv/three-vrm）打成浏览器 bundle：web/human-vrm.bundle.js
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
await build({
  entryPoints: [here + "web/human-vrm.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: here + "web/human-vrm.bundle.js",
  logLevel: "info",
});
console.log("✓ VRM 数字人引擎已打包 → web/human-vrm.bundle.js");
