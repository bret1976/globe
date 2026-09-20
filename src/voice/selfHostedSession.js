import { createSelfHostedBackend } from './selfHostedBackend.js';
import {
  isEditingSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';

/**
 * Mic → browser speech or Qwen3-ASR → planner/Qwen3-8B → gevActions → speak.
 * Clicking the mic starts listening immediately (user-gesture). No OpenAI key.
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
  let live = false;
  let busy = false;
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

  function browserSpeechRecognition() {
    return (
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null
    );
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
    if (!spoken || busy) return;
    busy = true;
    stopBrowserRecognition();
    try {
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
      emit({
        type: 'transcript',
        role: 'assistant',
        text: speech,
        final: true,
      });
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
    } finally {
      busy = false;
      if (live) {
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Listening — speak now',
        });
        startBrowserRecognition();
      }
    }
  }

  function stopBrowserRecognition() {
    const current = recognition;
    recognition = null;
    try {
      current?.stop?.();
    } catch {
      /* already stopped */
    }
  }

  function startBrowserRecognition() {
    const Recognition = browserSpeechRecognition();
    if (!Recognition || !live || busy) return false;
    stopBrowserRecognition();
    const instance = new Recognition();
    recognition = instance;
    instance.lang = 'en-US';
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      const last = event.results?.[event.results.length - 1];
      const text = last?.[0]?.transcript;
      if (!text) return;
      if (!last.isFinal) {
        emit({ type: 'state', state: 'listening', detail: text });
        return;
      }
      void handleUtterance(text).catch((error) => {
        emit({
          type: 'state',
          state: 'error',
          detail: error?.message || 'Voice command failed',
        });
      });
    };
    instance.onerror = (event) => {
      if (
        event?.error === 'no-speech' ||
        event?.error === 'aborted' ||
        event?.error === 'not-allowed'
      ) {
        if (event?.error === 'not-allowed') {
          live = false;
          emit({
            type: 'state',
            state: 'error',
            detail: 'Microphone blocked — allow it, or type a command',
          });
        }
        return;
      }
      emit({
        type: 'state',
        state: 'error',
        detail: event?.error || 'Speech recognition failed',
      });
    };
    instance.onend = () => {
      if (recognition !== instance) return;
      recognition = null;
      if (live && !busy) {
        try {
          startBrowserRecognition();
        } catch {
          /* Chrome throws if a restart races */
        }
      }
    };
    instance.start();
    return true;
  }

  function onKeyDown(event) {
    if (!isPushToTalkKey(event) || event.repeat) return;
    if (isEditingSpaceTarget(event.target)) return;
    spaceHeld = true;
    event.preventDefault();
    if (!live) return;
    startBrowserRecognition();
  }

  function onKeyUp(event) {
    if (!isPushToTalkKey(event) || !spaceHeld) return;
    spaceHeld = false;
    event.preventDefault();
  }

  return {
    protocol: 'self-hosted-qwen',
    capabilities: { costControls: false, pushToTalk: true },
    ignoreButtonClick: () => spaceHeld,
    async start() {
      live = true;
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Starting voice',
      });
      // Must start recognition inside the click gesture, before any await.
      const listening = startBrowserRecognition();
      emit({
        type: 'state',
        state: 'listening',
        detail: listening
          ? 'Listening — speak now'
          : 'Type a command — this browser has no speech recognition',
      });
      if (!listening) ui?.commandInput?.focus?.();
      void backend
        .status({ signal })
        .then((next) => {
          status = next;
        })
        .catch(() => {
          status = {
            asr: false,
            llm: true,
            tts: false,
            protocol: 'self-hosted-qwen',
          };
        });
      if (globalThis.navigator?.mediaDevices?.getUserMedia) {
        void globalThis.navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            if (!live) {
              stream.getTracks?.().forEach((track) => track.stop());
              return;
            }
            mediaStream = stream;
          })
          .catch(() => {
            mediaStream = null;
          });
      }
    },
    stop() {
      live = false;
      busy = false;
      stopBrowserRecognition();
      recorder?.stop?.();
      recorder = null;
      mediaStream?.getTracks?.().forEach((track) => track.stop());
      mediaStream = null;
      globalThis.speechSynthesis?.cancel?.();
    },
    async sendText(text) {
      if (!live) {
        live = true;
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Working from typed command',
        });
      }
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
      if (!live) return false;
      return startBrowserRecognition();
    },
    async stopRecording() {
      stopBrowserRecognition();
      if (!recorder) return live;
      const finished = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.stop();
      await finished;
      recorder = null;
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
    },
  };
}
