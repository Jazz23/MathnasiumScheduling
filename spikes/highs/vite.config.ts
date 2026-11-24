import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Same toolchain as the app: checks the plugin bundles highs.wasm as a WebAssembly.Module.
export default defineConfig({ plugins: [cloudflare()] });
