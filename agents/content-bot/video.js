'use strict';

/**
 * Turn a finished 9:16 branded frame (the Canva story export — photo + Gerhaus
 * headline + asterisk + CTA already baked in) into a short MOTION clip (Reel) via
 * a gentle Ken-Burns zoom, encoded with ffmpeg.
 *
 * WHY this approach: the Canva MCP cannot apply animation (no motion tool), AI
 * video isn't free/appropriate for a real kids' brand, and node-canvas can't
 * render the proprietary Gerhaus font. So we keep the exact on-brand Canva frame
 * and add subtle motion on top. The zoom is kept SMALL and centred so the text
 * never drifts out of frame. Real action footage still needs filmed clips.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const SECONDS = parseFloat(process.env.CONTENT_REEL_SECONDS || '6');
const FPS = 30;
const ZOOM_MAX = 1.06; // gentle — keeps baked-in text safely inside the frame

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin}: ${err.message} ${String(stderr).slice(0, 300)}`));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * @param {Buffer} pngBuffer  the 1080x1920 branded story frame
 * @param {object} [opts] { seconds }
 * @returns {Promise<Buffer>} MP4 (H.264, yuv420p, 1080x1920)
 */
async function kenBurnsReel(pngBuffer, { seconds = SECONDS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const inPng = path.join(dir, 'frame.png');
  const outMp4 = path.join(dir, 'reel.mp4');
  fs.writeFileSync(inPng, pngBuffer);
  const frames = Math.round(seconds * FPS);
  // Pre-scale up (reduces zoompan jitter), slow centred zoom-in to ZOOM_MAX,
  // render back to 1080x1920. yuv420p + faststart = IG/Reels-friendly.
  const perFrame = ((ZOOM_MAX - 1) / frames).toFixed(6);
  const vf = [
    'scale=2160:3840',
    `zoompan=z='min(zoom+${perFrame},${ZOOM_MAX})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');
  try {
    await run(FFMPEG, [
      '-y', '-loop', '1', '-i', inPng,
      '-t', String(seconds),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-movflags', '+faststart', '-an',
      outMp4,
    ]);
    const buf = fs.readFileSync(outMp4);
    logger.info({ bytes: buf.length, seconds }, 'reel encoded (ken burns)');
    return buf;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { kenBurnsReel };
