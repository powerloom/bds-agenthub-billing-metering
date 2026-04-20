import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Served by the Hono app at GET /metering/* (static export copied to web/out). */
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/metering",
  distDir: ".next",
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
