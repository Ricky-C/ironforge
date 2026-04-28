import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// FlatCompat translates eslint-config-next's legacy-format config into
// ESLint 9 flat config. When eslint-config-next ships native flat config
// (likely with Next 15), this compat layer can be removed.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];
