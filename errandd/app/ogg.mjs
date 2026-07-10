import { readFile, writeFile } from "node:fs/promises";
import { OggOpusDecoder } from "ogg-opus-decoder";

function downmixToMono(channelData) {
  if (channelData.length === 0) return new Float32Array();
  if (channelData.length === 1) return channelData[0];

  const samples = channelData[0].length;
  const out = new Float32Array(samples);
  const scale = 1 / channelData.length;
  for (let i = 0; i < samples; i++) {
    let mixed = 0;
    for (const channel of channelData) mixed += channel[i] ?? 0;
    out[i] = mixed * scale;
  }
  return out;
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  if (input.length === 0) return new Float32Array();

  const targetLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(targetLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < targetLength; i++) {
    const srcIndex = i * ratio;
    const left = Math.floor(srcIndex);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcIndex - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }

  return output;
}

function encodeMonoPcm16Wav(samples, sampleRate) {
  const bytesPerSample = 2;
  const channels = 1;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(offset, pcm, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error("usage: node src/ogg.mjs <input.oga> <output.wav>");
    process.exit(2);
  }

  const decoder = new OggOpusDecoder({ forceStereo: false });
  try {
    await decoder.ready;
    const inputBytes = new Uint8Array(await readFile(inputPath));
    const decoded = await decoder.decodeFile(inputBytes);
    if (!decoded.channelData.length) {
      throw new Error("decoded audio is empty");
    }
    const mono = downmixToMono(decoded.channelData);
    const mono16k = resampleLinear(mono, decoded.sampleRate, 16000);
    const wavBytes = encodeMonoPcm16Wav(mono16k, 16000);
    await writeFile(outputPath, wavBytes);
  } finally {
    decoder.free();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
