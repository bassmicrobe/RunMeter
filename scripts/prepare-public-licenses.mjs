import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const check = process.argv.slice(2).includes("--check");
const files = [
  ["LICENSE", "public/licenses/LICENSE.txt"],
  ["BRANDING_LICENSE.md", "public/licenses/BRANDING_LICENSE.txt"],
  ["THIRD_PARTY_NOTICES.txt", "public/licenses/THIRD_PARTY_NOTICES.txt"],
];

for (const [source, destination] of files) {
  const contents = (await readFile(new URL(source, root), "utf8")).replaceAll("\r\n", "\n");
  if (!contents.trim()) throw new Error(`Required license document is empty: ${source}`);
  const output = new URL(destination, root);
  if (check) {
    const saved = (await readFile(output, "utf8")).replaceAll("\r\n", "\n");
    if (saved !== contents) throw new Error(`Public license document is out of date: ${destination}`);
  } else {
    await mkdir(new URL("./", output), { recursive: true });
    await writeFile(output, contents);
  }
}
console.log(check ? "Public license documents match their sources." : "Prepared public license documents.");
