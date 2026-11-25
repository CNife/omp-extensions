const REGEX_PRECEDING_KEYWORDS: Record<string, true> = {
  await: true,
  case: true,
  delete: true,
  do: true,
  else: true,
  in: true,
  instanceof: true,
  new: true,
  of: true,
  return: true,
  throw: true,
  typeof: true,
  void: true,
  yield: true,
};
const WORD = /[A-Za-z0-9_$]/;

type State = "code" | "line" | "block" | "single" | "double" | "template" | "regex" | "regexClass";

export function countCommentLines(text: string): number {
  const commentedLines = new Set<number>();
  let line = 0;
  let state: State = "code";
  let regexAllowed = true;
  let braceDepth = 0;
  const templateStack: number[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") line++;
    if (state === "line") {
      if (ch === "\n") state = "code";
      i++;
      continue;
    }
    if (state === "block") {
      if (ch === "\n") commentedLines.add(line);
      else if (ch === "*" && text[i + 1] === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "single" || state === "double") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) {
        state = "code";
        regexAllowed = false;
      }
      i++;
      continue;
    }
    if (state === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        regexAllowed = false;
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        braceDepth++;
        templateStack.push(braceDepth);
        state = "code";
        regexAllowed = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "regex" || state === "regexClass") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        state = "code";
        regexAllowed = false;
        i++;
        continue;
      }
      if (state === "regex" && ch === "[") {
        state = "regexClass";
        i++;
        continue;
      }
      if (state === "regexClass" && ch === "]") {
        state = "regex";
        i++;
        continue;
      }
      if (state === "regex" && ch === "/") {
        state = "code";
        regexAllowed = false;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      state = "line";
      commentedLines.add(line);
      i += 2;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      state = "block";
      commentedLines.add(line);
      i += 2;
      continue;
    }
    if (ch === "/" && regexAllowed) {
      state = "regex";
      i++;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i++;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i++;
      continue;
    }
    if (ch === "`") {
      state = "template";
      i++;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      regexAllowed = true;
      i++;
      continue;
    }
    if (ch === "}") {
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        braceDepth--;
        state = "template";
      } else {
        braceDepth--;
        regexAllowed = true;
      }
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      regexAllowed = false;
      i++;
      continue;
    }
    if ((ch === "+" || ch === "-") && text[i + 1] === ch) {
      regexAllowed = false;
      i += 2;
      continue;
    }
    if (WORD.test(ch)) {
      let end = i + 1;
      while (end < text.length && WORD.test(text[end]!)) end++;
      regexAllowed = REGEX_PRECEDING_KEYWORDS[text.slice(i, end)] === true;
      i = end;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      regexAllowed = false;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    regexAllowed = true;
    i++;
  }

  return commentedLines.size;
}
