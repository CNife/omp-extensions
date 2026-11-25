import { expect, test } from "bun:test";

import { countCommentLines } from "./comments.ts";

test("字符串里的 // 与 /* 不是注释", () => {
  expect(countCommentLines('const url = "https://example.com";')).toBe(0);
  expect(countCommentLines("const s = '/* not a comment */';")).toBe(0);
  expect(countCommentLines('const t = `// not a comment`;')).toBe(0);
});

test("正则里的 // 不是注释", () => {
  expect(countCommentLines("const r = /[//]/;")).toBe(0);
  expect(countCommentLines("const r = /a\\/\\/b/;")).toBe(0);
});

test("除法不被当成正则起点", () => {
  expect(countCommentLines("const x = a / b; // 说明")).toBe(1);
  expect(countCommentLines("let n = 10 / 2 / 5;")).toBe(0);
  expect(countCommentLines("x = y[0] / 2; // 说明")).toBe(1);
});

test("行注释按行计，块注释按跨行数计", () => {
  expect(countCommentLines("// a\n// b\ncode();")).toBe(2);
  expect(countCommentLines("/* a\nb\nc */\ncode();")).toBe(3);
  expect(countCommentLines("code(); /* a */ // b")).toBe(1);
  expect(countCommentLines("code(); /* a */\n// b")).toBe(2);
});

test("模板表达式里的注释计入，模板文本里的不计入", () => {
  expect(countCommentLines("const t = `a // b ${x /* c */}`;")).toBe(1);
  expect(countCommentLines("const t = `${/* a */ x}`;")).toBe(1);
  expect(countCommentLines("const t = `text ${`nested // text`}`;")).toBe(0);
});

test("shebang 不计入", () => {
  expect(countCommentLines("#!/usr/bin/env bun\ncode();")).toBe(0);
});
