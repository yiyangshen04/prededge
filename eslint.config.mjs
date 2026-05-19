import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Also ignore .next builds nested under Claude Code worktrees, the
    // bundled echarts.min.js, and Playwright/MCP scratch dirs — they're
    // generated, vendored, or transient and shouldn't fail CI lint.
    "**/.next/**",
    ".claude/**",
    ".playwright-mcp/**",
    ".playwright-cli/**",
    "output/**",
    "tmp/**",
    "public/mstr-timeline/mstr_timeline_sources/vendor/**",
  ]),
]);

export default eslintConfig;
