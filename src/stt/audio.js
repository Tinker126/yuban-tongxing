import { spawn } from 'node:child_process';
import { SttError } from './errors.js';

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 25;
export const MIME_TYPES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/x-m4a']);
const PCM_BYTES_PER_SECOND = 16000 * 2;

export function audioFormat(audio, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.includes(mime)) throw new SttError('STT_UNSUPPORTED_AUDIO', 415);
  if (!Buffer.isBuffer(audio) || !audio.length) throw new SttError('STT_EMPTY_AUDIO', 400);
  if (audio.length > MAX_AUDIO_BYTES) throw new SttError('STT_AUDIO_TOO_LARGE', 413);
  let format;
  if (mime === 'audio/webm' && audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) format = 'matroska';
  if (mime === 'audio/ogg' && audio.toString('ascii', 0, 4) === 'OggS') format = 'ogg';
  if (['audio/mp4', 'audio/x-m4a'].includes(mime) && audio.toString('ascii', 4, 8) === 'ftyp') format = 'mov';
  if (['audio/wav', 'audio/x-wav'].includes(mime) && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') format = 'wav';
  if (!format) throw new SttError('STT_INVALID_AUDIO', 400);
  return format;
}

export function ffmpegAvailable(ffmpegPath = 'ffmpeg', spawnImpl = spawn) {
  return new Promise(resolve => {
    let process;
    try { process = spawnImpl(ffmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(false); }, 3000);
    process.once('error', () => { clearTimeout(timer); resolve(false); });
    process.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

// Bytes stay in pipes and bounded memory. No upload URL or file path is passed to FFmpeg.
// This normalized PCM boundary can later feed an explicitly enabled assessment provider.
export async function transcodeAudio({ audio, mimeType, signal, ffmpegPath = 'ffmpeg', spawnImpl = spawn }) {
  const format = audioFormat(audio, mimeType);
  if (signal?.aborted) throw new SttError('STT_ABORTED', 499);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false, failure = null, child;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; reject(error); return; }
      const pcm = Buffer.concat(chunks, size);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (!pcm.length) { pcm.fill(0); reject(new SttError('STT_EMPTY_AUDIO', 400)); return; }
      if (pcm.length > MAX_AUDIO_SECONDS * PCM_BYTES_PER_SECOND) {
        pcm.fill(0); reject(new SttError('STT_AUDIO_TOO_LONG', 413)); return;
      }
      resolve({ audio: pcm, mimeType: 'audio/pcm', durationSeconds: pcm.length / PCM_BYTES_PER_SECOND });
    };
    const abort = () => { failure = new SttError('STT_ABORTED', 499); child?.kill('SIGKILL'); };
    const timer = setTimeout(() => { failure = new SttError('STT_TIMEOUT', 504); child?.kill('SIGKILL'); }, 12000);
    try {
      child = spawnImpl(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '33554432',
        '-protocol_whitelist', 'pipe', '-format_whitelist', 'matroska,webm,ogg,mov,wav',
        '-probesize', '1048576', '-analyzeduration', '2000000', '-threads', '1',
        '-f', format, '-i', 'pipe:0', '-map', '0:a:0', '-t', String(MAX_AUDIO_SECONDS + 1),
        '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-threads', '1',
        '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    } catch { finish(new SttError('STT_UNAVAILABLE', 503)); return; }
    child.once('error', () => finish(new SttError('STT_UNAVAILABLE', 503)));
    child.stdout.on('data', chunk => {
      if (settled || failure) { chunk.fill(0); return; }
      size += chunk.length;
      if (size > (MAX_AUDIO_SECONDS + 1) * PCM_BYTES_PER_SECOND) {
        chunk.fill(0); failure = new SttError('STT_AUDIO_TOO_LONG', 413); child.kill('SIGKILL'); return;
      }
      chunks.push(chunk);
    });
    child.stdin.on('error', () => { /* Decoder close is handled below; never print audio or stderr. */ });
    child.once('close', code => finish(failure || (code === 0 ? null : new SttError('STT_INVALID_AUDIO', 400))));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(audio);
  });
}
