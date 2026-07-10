import { warmupWhisperAssets } from "./whisper";

async function main() {
  try {
    await warmupWhisperAssets({ printOutput: true });
    console.log("whisper warmup: ready");
  } catch (err) {
    console.error(`whisper warmup: failed - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
