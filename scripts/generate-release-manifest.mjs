import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const manifestName = "release-manifest.json";
const checksumName = "checksums-sha256.txt";
const bundleRoot = resolve(process.argv[2] ?? "src-tauri/target/release/bundle");

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith(".app") && !entry.name.endsWith(".dSYM")) {
      files.push(...await collectFiles(path));
    }
    if (entry.isFile() && ![manifestName, checksumName].includes(entry.name)) files.push(path);
  }
  return files;
}

function commandVersion(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"));
const cargoMetadata = JSON.parse(execFileSync(
  "cargo",
  ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "src-tauri/Cargo.toml"],
  { encoding: "utf8" },
));
const cargoPackage = cargoMetadata.packages.find((item) => item.name === packageJson.name);
const versions = new Set([packageJson.version, tauriConfig.version, cargoPackage?.version]);
if (!cargoPackage || versions.has(undefined) || versions.size !== 1) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, tauri.conf.json=${tauriConfig.version}, Cargo.toml=${cargoPackage?.version ?? "missing"}`,
  );
}

const paths = (await collectFiles(bundleRoot)).sort((left, right) => left.localeCompare(right));
if (paths.length === 0) throw new Error(`No release artifacts found in ${bundleRoot}`);

const files = await Promise.all(paths.map(async (path) => {
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return {
    path: relative(bundleRoot, path).split(sep).join("/"),
    bytes: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}));

const manifest = {
  schemaVersion: 1,
  product: "TodoDock",
  appVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  source: {
    commit: process.env.GITHUB_SHA ?? "uncommitted-worktree",
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  },
  builder: {
    os: process.env.RUNNER_OS ?? process.platform,
    arch: process.env.RUNNER_ARCH ?? process.arch,
    node: process.version,
    rustc: commandVersion("rustc"),
    cargo: commandVersion("cargo"),
  },
  files,
};

await writeFile(join(bundleRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(
  join(bundleRoot, checksumName),
  `${files.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`,
  "utf8",
);

console.log(`Wrote ${basename(join(bundleRoot, manifestName))} for ${files.length} artifact(s).`);
