// Run from frontend: node scripts/generate-office-traffic.mjs
// Copy exact recorded samples; never rerun simulation or change visit counts.
import { createHash } from "node:crypto";
import { log } from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const directory = new URL("../src/studio/office-demo/", import.meta.url);
const recordingBytes = await readFile(new URL("recording.json", directory));
const recording = JSON.parse(recordingBytes);
const building = JSON.parse(
  await readFile(
    new URL("../src/editor/presets/office-demo.json", import.meta.url),
  ),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const asset = {
  source: {
    recording: "recording.json",
    recording_sha256: sha256(recordingBytes),
    building_sha256: sha256(JSON.stringify(building)),
  },
  width: recording.width,
  height: recording.height,
  traffic_samples: recording.traffic_samples,
};
await writeFile(
  new URL("traffic.json", directory),
  JSON.stringify(asset, null, 2) + "\n",
);
log(`Copied ${asset.traffic_samples.length} recorded office traffic samples.`);
