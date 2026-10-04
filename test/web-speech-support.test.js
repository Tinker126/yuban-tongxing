import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWebSpeechSupport } from '../public/web-speech-support.js';

class StandardRecognition {}
class PrefixedRecognition {}
class Utterance {}

function speechScope(overrides = {}) {
  return {
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    speechSynthesis: undefined,
    SpeechSynthesisUtterance: undefined,
    navigator: { mediaDevices: { getUserMedia() {} } },
    isSecureContext: true,
    ...overrides
  };
}

test('recognition detection accepts the standard and WebKit-prefixed constructors', () => {
  const standard = detectWebSpeechSupport(speechScope({ SpeechRecognition: StandardRecognition }));
  assert.equal(standard.Recognition, StandardRecognition);
  assert.equal(standard.speechRecognition, true);
  assert.equal(standard.standardRecognition, true);
  assert.equal(standard.prefixedRecognition, false);

  const prefixed = detectWebSpeechSupport(speechScope({ webkitSpeechRecognition: PrefixedRecognition }));
  assert.equal(prefixed.Recognition, PrefixedRecognition);
  assert.equal(prefixed.speechRecognition, true);
  assert.equal(prefixed.standardRecognition, false);
  assert.equal(prefixed.prefixedRecognition, true);
});

test('recognition reports unsupported when neither constructor exists', () => {
  const support = detectWebSpeechSupport(speechScope());
  assert.equal(support.Recognition, null);
  assert.equal(support.speechRecognition, false);
});

test('TTS requires both a usable synthesis object and SpeechSynthesisUtterance', () => {
  const synthesis = { speak() {}, cancel() {}, getVoices() { return []; } };
  assert.equal(detectWebSpeechSupport(speechScope({ speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance })).speechSynthesis, true);
  assert.equal(detectWebSpeechSupport(speechScope({ speechSynthesis: synthesis })).speechSynthesis, false);
  assert.equal(detectWebSpeechSupport(speechScope({ speechSynthesis: {}, SpeechSynthesisUtterance: Utterance })).speechSynthesis, false);
  assert.equal(detectWebSpeechSupport(speechScope({ speechSynthesis: { getVoices() {} }, SpeechSynthesisUtterance: Utterance })).speechSynthesis, false);
});

test('microphone and secure-context capability detection is safe when APIs are missing', () => {
  const available = detectWebSpeechSupport(speechScope());
  assert.equal(available.getUserMedia, true);
  assert.equal(available.secureContext, true);
  const unavailable = detectWebSpeechSupport(speechScope({ navigator: {}, isSecureContext: false }));
  assert.equal(unavailable.getUserMedia, false);
  assert.equal(unavailable.secureContext, false);
});
