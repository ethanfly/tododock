import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.env.TODODOCK_VERSION_ROOT
  ? resolve(process.env.TODODOCK_VERSION_ROOT)
  : resolve(import.meta.dirname, "..");
const packageJsonPath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const tauriConfigPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoTomlPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function bumpVersion(version, kind) {
  const parsed = parseSemver(version);
  if (kind === "major") return `${parsed.major + 1}.0.0`;
  if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (kind === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = source.match(new RegExp(pattern.source, flags));
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected one ${label} version field, found ${matches?.length ?? 0}`);
  }
  return source.replace(pattern, replacement);
}

function readCurrentVersion() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function writePackageLockVersion(next) {
  const source = readFileSync(packageLockPath, "utf8");
  const withRoot = replaceExactlyOnce(
    source,
    /^(\{\r?\n {2}"name": "tododock",\r?\n {2}"version": ")[^"]+"/,
    `$1${next}"`,
    "package-lock.json root",
  );
  const updated = replaceExactlyOnce(
    withRoot,
    /("": \{\r?\n {6}"name": "tododock",\r?\n {6}"version": ")[^"]+"/,
    `$1${next}"`,
    "package-lock.json workspace package",
  );
  const parsed = JSON.parse(updated);
  if (parsed.version !== next || parsed.packages?.[""]?.version !== next) {
    throw new Error("package-lock.json version write failed verification");
  }
  return updated;
}

function writeVersion(next) {
  const packageJson = replaceExactlyOnce(
    readFileSync(packageJsonPath, "utf8"),
    /"version": "[^"]+"/,
    `"version": "${next}"`,
    "package.json",
  );
  const tauriConfig = replaceExactlyOnce(
    readFileSync(tauriConfigPath, "utf8"),
    /"version": "[^"]+"/,
    `"version": "${next}"`,
    "tauri.conf.json",
  );
  const cargoToml = replaceExactlyOnce(
    readFileSync(cargoTomlPath, "utf8"),
    /^version = "[^"]+"/m,
    `version = "${next}"`,
    "Cargo.toml",
  );
  const cargoLock = replaceExactlyOnce(
    readFileSync(cargoLockPath, "utf8"),
    /name = "tododock"\r?\nversion = "[^"]+"/,
    (match) => match.replace(/version = "[^"]+"/, `version = "${next}"`),
    "Cargo.lock",
  );
  const packageLock = writePackageLockVersion(next);
  writeFileSync(packageJsonPath, packageJson);
  writeFileSync(packageLockPath, packageLock);
  writeFileSync(tauriConfigPath, tauriConfig);
  writeFileSync(cargoTomlPath, cargoToml);
  writeFileSync(cargoLockPath, cargoLock);
}

const kind = process.argv[2] ?? "patch";
const current = readCurrentVersion();
if (kind === "--print") {
  process.stdout.write(`${current}\n`);
  process.exit(0);
}

const next = bumpVersion(current, kind);
writeVersion(next);
process.stdout.write(`${next}\n`);
