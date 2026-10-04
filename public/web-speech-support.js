/** Feature detection kept separate so mobile browser variants can be tested. */
export function detectWebSpeechSupport(scope = globalThis) {
  const standardRecognition = typeof scope.SpeechRecognition === 'function' ? scope.SpeechRecognition : null;
  const prefixedRecognition = typeof scope.webkitSpeechRecognition === 'function' ? scope.webkitSpeechRecognition : null;
  const Recognition = standardRecognition || prefixedRecognition;
  const synthesis = scope.speechSynthesis;
  const Utterance = typeof scope.SpeechSynthesisUtterance === 'function' ? scope.SpeechSynthesisUtterance : null;
  const speechSynthesis = !!(synthesis && typeof synthesis.speak === 'function' && Utterance);

  return {
    Recognition,
    standardRecognition: !!standardRecognition,
    prefixedRecognition: !!prefixedRecognition,
    speechRecognition: !!Recognition,
    speechSynthesis,
    synthesis: speechSynthesis ? synthesis : null,
    Utterance: speechSynthesis ? Utterance : null,
    getUserMedia: typeof scope.navigator?.mediaDevices?.getUserMedia === 'function',
    secureContext: scope.isSecureContext === true
  };
}
