import { createSelfHostedBackend } from './selfHostedBackend.js';
import {
  isEditingSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';

/**
 * Mic → Qwen3-ASR → Qwen3-8B/planner → gevActions → Kokoro.
 * Browser SpeechRecognition / speechSynthesis are last-resort fallbacks when
 * the GPU inference box is offline so the Pentagon flow still works.
 */
export function createSelfHostedSession({
  emit,
  runAction,
  backend = createSelfHostedBackend(),
  signal,
  ui = null,
} = {}) {
  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let lastLocationQuery = null;
  let lastPlace = null;
  let speaking = null;
  let recognition = null;
  let spaceHeld = false;
  let status = {
    asr: false,
    llm: true,
    tts: false,
    protocol: 'self-hosted-qwen',
  };

  function viewport() {
    const carto =
      globalThis.__godsEyeView?.viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: (carto.latitude * 180) / Math.PI,
      lon: (carto.longitude * 180) / Math.PI,
    };
  }

  async function playSpeech(text, audio) {
    if (audio && globalThis.AudioContext) {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(audio.slice(0));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      await new Promise((resolve) => {
        source.onended = resolve;
        source.start();
      });
      await context.close();
      return;
    }
    const synth = globalThis.speechSynthesis;
    if (!synth || !text) return;
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = resolve;
      utterance.onerror = resolve;
      synth.cancel();
      synth.speak(utterance);
    });
  }

  async function handleUtterance(text) {
    const spoken = String(text || '').trim();
    if (!spoken) return;
    emit({ type: 'transcript', role: 'user', text: spoken, final: true });
    emit({ type: 'state', state: 'executing', detail: spoken });
    const plan = await backend.act({
      text: spoken,
      viewport: viewport(),
      lastLocationQuery,
      lastPlace,
      signal,
    });
    if (plan.locationQuery) lastLocationQuery = plan.locationQuery;
    if (plan.place) lastPlace = plan.place;
    for (const call of plan.calls) {
      await runAction(call.name, call.arguments || {});
    }
    const speech =
      plan.speech ||
      (plan.calls.length ? 'Done.' : 'I could not act on that yet.');
    emit({ type: 'transcript', role: 'assistant', text: speech, final: true });
    emit({ type: 'state', state: 'speaking', detail: speech });
    try {
      const spokenAudio = await backend
        .speak({ text: speech, signal })
        .catch(() => ({ text: speech, audio: null }));
      speaking = playSpeech(spokenAudio.text || speech, spokenAudio.audio);
      await speaking;
    } finally {
      speaking = null;
    }
    emit({ type: 'completion', status: 'completed' });
    emit({ type: 'state', state: 'listening', detail: 'Listening' });
  }

  function browserSpeechRecognition() {
    return (
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null
    );
  }

  async function transcribeAudio(audio, mimeType) {
    if (typeof backend.transcribe === 'function' && status.asr) {
      const result = await backend.transcribe({ audio, mimeType, signal });
      return result.text;
    }
    throw new Error(
      'Qwen3-ASR is offline. Set VOICE_INFERENCE_URL on the GPU box, or type the command.',
    );
  }

  function startBrowserRecognition() {
    const Recognition = browserSpeechRecognition();
    if (!Recognition) return false;
    recognition?.stop?.();
    recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript;
      void handleUtterance(text).catch((error) => {
        emit({
          type: 'state',
          state: 'error',
          detail: error?.message || 'Voice command failed',
        });
      });
    };
    recognition.onerror = (event) => {
      if (event?.error === 'no-speech' || event?.error === 'aborted') return;
      emit({
        type: 'state',
        state: 'error',
        detail: event?.error || 'Speech recognition failed',
      });
    };
    recognition.start();
    emit({
      type: 'state',
      state: 'listening',
      detail: 'Browser speech listening',
    });
    return true;
  }

  function onKeyDown(event) {
    if (!isPushToTalkKey(event) || event.repeat) return;
    if (isEditingSpaceTarget(event.target)) return;
    spaceHeld = true;
    event.preventDefault();
    void startRecording();
  }

  function onKeyUp(event) {
    if (!isPushToTalkKey(event) || !spaceHeld) return;
    spaceHeld = false;
    event.preventDefault();
    void stopRecording();
  }

  return {
    protocol: 'self-hosted-qwen',
    capabilities: { costControls: false, pushToTalk: true },
    ignoreButtonClick: () => spaceHeld,
    async start() {
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Starting Qwen voice',
      });
      try {
        status = await backend.status({ signal });
      } catch {
        status = {
          asr: false,
          llm: true,
          tts: false,
          protocol: 'self-hosted-qwen',
        };
      }
      if (globalThis.navigator?.mediaDevices?.getUserMedia) {
        try {
          mediaStream = await globalThis.navigator.mediaDevices.getUserMedia({
            audio: true,
          });
        } catch {
          mediaStream = null;
        }
      }
      emit({
        type: 'state',
        state: 'listening',
        detail: status.asr
          ? 'Qwen3-ASR listening'
          : 'Voice on — hold Space or type a command',
      });
    },
    stop() {
      recorder?.stop?.();
      recorder = null;
      recognition?.stop?.();
      recognition = null;
      mediaStream?.getTracks?.().forEach((track) => track.stop());
      mediaStream = null;
      globalThis.speechSynthesis?.cancel?.();
    },
    async sendText(text) {
      try {
        await handleUtterance(text);
        return true;
      } catch (error) {
        emit({
          type: 'state',
          state: 'error',
          detail: error?.message || 'Voice command failed',
        });
        return false;
      }
    },
    sendMapEvent() {
      return true;
    },
    async startRecording() {
      if (status.asr && mediaStream && typeof MediaRecorder !== 'undefined') {
        chunks = [];
        recorder = new MediaRecorder(mediaStream);
        recorder.ondataavailable = (event) => {
          if (event.data?.size) chunks.push(event.data);
        };
        recorder.start();
        emit({ type: 'state', state: 'listening', detail: 'Recording' });
        return true;
      }
      return startBrowserRecognition();
    },
    async stopRecording() {
      if (recognition) {
        recognition.stop();
        recognition = null;
        return true;
      }
      if (!recorder) return false;
      const finished = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.stop();
      await finished;
      const blob = new Blob(chunks, {
        type: recorder.mimeType || 'audio/webm',
      });
      recorder = null;
      const audio = new Uint8Array(await blob.arrayBuffer());
      const text = await transcribeAudio(audio, blob.type);
      await handleUtterance(text);
      return true;
    },
    bindControls() {
      globalThis.addEventListener?.('keydown', onKeyDown, true);
      globalThis.addEventListener?.('keyup', onKeyUp, true);
      signal?.addEventListener?.(
        'abort',
        () => {
          globalThis.removeEventListener?.('keydown', onKeyDown, true);
          globalThis.removeEventListener?.('keyup', onKeyUp, true);
        },
        { once: true },
      );
      const form = ui?.commandForm;
      const input = ui?.commandInput;
      if (form && input) {
        const submit = (event) => {
          event.preventDefault();
          const text = input.value;
          input.value = '';
          if (text.trim()) void handleUtterance(text);
        };
        form.addEventListener('submit', submit);
        signal?.addEventListener?.(
          'abort',
          () => form.removeEventListener('submit', submit),
          { once: true },
        );
      }
    },
  };
}
