const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { FuseVersion, FuseV1Options } = require("@electron/fuses");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { getWindowsSignOptions } = require("./scripts/windows-signing.cjs");
const windowsSign = getWindowsSignOptions();

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "RunMeter",
    appBundleId: "jp.cybereye-tech.runmeter",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Copyright © 2026 サイバーアイ・テクノロジー株式会社",
    icon: path.resolve(__dirname, "assets", "runmeter"),
    extraResource: [
      path.resolve(__dirname, "assets"),
      path.resolve(__dirname, "dist", "bridge"),
      path.resolve(__dirname, "dist", "licenses"),
    ],
    ignore: [
      /^\/main\.ts$/,
      /^\/bridge\.ts$/,
      /^\/navigation-policy\.ts$/,
      /^\/installer\.ts$/,
      /^\/shell-path\.ts$/,
      /^\/tests(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/licenses(?:\/|$)/,
      /^\/tsconfig\.json$/,
      /^\/forge\.config\.cjs$/,
      /^\/dist\/bridge(?:\/|$)/,
      /^\/dist\/licenses(?:\/|$)/,
      /^\/out(?:\/|$)/,
      // The Windows Bridge runtime is an optional npm dependency copied into
      // resources/bridge; it must not be duplicated inside app.asar.
      /^\/node_modules\/node-win-x64(?:\/|$)/,
      // Download cache for the macOS Bridge runtime archive.
      /^\/node_modules\/\.cache(?:\/|$)/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "RunMeterDesktop",
        authors: "サイバーアイ・テクノロジー株式会社",
        description:
          "CodexとClaudeの利用率・リセット日時を端末内で確認するRunMeter",
        exe: "RunMeter.exe",
        setupExe: "RunMeterSetup.exe",
        setupIcon: path.resolve(__dirname, "assets", "runmeter.ico"),
        iconUrl: "https://run-meter.vercel.app/favicon.ico",
        noMsi: true,
        // Squirrel's default nuspec does not include top-level HTML files.
        additionalFiles: [
          { src: "LICENSES.chromium.html", target: "lib\\net45\\LICENSES.chromium.html" },
        ],
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
    {
      // An unsigned preview ZIP of RunMeter.app. maker-zip also targets win32
      // by default, so it is limited to macOS here.
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  hooks: {
    // Electron keeps LICENSE and LICENSES.chromium.html beside Electron.app on
    // macOS, outside the bundle that is zipped. Copy them into Resources so the
    // distributed app retains them.
    packageAfterExtract: async (_config, buildPath, _electronVersion, platform) => {
      if (platform !== "darwin") return;
      const resources = path.join(buildPath, "Electron.app", "Contents", "Resources");
      for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
        fs.copyFileSync(path.join(buildPath, name), path.join(resources, name));
      }
    },
    // Renaming and the Info.plist change invalidate Electron's ad-hoc
    // signature, and a quarantined bundle with a broken seal is reported as
    // damaged with no way to open it. Until Developer ID signing is set up,
    // re-seal the whole bundle ad hoc so Gatekeeper offers "Open Anyway".
    postPackage: async (config, { platform, outputPaths }) => {
      if (platform !== "darwin" || config.packagerConfig.osxSign) return;
      for (const outputPath of outputPaths) {
        const bundle = path.join(outputPath, "RunMeter.app");
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
        execFileSync("codesign", ["--verify", "--deep", "--strict", bundle]);
      }
    },
  },
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
