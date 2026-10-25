const path = require("node:path");

const { FuseVersion, FuseV1Options } = require("@electron/fuses");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");

const certificateFile = process.env.RUNMETER_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.RUNMETER_WINDOWS_CERTIFICATE_PASSWORD;

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "RunMeter",
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
      /^\/tests(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/tsconfig\.json$/,
      /^\/forge\.config\.cjs$/,
      /^\/dist\/bridge(?:\/|$)/,
      /^\/dist\/licenses(?:\/|$)/,
      /^\/out(?:\/|$)/,
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
        ...(certificateFile && certificatePassword
          ? { certificateFile, certificatePassword }
          : {}),
      },
    },
  ],
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
