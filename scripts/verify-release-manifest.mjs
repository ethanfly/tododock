import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

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

function normalizedRelativePath(path) {
  return relative(bundleRoot, path).split(sep).join("/");
}

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(bundleRoot, manifestName), "utf8"));
if (manifest.schemaVersion !== 1) {
  throw new Error(`Unsupported release manifest schema: ${manifest.schemaVersion}`);
}
if (manifest.appVersion !== packageJson.version) {
  throw new Error(
    `Release manifest version mismatch: manifest=${manifest.appVersion}, package=${packageJson.version}`,
  );
}
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error("Release manifest contains no artifacts");
}

const artifactPaths = (await collectFiles(bundleRoot))
  .map(normalizedRelativePath)
  .sort((left, right) => left.localeCompare(right));
const manifestPaths = manifest.files
  .map((file) => file.path)
  .sort((left, right) => left.localeCompare(right));
if (JSON.stringify(artifactPaths) !== JSON.stringify(manifestPaths)) {
  throw new Error(
    `Release artifact set mismatch:\nmanifest=${manifestPaths.join(",")}\ndisk=${artifactPaths.join(",")}`,
  );
}

for (const file of manifest.files) {
  if (
    typeof file.path !== "string"
    || file.path.startsWith("/")
    || file.path.includes("..")
    || !Number.isSafeInteger(file.bytes)
    || typeof file.sha256 !== "string"
  ) {
    throw new Error(`Invalid release manifest entry: ${JSON.stringify(file)}`);
  }
  const path = join(bundleRoot, ...file.path.split("/"));
  const metadata = await stat(path);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (metadata.size !== file.bytes || sha256 !== file.sha256) {
    throw new Error(
      `Release artifact mismatch for ${file.path}: expected ${file.bytes}/${file.sha256}, got ${metadata.size}/${sha256}`,
    );
  }
}

const expectedChecksums = `${manifest.files
  .map((file) => `${file.sha256}  ${file.path}`)
  .join("\n")}\n`;
const checksums = await readFile(join(bundleRoot, checksumName), "utf8");
if (checksums !== expectedChecksums) {
  throw new Error(`${checksumName} does not match ${manifestName}`);
}

console.log(`Verified ${manifest.files.length} release artifact(s) for TodoDock ${manifest.appVersion}.`);
