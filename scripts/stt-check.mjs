import 'dotenv/config';
import { ffmpegAvailable } from '../src/stt/audio.js';

const provider = process.env.STT_PROVIDER || 'disabled';
const credentialsConfigured = Boolean(process.env.TENCENT_ASR_SECRET_ID && process.env.TENCENT_ASR_SECRET_KEY);
const ffmpeg = await ffmpegAvailable(process.env.STT_FFMPEG_PATH || 'ffmpeg');
const ready = provider === 'tencent' && credentialsConfigured && ffmpeg;
console.log(JSON.stringify({ provider, credentialsConfigured, ffmpegAvailable: ffmpeg, ready, liveProviderVerified: false }));
if (!ready) process.exitCode = 1;
