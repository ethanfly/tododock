const targets = {
  "windows-x64": { os: "Windows", arch: "X64" },
  "windows-arm64": { os: "Windows", arch: "ARM64" },
  "macos-arm64": { os: "macOS", arch: "ARM64" },
  "macos-x64": { os: "macOS", arch: "X64" },
  "linux-x64": { os: "Linux", arch: "X64" },
  "linux-arm64": { os: "Linux", arch: "ARM64" },
};

const localOs = { win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform];
const localArch = { x64: "X64", arm64: "ARM64" }[process.arch];
const targetName = process.argv[2] ?? process.env.TODODOCK_BUILD_TARGET;
const expected = targets[targetName];
if (!expected) {
  throw new Error(`Unknown TodoDock build target: ${targetName ?? "missing"}`);
}

const actual = {
  os: process.env.RUNNER_OS ?? localOs,
  arch: process.env.RUNNER_ARCH ?? localArch,
};
if (actual.os !== expected.os || actual.arch !== expected.arch) {
  throw new Error(
    `Build host mismatch for ${targetName}: expected ${expected.os}/${expected.arch}, got ${actual.os}/${actual.arch}`,
  );
}

console.log(`Verified build host for ${targetName}: ${actual.os}/${actual.arch}.`);
