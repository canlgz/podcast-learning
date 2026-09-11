import fs from "node:fs/promises";
import path from "node:path";

/**
 * 不依賴 ffmpeg 取得音檔長度（秒）。
 * 支援 mp3（Xing/VBRI 或 CBR 推估）、wav、m4a/mp4。取不到時回傳 0。
 */
export async function readAudioDurationSeconds(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".wav") return await wavDuration(filePath);
    if (ext === ".m4a" || ext === ".mp4" || ext === ".aac") return await mp4Duration(filePath);
    return await mp3Duration(filePath);
  } catch {
    return 0;
  }
}

const MPEG_BITRATES = {
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
       2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
       3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
       2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
       3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MPEG_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

function id3v2Size(buffer) {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") return 0;
  const flags = buffer[5];
  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  return 10 + size + (flags & 0x10 ? 10 : 0);
}

function parseFrameHeader(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 2.5 : null;
  if (!version) return null;
  const layer = 4 - ((buffer[offset + 1] >> 1) & 0x03);
  if (layer < 1 || layer > 3) return null;
  const bitrateTable = MPEG_BITRATES[version === 2.5 ? 2 : version]?.[layer];
  const bitrate = bitrateTable?.[(buffer[offset + 2] >> 4) & 0x0f];
  const sampleRate = MPEG_RATES[version]?.[(buffer[offset + 2] >> 2) & 0x03];
  if (!bitrate || !sampleRate) return null;
  const padding = (buffer[offset + 2] >> 1) & 0x01;
  const channelMode = (buffer[offset + 3] >> 6) & 0x03;
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const frameLength =
    layer === 1
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, samplesPerFrame, frameLength, channelMode };
}

async function mp3Duration(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(Math.min(256 * 1024, stat.size));
    await handle.read(head, 0, head.length, 0);

    const audioStart = id3v2Size(head);
    let frameOffset = -1;
    let frame = null;
    for (let i = audioStart; i < head.length - 4; i += 1) {
      const candidate = parseFrameHeader(head, i);
      if (candidate && parseFrameHeader(head, i + candidate.frameLength)) {
        frameOffset = i;
        frame = candidate;
        break;
      }
    }
    if (!frame) return 0;

    // Xing / Info (VBR) 標頭帶有總 frame 數，最準。
    const sideInfo = frame.version === 1 ? (frame.channelMode === 3 ? 17 : 32) : frame.channelMode === 3 ? 9 : 17;
    const tagOffset = frameOffset + 4 + sideInfo;
    const tag = head.toString("ascii", tagOffset, tagOffset + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = head.readUInt32BE(tagOffset + 4);
      if (flags & 0x01) {
        const frames = head.readUInt32BE(tagOffset + 8);
        if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate;
      }
    }
    const vbri = head.toString("ascii", frameOffset + 4 + 32, frameOffset + 4 + 36);
    if (vbri === "VBRI") {
      const frames = head.readUInt32BE(frameOffset + 4 + 32 + 14);
      if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate;
    }

    // 退回 CBR 推估（podcast 多為固定位元率，誤差通常 < 1%）。
    const audioBytes = stat.size - audioStart;
    return (audioBytes * 8) / (frame.bitrate * 1000);
  } finally {
    await handle.close();
  }
}

async function wavDuration(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(4096);
    await handle.read(head, 0, head.length, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF") return 0;
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 < head.length) {
      const id = head.toString("ascii", offset, offset + 4);
      const size = head.readUInt32LE(offset + 4);
      if (id === "fmt ") byteRate = head.readUInt32LE(offset + 16);
      if (id === "data" && byteRate) return size / byteRate;
      offset += 8 + size + (size % 2);
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function mp4Duration(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const scan = Buffer.alloc(Math.min(2 * 1024 * 1024, stat.size));
    await handle.read(scan, 0, scan.length, 0);
    const idx = scan.indexOf(Buffer.from("mvhd", "ascii"));
    if (idx === -1) return 0;
    const version = scan[idx + 4];
    if (version === 1) {
      const timescale = scan.readUInt32BE(idx + 4 + 4 + 8 + 8);
      const duration = Number(scan.readBigUInt64BE(idx + 4 + 4 + 8 + 8 + 4));
      return timescale ? duration / timescale : 0;
    }
    const timescale = scan.readUInt32BE(idx + 4 + 4 + 4 + 4);
    const duration = scan.readUInt32BE(idx + 4 + 4 + 4 + 4 + 4);
    return timescale ? duration / timescale : 0;
  } finally {
    await handle.close();
  }
}
