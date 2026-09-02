import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");
const bumpScript = join(scriptsDir, "bump-version.mjs");
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function readVersions(root) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const cargoTomlVersion = /^version = "([^"]+)"/m.exec(cargoToml)?.[1];
  const cargoLockVersion = /name = "tododock"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1];
  return {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockWorkspace: packageLock.packages?.[""]?.version,
    tauriConfig: tauriConfig.version,
    cargoToml: cargoTomlVersion,
    cargoLock: cargoLockVersion,
  };
}

function copyVersionFiles(tempRoot) {
  mkdirSync(join(tempRoot, "src-tauri"), { recursive: true });
  for (const relativePath of versionFiles) {
    cpSync(join(repoRoot, relativePath), join(tempRoot, relativePath));
  }
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function expectedBump(version, kind) {
  const parsed = parseSemver(version);
  if (kind === "major") return `${parsed.major + 1}.0.0`;
  if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (kind === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

function currentRepoVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

function runBump(tempRoot, kind) {
  const result = spawnSync(process.execPath, [bumpScript, kind], {
    encoding: "utf8",
    env: { ...process.env, TODODOCK_VERSION_ROOT: tempRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("prints the current version without writing", () => {
  const current = currentRepoVersion();
  const printed = spawnSync(process.execPath, [bumpScript, "--print"], {
    encoding: "utf8",
    env: { ...process.env, TODODOCK_VERSION_ROOT: repoRoot },
  });
  assert.equal(printed.status, 0, printed.stderr || printed.stdout);
  assert.equal(printed.stdout.trim(), current);
  assert.equal(currentRepoVersion(), current);
});

test("patch bump writes the same version to all package files", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tododock-bump-"));
  const next = expectedBump(currentRepoVersion(), "patch");
  try {
    copyVersionFiles(tempRoot);
    assert.equal(runBump(tempRoot, "patch"), next);
    const versions = readVersions(tempRoot);
    for (const [label, version] of Object.entries(versions)) {
      assert.equal(version, next, label);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("minor and major bumps reset lower version numbers", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tododock-bump-"));
  const current = currentRepoVersion();
  const afterMinor = expectedBump(current, "minor");
  const afterMajor = expectedBump(afterMinor, "major");
  try {
    copyVersionFiles(tempRoot);
    assert.equal(runBump(tempRoot, "minor"), afterMinor);
    assert.equal(runBump(tempRoot, "major"), afterMajor);
    const versions = readVersions(tempRoot);
    for (const [label, version] of Object.entries(versions)) {
      assert.equal(version, afterMajor, label);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
