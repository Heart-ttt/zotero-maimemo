import js from "@eslint/js";

// 这个项目没有 PEP 8 那样的官方规范，用 ESLint 把约定写成可执行的规则。
// 原则：宁可啰嗦也要看得懂，不为少写几个字符牺牲可读性。
export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        // 插件运行在 Zotero（Firefox）里，这些是宿主提供的。
        Zotero: "readonly",
        Services: "readonly",
        Components: "readonly",
        ChromeUtils: "readonly",
        IOUtils: "readonly",
        PathUtils: "readonly",
        globalThis: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setImmediate: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      // 命名与可读性
      "camelcase": ["error", { properties: "never", allow: ["^voc_", "^next_study", "^added_count", "^last_", "^first_", "^study_", "^is_", "^as_"] }],
      "id-length": ["error", { min: 3, exceptions: ["id", "ok", "to", "fn"], properties: "never" }],
      "func-style": ["error", "declaration", { allowArrowFunctions: true }],

      // 不为极简牺牲可读性
      "curly": ["error", "multi-line"],
      "max-len": ["error", { code: 110, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true }],
      "max-statements-per-line": ["error", { max: 2 }],
      "max-depth": ["error", 4],

      // 容易出错的写法
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      "no-param-reassign": ["error", { props: false }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-return-await": "error",
      // 不开 require-await：接口方法标成 async 是在声明「这是异步的」，
      // 哪怕实现只是把下游的 Promise 原样返回。为少写一个关键字让调用方
      // 去猜返回的是不是 Promise，不划算。
    },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    rules: {
      // 测试和构建脚本允许更长的行与更短的临时名。
      "max-len": ["error", { code: 130, ignoreStrings: true, ignoreTemplateLiterals: true }],
      "id-length": "off",
      // 测试里的假对象经常一行写完一个小接口，放宽到 3 条语句。
      "max-statements-per-line": ["error", { max: 3 }],
    },
  },
];
