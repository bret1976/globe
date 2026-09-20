import { createSelfHostedBackend } from './selfHostedBackend.js';
import {
  isEditingSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';

const RECOVERABLE_RECOGNITION_ERRORS = new Set([
  'no-speech',
  'aborted',
  'network',
  'audio-capture',
]);

/**
 * Mic → browser speech or hosted ASR → planner → gevActions → speak.
 * Clicking the mic starts listening in the same user gesture. No OpenAI key.
 */
export function createSelfHostedSession({
  emit,
  runAction,
  backend = createSelfHostedBackend(),
  signal,
  ui = null,
  silenceMs = 900,
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
  let pendingTranscript = '';
  let silenceTimer = null;
  let audioContext = null;
  let analyser = null;
  let visualizerFrame = null;
  let heardSpeech = false;
  let lastSpeechAt = 0;
  let status = {
    asr: false,
    llm: true,
    tts: true,
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

  function unlockPlayback() {
    const synth = globalThis.speechSynthesis;
    if (synth) {
      try {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        synth.speak(warm);
        synth.cancel();
      } catch {
        /* Chrome unlocks after the first speak() in a click */
      }
    }
    if (!audioContext && globalThis.AudioContext) {
      try {
        audioContext = new AudioContext();
        void audioContext.resume?.();
      } catch {
        audioContext = null;
      }
    } else {
      void audioContext?.resume?.();
    }
  }

  async function playSpeech(text, audio) {
    if (audio && globalThis.AudioContext) {
      const context = audioContext || new AudioContext();
      await context.resume?.();
      const buffer = await context.decodeAudioData(audio.slice(0));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      await new Promise((resolve) => {
        source.onended = resolve;
        source.start();
      });
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

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function queueTranscript(text, isFinal) {
    const spoken = String(text || '').trim();
    if (!spoken || busy) return;
    pendingTranscript = spoken;
    emit({ type: 'state', state: 'listening', detail: spoken });
    clearSilenceTimer();
    if (isFinal) {
      void flushPendingTranscript();
      return;
    }
    silenceTimer = setTimeout(() => {
      void flushPendingTranscript();
    }, silenceMs);
  }

  async function flushPendingTranscript() {
    clearSilenceTimer();
    const spoken = pendingTranscript;
    pendingTranscript = '';
    if (!spoken || busy) return;
    await handleUtterance(spoken);
  }

  async function handleUtterance(text) {
    const spoken = String(text || '').trim();
    if (!spoken || busy) return;
    busy = true;
    clearSilenceTimer();
    pendingTranscript = '';
    stopBrowserRecognition();
    stopRecorder();
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
        startRecorder();
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
      queueTranscript(text, Boolean(last.isFinal));
    };
    instance.onerror = (event) => {
      if (RECOVERABLE_RECOGNITION_ERRORS.has(event?.error)) return;
      if (event?.error === 'not-allowed') {
        live = false;
        emit({
          type: 'state',
          state: 'error',
          detail: 'Microphone blocked — allow it, or type a command',
        });
        return;
      }
      emit({
        type: 'state',
        state: 'listening',
        detail: event?.error
          ? `${event.error} — keep speaking or type a command`
          : 'Keep speaking or type a command',
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

  function recorderMime() {
    const Ctor = globalThis.MediaRecorder;
    if (!Ctor) return '';
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (Ctor.isTypeSupported?.(type)) return type;
    }
    return '';
  }

  function stopRecorder() {
    const current = recorder;
    recorder = null;
    try {
      if (current && current.state !== 'inactive') current.stop();
    } catch {
      /* already stopped */
    }
  }

  function startRecorder() {
    const Ctor = globalThis.MediaRecorder;
    if (!Ctor || !mediaStream || !live || busy) return false;
    stopRecorder();
    chunks = [];
    try {
      const mimeType = recorderMime();
      const instance = mimeType
        ? new Ctor(mediaStream, { mimeType })
        : new Ctor(mediaStream);
      recorder = instance;
      instance.ondataavailable = (event) => {
        if (event?.data?.size) chunks.push(event.data);
      };
      instance.start(250);
      return true;
    } catch {
      recorder = null;
      return false;
    }
  }

  async function flushRecording() {
    if (busy || pendingTranscript) return;
    const current = recorder;
    if (!current || !chunks.length) return;
    const finished = new Promise((resolve) => {
      current.onstop = resolve;
    });
    try {
      if (current.state !== 'inactive') current.stop();
    } catch {
      /* already stopped */
    }
    await Promise.race([
      finished,
      new Promise((resolve) => setTimeout(resolve, 80)),
    ]);
    const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' });
    chunks = [];
    recorder = null;
    if (blob.size < 2000) {
      if (live && !busy) startRecorder();
      return;
    }
    try {
      emit({
        type: 'state',
        state: 'executing',
        detail: 'Hearing you…',
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await backend.transcribe({
        audio: bytes,
        mimeType: blob.type || 'audio/webm',
        signal,
      });
      await handleUtterance(result.text);
    } catch (error) {
      emit({
        type: 'state',
        state: 'listening',
        detail:
          error?.message || 'Could not hear that — speak again or type it',
      });
      if (live && !busy) startRecorder();
    }
  }

  function stopVisualizer() {
    if (visualizerFrame) cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
    analyser = null;
    if (ui?.root) ui.root.dataset.speaker = 'idle';
  }

  function startVisualizer(stream) {
    if (!audioContext || !stream) return;
    try {
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    } catch {
      analyser = null;
      return;
    }
    const wave = new Uint8Array(analyser.fftSize);
    const bars = ui?.root?.querySelectorAll?.('.gev-voice-visualizer span');
    const render = () => {
      if (!live || !analyser) return;
      analyser.getByteTimeDomainData(wave);
      let peak = 0;
      for (const sample of wave) {
        peak = Math.max(peak, Math.abs(sample - 128) / 128);
      }
      if (peak > 0.06) {
        heardSpeech = true;
        lastSpeechAt = Date.now();
        if (ui?.root) ui.root.dataset.speaker = 'user';
      } else if (heardSpeech && Date.now() - lastSpeechAt > silenceMs) {
        heardSpeech = false;
        if (ui?.root) ui.root.dataset.speaker = 'idle';
        if (!pendingTranscript && !busy) void flushRecording();
      }
      if (bars?.length) {
        bars.forEach((bar, index) => {
          const level = Math.min(1, peak * (1.2 + (index % 5) * 0.15));
          bar.style.setProperty('--audio-level', String(level));
          bar.style.setProperty('--audio-opacity', String(0.35 + level * 0.65));
        });
      }
      visualizerFrame = requestAnimationFrame(render);
    };
    visualizerFrame = requestAnimationFrame(render);
  }

  function attachMic(stream) {
    if (!live) {
      stream.getTracks?.().forEach((track) => track.stop());
      return;
    }
    mediaStream = stream;
    startVisualizer(stream);
    startRecorder();
  }

  function requestMic() {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) return;
    void globalThis.navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(attachMic)
      .catch(() => {
        mediaStream = null;
        if (!browserSpeechRecognition()) {
          emit({
            type: 'state',
            state: 'error',
            detail: 'Microphone blocked — allow it, or type a command',
          });
        }
      });
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
      unlockPlayback();
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Starting voice',
      });
      // Must start recognition inside the click gesture, before any await.
      const listening = startBrowserRecognition();
      requestMic();
      emit({
        type: 'state',
        state: 'listening',
        detail: listening
          ? 'Listening — speak now'
          : 'Listening — speak, or type a command',
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
            tts: true,
            protocol: 'self-hosted-qwen',
          };
        });
    },
    stop() {
      live = false;
      busy = false;
      heardSpeech = false;
      pendingTranscript = '';
      clearSilenceTimer();
      stopBrowserRecognition();
      stopRecorder();
      stopVisualizer();
      mediaStream?.getTracks?.().forEach((track) => track.stop());
      mediaStream = null;
      chunks = [];
      void audioContext?.close?.();
      audioContext = null;
      globalThis.speechSynthesis?.cancel?.();
    },
    async sendText(text) {
      if (!live) {
        live = true;
        unlockPlayback();
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
      return startBrowserRecognition() || startRecorder();
    },
    async stopRecording() {
      await flushPendingTranscript();
      stopBrowserRecognition();
      if (recorder && chunks.length) await flushRecording();
      else stopRecorder();
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
