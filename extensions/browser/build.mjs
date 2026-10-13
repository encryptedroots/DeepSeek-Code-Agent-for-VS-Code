import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const entry of ["background", "content", "popup"]) {
  await build({
    entryPoints: [`src/${entry}.ts`],
    outfile: `dist/${entry}.js`,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: true,
  });
}
await cp("manifest.json", "dist/manifest.json");
await cp("popup.html", "dist/popup.html");
await cp("icons", "dist/icons", { recursive: true });
