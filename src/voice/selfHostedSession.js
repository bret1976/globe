import { createSelfHostedBackend } from './selfHostedBackend.js';
import {
  isEditingSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';
import { pickHumanSpeechVoice } from './speechVoices.js';
import { OPEN_MIC_CONSTRAINTS, pickPreferredMicId } from './micDevices.js';

const MIC_SPEECH_THRESHOLD = 0.012;
const OPEN_MIC_MAX_MS = 4_000;
const MIN_RECORDING_BYTES = 250;

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
  let pendingStream = null;
  let micPromise = null;
  let recorder = null;
  let chunks = [];
  let lastLocationQuery = null;
  let lastPlace = null;
  let speaking = null;
  let recognition = null;
  let spaceHeld = false;
  let holding = false;
  let live = false;
  let busy = false;
  let pendingTranscript = '';
  let silenceTimer = null;
  let audioContext = null;
  let analyser = null;
  let visualizerFrame = null;
  let heardSpeech = false;
  let lastSpeechAt = 0;
  let preferRecorder = false;
  let recordWatchTimer = null;
  let recordStartedAt = 0;
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
      const voice = pickHumanSpeechVoice(synth.getVoices?.() || []);
      if (voice) utterance.voice = voice;
      utterance.rate = 0.96;
      utterance.pitch = 1.02;
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
          detail: holding
            ? 'Listening — speak now'
            : 'Listening — speak now, or hold the mic',
        });
        if (mediaStream || preferRecorder) startRecorder();
        else startBrowserRecognition();
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
      if (event?.error === 'no-speech' || event?.error === 'aborted') {
        return;
      }
      if (event?.error === 'audio-capture' || event?.error === 'network') {
        if (canUseRecorder()) {
          preferRecorder = true;
          if (mediaStream) attachMic(mediaStream, { record: true });
          else if (!micPromise) requestMic();
        }
        return;
      }
      if (event?.error === 'not-allowed') {
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Microphone blocked — type a command',
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
    try {
      instance.start();
      return true;
    } catch {
      recognition = null;
      return false;
    }
  }

  function recorderMime() {
    const Ctor = globalThis.MediaRecorder;
    if (!Ctor) return '';
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (Ctor.isTypeSupported?.(type)) return type;
    }
    return '';
  }

  function clearRecordWatch() {
    if (recordWatchTimer) {
      clearTimeout(recordWatchTimer);
      recordWatchTimer = null;
    }
    recordStartedAt = 0;
  }

  function armRecordWatch() {
    clearRecordWatch();
    recordStartedAt = Date.now();
    recordWatchTimer = setTimeout(() => {
      recordWatchTimer = null;
      if (!live || busy || holding || !recorder) return;
      if (chunks.length) void flushRecording();
    }, OPEN_MIC_MAX_MS);
  }

  function stopRecorder() {
    clearRecordWatch();
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
      instance.start(200);
      armRecordWatch();
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
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' });
    chunks = [];
    recorder = null;
    if (blob.size < MIN_RECORDING_BYTES) {
      emit({
        type: 'state',
        state: 'listening',
        detail: 'Listening — speak now',
      });
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
      const spoken = String(result?.text || '').trim();
      if (!spoken) {
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Still listening — say a command',
        });
        if (live && !busy) startRecorder();
        return;
      }
      await handleUtterance(spoken);
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
    void audioContext?.resume?.();
    if (!audioContext || !stream) return;
    try {
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
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
      if (peak > MIC_SPEECH_THRESHOLD) {
        const firstHear = !heardSpeech;
        heardSpeech = true;
        lastSpeechAt = Date.now();
        if (ui?.root) ui.root.dataset.speaker = 'user';
        if (firstHear && !busy && !holding) {
          emit({
            type: 'state',
            state: 'listening',
            detail: 'Hearing you — keep talking',
          });
        }
      } else if (
        heardSpeech &&
        !holding &&
        Date.now() - lastSpeechAt > silenceMs
      ) {
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

  function canUseRecorder() {
    return Boolean(
      globalThis.MediaRecorder &&
      globalThis.navigator?.mediaDevices?.getUserMedia,
    );
  }

  function attachMic(stream, { record = false } = {}) {
    pendingStream = null;
    mediaStream = stream;
    if (!live) return;
    startVisualizer(stream);
    if (record) {
      stopBrowserRecognition();
      startRecorder();
    }
  }

  function consumePendingStream({ record = false } = {}) {
    if (mediaStream) {
      startVisualizer(mediaStream);
      if (record) {
        stopBrowserRecognition();
        startRecorder();
      }
      return true;
    }
    if (pendingStream) {
      attachMic(pendingStream, { record });
      return true;
    }
    return false;
  }

  async function adoptPreferredMic(stream) {
    let devices = [];
    try {
      devices =
        (await globalThis.navigator?.mediaDevices?.enumerateDevices?.()) || [];
    } catch {
      devices = [];
    }
    const currentId = stream.getAudioTracks?.()[0]?.getSettings?.().deviceId || '';
    const preferredId = pickPreferredMicId(devices, currentId);
    if (!preferredId) return stream;
    try {
      const next = await globalThis.navigator.mediaDevices.getUserMedia({
        audio: { ...OPEN_MIC_CONSTRAINTS, deviceId: { exact: preferredId } },
      });
      stream.getTracks?.().forEach((track) => track.stop());
      return next;
    } catch {
      return stream;
    }
  }

  function requestMic() {
    if (mediaStream || pendingStream) {
      if (live) consumePendingStream({ record: holding || preferRecorder });
      return micPromise || Promise.resolve(mediaStream || pendingStream);
    }
    if (micPromise) return micPromise;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      emit({
        type: 'state',
        state: 'listening',
        detail: 'Type a command — this browser has no microphone access',
      });
      return Promise.resolve(null);
    }
    micPromise = globalThis.navigator.mediaDevices
      .getUserMedia({ audio: { ...OPEN_MIC_CONSTRAINTS } })
      .then((stream) => adoptPreferredMic(stream))
      .then((stream) => {
        if (live) attachMic(stream, { record: holding || preferRecorder });
        else pendingStream = stream;
        return stream;
      })
      .catch((error) => {
        micPromise = null;
        mediaStream = null;
        pendingStream = null;
        // Never emit `error` here: that cancels an in-flight fly_to_location,
        // including typed "Take me to the Pentagon".
        if (!recognition && !busy) {
          emit({
            type: 'state',
            state: 'listening',
            detail: 'Microphone blocked — type a command',
          });
        }
      });
    return micPromise;
  }

  function onKeyDown(event) {
    if (!isPushToTalkKey(event) || event.repeat) return;
    if (isEditingSpaceTarget(event.target)) return;
    spaceHeld = true;
    event.preventDefault();
    if (!live) return;
    if (mediaStream) startRecorder();
    else startBrowserRecognition();
  }

  function onKeyUp(event) {
    if (!isPushToTalkKey(event) || !spaceHeld) return;
    spaceHeld = false;
    event.preventDefault();
  }

  return {
    protocol: 'self-hosted-qwen',
    capabilities: { costControls: false, pushToTalk: true },
    ignoreButtonClick: () => spaceHeld || holding,
    primeMic() {
      unlockPlayback();
      preferRecorder = canUseRecorder();
      if (preferRecorder) requestMic();
      return true;
    },
    holdTalk() {
      holding = true;
      live = true;
      preferRecorder = canUseRecorder() || preferRecorder;
      unlockPlayback();
      if (!consumePendingStream({ record: true })) requestMic();
      emit({
        type: 'state',
        state: 'listening',
        detail: 'Listening — speak now',
      });
      return true;
    },
    cancelHold() {
      holding = false;
      // A short click is open-mic. Keep the real recorder; do not fall
      // back to Chrome speech recognition, which misses desk mics.
      if (preferRecorder || mediaStream) {
        if (live && !busy && !recorder) startRecorder();
        return true;
      }
      stopRecorder();
      chunks = [];
      if (live && !busy) startBrowserRecognition();
      return true;
    },
    async releaseTalk() {
      if (!holding && !recorder) return false;
      holding = false;
      if (!mediaStream && micPromise) {
        await Promise.race([
          micPromise.catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);
      }
      await flushRecording();
      return true;
    },
    async start(options = {}) {
      live = true;
      unlockPlayback();
      preferRecorder = canUseRecorder() || Boolean(options.pushToTalk);
      emit({
        type: 'state',
        state: 'connecting',
        detail: 'Starting voice',
      });
      // Hosted Gemini ASR on the real getUserMedia stream is the open-mic
      // path. Chrome SpeechRecognition is a fallback when the browser
      // cannot record, because it often never sees a connected desk mic.
      let listening = false;
      if (preferRecorder) {
        listening = consumePendingStream({ record: true });
        if (!listening) requestMic();
        listening = true;
      } else {
        listening = startBrowserRecognition();
      }
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
      holding = false;
      preferRecorder = false;
      heardSpeech = false;
      pendingTranscript = '';
      clearSilenceTimer();
      clearRecordWatch();
      stopBrowserRecognition();
      stopRecorder();
      stopVisualizer();
      mediaStream?.getTracks?.().forEach((track) => track.stop());
      pendingStream?.getTracks?.().forEach((track) => track.stop());
      mediaStream = null;
      pendingStream = null;
      micPromise = null;
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
