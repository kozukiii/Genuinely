import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,          // exposes to LAN (iPhone can reach it)
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000", // backend stays private
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
