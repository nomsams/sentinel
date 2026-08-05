import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean);

for (const [index, code] of scripts.entries()) {
  try {
    new Function(code);
  } catch (error) {
    throw new Error(`Inline script ${index} is invalid: ${error.message}`, { cause: error });
  }
}

console.log(`Parsed ${scripts.length} inline script(s) successfully.`);
