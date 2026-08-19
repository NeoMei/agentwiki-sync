import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
if (
  manifest.version !== pkg.version ||
  lock.version !== pkg.version ||
  lock.packages?.[""]?.version !== pkg.version ||
  versions[manifest.version] !== manifest.minAppVersion
)
  throw new Error("Release versions are inconsistent");
for (const [name, range] of Object.entries(pkg.dependencies ?? {}))
  if (/^[~^*]|\s|\|\||[<>=]/u.test(range))
    throw new Error(`Runtime dependency ${name} must use an exact version`);
if (!releaseWorkflow.includes("actions/attest@v4"))
  throw new Error("Release workflow must attest release assets");
for (const file of ["main.js", "manifest.json", "styles.css"]) await readFile(file);
console.log(`Release metadata check passed (${manifest.version})`);
