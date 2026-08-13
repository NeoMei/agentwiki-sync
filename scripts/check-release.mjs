import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) throw new Error("Release versions are inconsistent");
for (const file of ["main.js", "manifest.json", "styles.css"]) await readFile(file);
console.log(`Release metadata check passed (${manifest.version})`);
