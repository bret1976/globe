import test from 'node:test';
import assert from 'node:assert/strict';
import { pickHumanSpeechVoice } from './speechVoices.js';

test('pickHumanSpeechVoice prefers a neural English voice over robot defaults', () => {
  const voices = [
    { name: 'Microsoft David', lang: 'en-US' },
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Microsoft Zira', lang: 'en-US' },
  ];
  assert.equal(pickHumanSpeechVoice(voices).name, 'Google US English');
});

test('pickHumanSpeechVoice skips compact and eSpeak voices', () => {
  const voices = [
    { name: 'eSpeak EN', lang: 'en-GB' },
    { name: 'Samantha', lang: 'en-US' },
  ];
  assert.equal(pickHumanSpeechVoice(voices).name, 'Samantha');
});

test('pickHumanSpeechVoice returns null when no voices exist', () => {
  assert.equal(pickHumanSpeechVoice([]), null);
});
