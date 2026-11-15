/**
 * The filesystem without Electron's asar layer, for moving whole installs around.
 *
 * Electron patches `fs` so an `app.asar` archive reads as a directory. Deleting
 * an install through that view walks INTO the archive and unlinks each virtual
 * entry — every one fails, `rm`'s retries multiply it, and the archive file
 * itself is never removed. MEASURED with the 87MB archive left in
 * `/Applications/Loop.app.old`: 78s, then `ENOTEMPTY … Contents/Resources`.
 * The same `rm` without the asar layer took 1ms. That is what made "restart
 * to update" sit for minutes, and what left `Loop.app.old` behind holding
 * nothing but its `app.asar`.
 *
 * `original-fs` is Electron's unpatched copy of `fs`. Outside Electron (the
 * tests, under bun) plain `fs` has no asar layer to begin with.
 */
type Fs = typeof import("node:fs");

const fs: Fs = process.versions["electron"]
  ? (require("original-fs") as Fs)
  : (require("node:fs") as Fs);

export const existsSync = fs.existsSync;
export const { readdir, rename, rm } = fs.promises;
