import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = JSON.parse(await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"));
const nsis = config.bundle?.windows?.nsis;
const wix = config.bundle?.windows?.wix;

if (!Array.isArray(nsis?.languages) || nsis.languages.length < 2) {
  throw new Error("NSIS installer must embed multiple languages");
}
if (nsis.languages[0] !== "English") {
  throw new Error("NSIS fallback language must be English when the OS language is unavailable");
}
for (const language of ["English", "SimpChinese", "TradChinese", "Japanese", "Korean"]) {
  if (!nsis.languages.includes(language)) {
    throw new Error(`NSIS installer is missing ${language}`);
  }
}
if (nsis.displayLanguageSelector !== false) {
  throw new Error("NSIS must default to the OS language instead of always showing a selector");
}

const wixLanguages = Array.isArray(wix?.language) ? wix.language : [wix?.language];
for (const language of ["zh-CN", "en-US"]) {
  if (!wixLanguages.includes(language)) {
    throw new Error(`WiX installer is missing ${language}`);
  }
}

console.log(
  `Installer i18n OK: NSIS ${nsis.languages.length} languages (OS default, fallback ${nsis.languages[0]}); WiX ${wixLanguages.join(", ")}`,
);
