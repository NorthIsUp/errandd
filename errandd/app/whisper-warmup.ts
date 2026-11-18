import { errorMessage } from "../shared/errorMessage";
import { warmupWhisperAssets } from "./whisper";

async function main() {
  try {
    await warmupWhisperAssets({ printOutput: true });
    console.log("whisper warmup: ready");
  } catch (err) {
    console.error(`whisper warmup: failed - ${errorMessage(err)}`);
    process.exit(1);
  }
}

void main();
