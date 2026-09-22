import { createSelfHostedBackend } from './selfHostedBackend.js';
import {
  isEditingSpaceTarget,
  isPushToTalkKey,
} from './realtimeInputPolicy.js';
import { pickHumanSpeechVoice } from './speechVoices.js';
import { OPEN_MIC_CONSTRAINTS, pickPreferredMicId } from './micDevices.js';
import {
  OPEN_MIC_MAX_MS,
  nextListenArmTime,
  shouldCommitOpenMic,
  shouldHearOpenMic,
  shouldRearmAfterReply,
  shouldWatchdogFlush,
} from './openMicPolicy.js';

const MIC_SPEECH_THRESHOLD = 0.012;
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
  let visualizerSource = null;
  let visualizerFrame = null;
  let heardSpeech = false;
  let lastSpeechAt = 0;
  let listenArmedAt = 0;
  let preferRecorder = false;
  let recordWatchTimer = null;
  let recordStartedAt = 0;
  let flushing = false;
  let queuedUtterance = '';
  let speakEpoch = 0;
  let sessionEpoch = 0;
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

  function interruptSpeech() {
    speakEpoch += 1;
    speaking = null;
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch {
      /* Chrome cancel is best-effort */
    }
  }

  function withDeadline(promise, ms) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  }

  async function playSpeech(text, audio) {
    if (audio && globalThis.AudioContext) {
      // Keep TTS off the mic analyser context. Sharing that context after
      // the first reply left the open-mic meter dead.
      const playback = new AudioContext();
      try {
        await playback.resume?.();
        const buffer = await playback.decodeAudioData(audio.slice(0));
        const source = playback.createBufferSource();
        source.buffer = buffer;
        source.connect(playback.destination);
        await withDeadline(
          new Promise((resolve) => {
            source.onended = resolve;
            source.start();
          }),
          8_000,
        );
      } finally {
        void playback.close?.();
      }
      return;
    }
    const synth = globalThis.speechSynthesis;
    if (!synth || !text) return;
    await withDeadline(
      new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickHumanSpeechVoice(synth.getVoices?.() || []);
        if (voice) utterance.voice = voice;
        utterance.rate = 0.96;
        utterance.pitch = 1.02;
        utterance.onend = resolve;
        utterance.onerror = resolve;
        synth.cancel();
        synth.speak(utterance);
      }),
      8_000,
    );
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function queueTranscript(text, isFinal) {
    const spoken = String(text || '').trim();
    if (!spoken) return;
    if (busy) {
      if (isFinal) queuedUtterance = spoken;
      return;
    }
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
    if (!spoken) return;
    if (busy) {
      queuedUtterance = spoken;
      return;
    }
    const turnEpoch = sessionEpoch;
    const isCurrent = () =>
      live && !signal?.aborted && turnEpoch === sessionEpoch;
    busy = true;
    queuedUtterance = '';
    clearSilenceTimer();
    pendingTranscript = '';
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch {
      /* Chrome cancel is best-effort */
    }
    interruptSpeech();
    stopBrowserRecognition();
    stopRecorder();
    stopVisualizer();
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
      if (!isCurrent()) return;
      if (plan.locationQuery) lastLocationQuery = plan.locationQuery;
      if (plan.place) lastPlace = plan.place;
      for (const call of plan.calls) {
        if (!isCurrent()) return;
        const result = await runAction(call.name, call.arguments || {});
        if (!isCurrent()) return;
        if (result?.ok === false)
          throw new Error(result.error || `Could not complete ${call.name}`);
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
      const epoch = ++speakEpoch;
      speaking = (async () => {
        if (epoch !== speakEpoch) return;
        const spokenAudio = await withDeadline(
          Promise.resolve(backend.speak({ text: speech, signal })).catch(
            () => ({
              text: speech,
              audio: null,
            }),
          ),
          5_000,
        );
        if (epoch !== speakEpoch) return;
        await playSpeech(spokenAudio?.text || speech, spokenAudio?.audio);
      })().catch(() => {});
      emit({ type: 'completion', status: 'completed' });
    } catch (error) {
      if (isCurrent()) {
        emit({
          type: 'transcript',
          role: 'assistant',
          text: error?.message || 'Command failed. Please try again.',
          final: true,
        });
        emit({ type: 'completion', status: 'failed' });
      }
    } finally {
      if (turnEpoch !== sessionEpoch) return;
      busy = false;
      const next = queuedUtterance;
      queuedUtterance = '';
      if (next) {
        interruptSpeech();
        void handleUtterance(next);
      } else if (live) {
        // Open the mic now. Waiting for TTS left LISTENING on a dead
        // capture, so the second spoken command never reached ASR.
        resumeListening();
        const reply = speaking;
        void Promise.resolve(reply)
          .catch(() => {})
          .finally(() => {
            if (speaking === reply) speaking = null;
            // Do not wipe heardSpeech — the user may already be giving
            // the next direction while the first reply is still talking.
            if (shouldRearmAfterReply({ busy, flushing, heardSpeech })) {
              listenArmedAt = nextListenArmTime(Date.now());
            }
          });
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
      if (!live || !recorder) return;
      if (
        shouldWatchdogFlush({
          heardSpeech,
          holding,
          busy,
          flushing,
          chunkCount: chunks.length,
        })
      ) {
        void flushRecording();
        return;
      }
      // Restart a fresh clip so a silent listen cannot grow forever,
      // but never send that silence to ASR.
      if (live && !busy && !holding && !flushing) startRecorder();
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

  function bindRecorder(instance) {
    // Capture each clip's buffer: late stop events must not corrupt the next clip.
    const clipChunks = chunks;
    instance.ondataavailable = (event) => {
      if (event?.data?.size) clipChunks.push(event.data);
    };
    instance.start(200);
    if (instance.state === 'inactive') {
      throw new Error('MediaRecorder stayed inactive');
    }
    recorder = instance;
    armRecordWatch();
  }

  function startRecorder() {
    const Ctor = globalThis.MediaRecorder;
    if (!Ctor || !mediaStream || !live || busy) return false;
    stopRecorder();
    chunks = [];
    try {
      const mimeType = recorderMime();
      bindRecorder(
        mimeType ? new Ctor(mediaStream, { mimeType }) : new Ctor(mediaStream),
      );
      return true;
    } catch {
      recorder = null;
      // Chrome can reject an immediate restart on the same stream.
      setTimeout(() => {
        if (!live || busy || recorder || !mediaStream) return;
        chunks = [];
        try {
          const mimeType = recorderMime();
          bindRecorder(
            mimeType
              ? new Ctor(mediaStream, { mimeType })
              : new Ctor(mediaStream),
          );
        } catch {
          recorder = null;
        }
      }, 120);
      return false;
    }
  }

  async function flushRecording() {
    if (busy || flushing || pendingTranscript) return;
    const current = recorder;
    if (!current || !chunks.length) return;
    const clipEpoch = sessionEpoch;
    const clipChunks = chunks;
    flushing = true;
    clearRecordWatch();
    let resumeAfter = false;
    const finished = new Promise((resolve) => {
      current.onstop = resolve;
    });
    try {
      if (current.state !== 'inactive') current.stop();
    } catch {
      /* already stopped */
    }
    try {
      await Promise.race([
        finished,
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (!live || clipEpoch !== sessionEpoch) return;
      const blob = new Blob(clipChunks, {
        type: current.mimeType || 'audio/webm',
      });
      chunks = [];
      recorder = null;
      if (blob.size < MIN_RECORDING_BYTES) {
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Listening — speak now',
        });
        resumeAfter = live && !busy;
        return;
      }
      emit({
        type: 'state',
        state: 'executing',
        detail: 'Hearing you…',
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await backend.transcribe({
        audio: bytes,
        mimeType: blob.type || 'audio/webm',
        signal: AbortSignal.any(
          [signal, AbortSignal.timeout(30_000)].filter(Boolean),
        ),
      });
      if (!live || clipEpoch !== sessionEpoch) return;
      const spoken = String(result?.text || '').trim();
      if (!spoken) {
        emit({
          type: 'state',
          state: 'listening',
          detail: 'Still listening — say a command',
        });
        resumeAfter = live && !busy;
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
      resumeAfter = live && !busy;
    } finally {
      if (clipEpoch !== sessionEpoch) return;
      flushing = false;
      if (resumeAfter) resumeListening();
    }
  }

  function micTracksLive() {
    if (!mediaStream) return false;
    const tracks =
      mediaStream.getAudioTracks?.() || mediaStream.getTracks?.() || [];
    if (!tracks.length) return true;
    return tracks.some((track) => track.readyState !== 'ended');
  }

  function enableMicTracks() {
    const tracks =
      mediaStream?.getAudioTracks?.() || mediaStream?.getTracks?.() || [];
    for (const track of tracks) {
      try {
        track.enabled = true;
      } catch {
        /* ignore */
      }
    }
  }

  function resumeListening() {
    if (!live || busy) return;
    heardSpeech = false;
    lastSpeechAt = 0;
    flushing = false;
    listenArmedAt = nextListenArmTime(Date.now());
    enableMicTracks();
    void audioContext?.resume?.();
    emit({
      type: 'state',
      state: 'listening',
      detail: 'Listening — speak now',
    });
    if (preferRecorder || mediaStream) {
      if (mediaStream && micTracksLive()) {
        startVisualizer(mediaStream);
        if (startRecorder()) return;
        // A live desk-mic stream must stay on MediaRecorder. Chrome
        // speech recognition often never hears that device, and starting
        // it here stole the second command after the first fly-to.
        return;
      }
      mediaStream = null;
      if (pendingStream) attachMic(pendingStream, { record: true });
      else {
        micPromise = null;
        requestMic();
      }
      return;
    }
    startBrowserRecognition();
  }

  function stopVisualizer({ teardown = false } = {}) {
    if (visualizerFrame) cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
    if (ui?.root) ui.root.dataset.speaker = 'idle';
    if (!teardown) return;
    analyser = null;
    try {
      visualizerSource?.disconnect?.();
    } catch {
      /* already disconnected */
    }
    visualizerSource = null;
  }

  function startVisualizer(stream) {
    void audioContext?.resume?.();
    if (!audioContext || !stream) return;
    // Reuse the MediaStreamSource. Chrome goes silent if we disconnect
    // and recreate it on the same stream after the first reply.
    if (!visualizerSource || !analyser) {
      try {
        visualizerSource = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.35;
        visualizerSource.connect(analyser);
      } catch {
        visualizerSource = null;
        analyser = null;
        return;
      }
    }
    if (visualizerFrame) cancelAnimationFrame(visualizerFrame);
    const wave = new Uint8Array(analyser.fftSize);
    const bars = ui?.root?.querySelectorAll?.('.gev-voice-visualizer span');
    const render = () => {
      if (!live || !analyser) return;
      analyser.getByteTimeDomainData(wave);
      let peak = 0;
      for (const sample of wave) {
        peak = Math.max(peak, Math.abs(sample - 128) / 128);
      }
      const now = Date.now();
      const canHear = shouldHearOpenMic({
        busy,
        flushing,
        holding,
        now,
        listenArmedAt,
      });
      if (canHear && peak > MIC_SPEECH_THRESHOLD) {
        const firstHear = !heardSpeech;
        heardSpeech = true;
        lastSpeechAt = now;
        if (ui?.root) ui.root.dataset.speaker = 'user';
        if (firstHear) {
          interruptSpeech();
          emit({
            type: 'state',
            state: 'listening',
            detail: 'Hearing you — keep talking',
          });
        }
      } else if (
        shouldCommitOpenMic({
          heardSpeech,
          holding,
          busy,
          flushing,
          lastSpeechAt,
          now,
          silenceMs,
          recordStartedAt,
          listenArmedAt,
        })
      ) {
        heardSpeech = false;
        if (ui?.root) ui.root.dataset.speaker = 'idle';
        if (!pendingTranscript) void flushRecording();
      }
      if (bars?.length && canHear) {
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
    const currentId =
      stream.getAudioTracks?.()[0]?.getSettings?.().deviceId || '';
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
      heardSpeech = false;
      lastSpeechAt = 0;
      listenArmedAt = 0;
      flushing = false;
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
      sessionEpoch += 1;
      interruptSpeech();
      live = false;
      busy = false;
      holding = false;
      preferRecorder = false;
      heardSpeech = false;
      lastSpeechAt = 0;
      listenArmedAt = 0;
      flushing = false;
      queuedUtterance = '';
      pendingTranscript = '';
      clearSilenceTimer();
      clearRecordWatch();
      stopBrowserRecognition();
      stopRecorder();
      stopVisualizer({ teardown: true });
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
