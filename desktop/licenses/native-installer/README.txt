RunMeter native installer third-party licenses

These documents cover Squirrel.Windows, its execution stub and bootstrapper,
and the third-party code incorporated into its updater. They apply to those
components only. RunMeter's own code remains MIT; its brand assets retain the
separate terms in BRANDING_LICENSE.md.

sources.json records the exact electron-winstaller vendor release, SHA-256
hashes compared against the official upstream binaries, the updater's recorded
Squirrel source revision, and the document groups. Each group's sources.json
records original license sources, exact local hashes, component versions, and
source archive links. A source header excerpt retains its original comments;
the original file hash and line range identify the extracted license block.

Squirrel.Windows source, including the exact vendored WTL 9.0 headers:
https://github.com/Squirrel/Squirrel.Windows/tree/eef37460aef77b2f9de8cd2237c1e55b344a6554

Download that source revision (including the vendored WTL headers):
https://github.com/Squirrel/Squirrel.Windows/archive/eef37460aef77b2f9de8cd2237c1e55b344a6554.zip

Exact WTL source location (CPL-1.0):
https://github.com/Squirrel/Squirrel.Windows/tree/eef37460aef77b2f9de8cd2237c1e55b344a6554/src/Setup/wtl90

NuGet's submodule has a separate pinned source archive in its document group.
Other components' original source download links are recorded alongside their
license documents. RunMeter makes no changes to these upstream source files.

The updater's Microsoft.Web.Xdt 2.1.1 component uses its original Microsoft
XDT-specific license, rather than MIT or the license of a later XDT release.
Its preserved terms include Windows-only use and conditions for redistribution
and distributor/end-user protections. The archived official original and the
versioned package's license-link provenance are kept in the managed group.

The 7z executables and DLLs in the build tool's vendor directory are not
included in RunMeter's distributed application or Squirrel payload. Setup's
unzip code uses the attributed zlib implementation instead.

Preparation checks these pinned documents and original vendor binary hashes
without network access. Updating the vendor release requires a fresh source
and notice audit. The package verifier checks all notice document hashes;
the installer verifier checks their actual inclusion in the Squirrel payload.
