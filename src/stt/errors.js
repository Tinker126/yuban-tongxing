const MESSAGES = {
  STT_UNAVAILABLE: '英语语音识别服务暂未就绪，请稍后重试。',
  STT_UNAUTHENTICATED: '请先登录学生账号。',
  STT_UNSUPPORTED_AUDIO: '当前录音格式不受支持，请使用最新版 Chrome 或 Edge。',
  STT_EMPTY_AUDIO: '没有收到录音，请再说一遍。',
  STT_INVALID_AUDIO: '录音无法读取，请重新录音。',
  STT_AUDIO_TOO_LARGE: '录音文件过大，请缩短后重试。',
  STT_AUDIO_TOO_LONG: '每次最多录音25秒，请缩短后重试。',
  STT_TIMEOUT: '语音识别超时，请稍后重试。',
  STT_ABORTED: '本次语音识别已取消，可以重新录音。',
  STT_BUSY: '语音识别较忙，请稍后再试。',
  STT_RATE_LIMITED: '语音识别请求太频繁，请稍后再试。',
  STT_DAILY_LIMIT: '今天的语音识别额度已用完，请联系老师。',
  STT_NO_SPEECH: '没有识别到英语，请靠近麦克风再说一遍。',
  STT_PROVIDER_AUTH: '语音服务授权配置有误，请联系老师检查服务权限。',
  STT_PROVIDER_NOT_ACTIVATED: '腾讯云语音识别服务尚未开通，请联系老师。',
  STT_PROVIDER_QUOTA: '腾讯云语音识别服务额度不足，请联系老师检查服务余额。',
  STT_PROVIDER_ERROR: '语音识别服务暂时无法完成请求，请稍后重试。'
};

export class SttError extends Error {
  constructor(code, status = 502) {
    super(MESSAGES[code] || MESSAGES.STT_PROVIDER_ERROR);
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'STT_PROVIDER_ERROR';
    this.status = status;
  }
}

export function publicSttError(error) {
  return error instanceof SttError ? error : new SttError('STT_PROVIDER_ERROR');
}
