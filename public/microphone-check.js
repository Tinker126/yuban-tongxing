// A short, device-only volume check. Never records, encodes, stores or uploads audio.
export async function checkMicrophone({ onLevel, signal }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前页面不能访问麦克风。请通过HTTPS或localhost打开。');
  let stream, context, timer, releaseAbort;
  const stopped = new Error('麦克风检测已停止。');
  stopped.name = 'AbortError';
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('浏览器无法检测音量，请检查系统麦克风设置。');
    context = new Audio();
    const resumed = context.resume();
    const aborted = new Promise((_, reject) => {
      const cancel = () => reject(stopped);
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once:true });
      releaseAbort = () => signal.removeEventListener('abort', cancel);
    });
    const pendingStream = navigator.mediaDevices.getUserMedia({ audio: true });
    // If the permission prompt outlives cancellation, release any stream granted later.
    pendingStream.then(s => { if (signal.aborted) s.getTracks().forEach(t => t.stop()); }, () => {});
    stream = await Promise.race([pendingStream, aborted]);
    if (signal.aborted) throw stopped;
    await Promise.race([resumed, aborted]);
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    await new Promise((resolve, reject) => {
      let frames = 0;
      const cancel = () => { clearInterval(timer); reject(stopped); };
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum+value*value, 0)/samples.length);
        peak = Math.max(peak, rms); onLevel(Math.min(100, Math.round(rms*650)));
        if (++frames >= 50) { clearInterval(timer); signal.removeEventListener('abort', cancel); resolve(); }
      }, 100);
    });
    return { soundDetected: peak >= 0.003, device: stream.getAudioTracks()[0]?.label || '默认麦克风' };
  } catch (e) {
    const messages = {
      NotAllowedError: '麦克风权限被拒绝。请检查浏览器的网站权限，以及手机系统或应用的麦克风权限。',
      NotFoundError: '没有找到麦克风。请连接麦克风并检查系统输入设备。',
      NotReadableError: '麦克风暂时无法使用。请检查设备是否被占用。'
    };
    if (messages[e.name]) throw Object.assign(new Error(messages[e.name], { cause: e }), { name: e.name, code: e.name, detail: e.message });
    throw e;
  } finally {
    clearInterval(timer);
    releaseAbort?.();
    stream?.getTracks().forEach(track => track.stop());
    await context?.close().catch(() => {});
    onLevel(0);
  }
}
