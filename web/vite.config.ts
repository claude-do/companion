import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const vitePort = Number(process.env.VITE_PORT || "5175");
const apiPort = Number(process.env.VITE_API_PORT || "3458");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: vitePort,
    allowedHosts: ["companion-plus.claude.do"],
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
