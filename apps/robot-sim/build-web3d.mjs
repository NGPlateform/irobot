// 把 3D 场景（含 three）打成浏览器 bundle：web/scene3d.bundle.js
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
await build({
  entryPoints: [here + "web/scene3d.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: here + "web/scene3d.bundle.js",
  logLevel: "info",
});
console.log("✓ 3D 场景已打包 → web/scene3d.bundle.js");
