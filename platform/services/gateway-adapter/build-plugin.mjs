// 把 OpenClaw 插件打成自包含 bundle：内联 @irobot/* 与 typebox，仅 openclaw 保持 external
// （宿主提供）。产出 dist/ 为一个可直接 `openclaw plugins install <dist> --link` 的插件目录。
import { build } from "esbuild";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = here + "dist";
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [here + "src/openclaw-plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  // openclaw 由宿主运行时提供；其余（@irobot/*、zod、typebox）全部内联。
  external: ["openclaw", "openclaw/*"],
  outfile: dist + "/openclaw-plugin.js",
  logLevel: "info",
});

// 装载目录的最小 package.json：无依赖（全部已内联），runtime 指向内联产物。
writeFileSync(
  dist + "/package.json",
  JSON.stringify(
    {
      name: "irobot-gateway-adapter",
      version: "0.1.0",
      type: "module",
      openclaw: {
        extensions: ["./openclaw-plugin.js"],
        compat: { pluginApi: ">=2026.3.24-beta.2", minGatewayVersion: "2026.3.24-beta.2" },
      },
    },
    null,
    2,
  ) + "\n",
);
copyFileSync(here + "openclaw.plugin.json", dist + "/openclaw.plugin.json");

console.log("✓ plugin bundled → dist/ (openclaw-plugin.js + package.json + openclaw.plugin.json)");
