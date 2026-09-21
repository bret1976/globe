import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfHostedSession } from './selfHostedSession.js';
import { createVoiceSession } from './session.js';

function backendFixture(plan) {
  const calls = [];
  return {
    protocol: 'self-hosted-qwen',
    async status() {
      return {
        asr: false,
        llm: true,
        tts: false,
        protocol: 'self-hosted-qwen',
      };
    },
    async act(payload) {
      calls.push(['act', payload.text]);
      return plan;
    },
    async speak({ text }) {
      calls.push(['speak', text]);
      return { text, audio: null };
    },
    calls,
  };
}

test('self-hosted session runs planner actions then speaks', async () => {
  const actions = [];
  const events = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
      { name: 'select_nearest_aircraft', arguments: { layerId: 'flights' } },
      { name: 'control_cockpit', arguments: { action: 'enter' } },
    ],
    speech:
      'Flying to Pentagon. Finding the nearest airborne flight. Entering the cockpit.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  const session = createVoiceSession({
    runner: async (name, args) => {
      actions.push([name, args]);
      return { ok: true, name };
    },
    createAdapter: (hooks) =>
      createSelfHostedSession({
        ...hooks,
        backend,
      }),
  });
  session.subscribe((event) => events.push(event.type));
  await session.start();
  assert.equal(session.isActive(), true);
  assert.equal(await session.sendText('Take me to the Pentagon'), true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['fly_to_location', 'select_nearest_aircraft', 'control_cockpit'],
  );
  assert.ok(backend.calls.some(([kind]) => kind === 'speak'));
  assert.ok(events.includes('action-call'));
  assert.ok(events.includes('completion'));
  session.stop();
});

test('start() begins SpeechRecognition before awaiting backend status', async () => {
  const order = [];
  let recognition;
  const previousRecognition = globalThis.SpeechRecognition;
  const previousWebkit = globalThis.webkitSpeechRecognition;
  class FakeRecognition {
    constructor() {
      recognition = this;
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
    }
    start() {
      order.push('recognition-start');
    }
    stop() {
      order.push('recognition-stop');
    }
  }
  globalThis.SpeechRecognition = FakeRecognition;
  globalThis.webkitSpeechRecognition = undefined;
  let resolveStatus;
  const statusGate = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  const actions = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'Flying to Pentagon.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  const originalStatus = backend.status;
  backend.status = async () => {
    order.push('status');
    await statusGate;
    return originalStatus();
  };
  try {
    const session = createVoiceSession({
      runner: async (name, args) => {
        actions.push([name, args]);
        return { ok: true, name };
      },
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    const started = session.start();
    assert.equal(order[0], 'recognition-start');
    assert.ok(recognition.continuous);
    assert.ok(recognition.interimResults);
    assert.equal(session.isActive(), true);
    resolveStatus();
    await started;
    recognition.onresult({
      results: [
        {
          0: { transcript: 'Take me to the Pentagon' },
          isFinal: true,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      actions.map(([name]) => name),
      ['fly_to_location'],
    );
    session.stop();
  } finally {
    globalThis.SpeechRecognition = previousRecognition;
    globalThis.webkitSpeechRecognition = previousWebkit;
  }
});

test('typed sendText activates an idle session and runs the planner', async () => {
  const actions = [];
  const backend = backendFixture({
    calls: [
      { name: 'select_nearest_aircraft', arguments: { layerId: 'flights' } },
    ],
    speech: 'Finding the nearest airborne flight.',
    source: 'planner',
  });
  const session = createVoiceSession({
    runner: async (name, args) => {
      actions.push([name, args]);
      return { ok: true, name };
    },
    createAdapter: (hooks) =>
      createSelfHostedSession({
        ...hooks,
        backend,
      }),
  });
  assert.equal(session.isActive(), false);
  assert.equal(await session.sendText('Find the nearest flight'), true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['select_nearest_aircraft'],
  );
  session.stop();
});

test('interim speech is finalized after a short silence', async () => {
  let recognition;
  const previousRecognition = globalThis.SpeechRecognition;
  class FakeRecognition {
    constructor() {
      recognition = this;
    }
    start() {}
    stop() {}
  }
  globalThis.SpeechRecognition = FakeRecognition;
  const actions = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'Flying to Pentagon.',
    source: 'planner',
  });
  try {
    const session = createVoiceSession({
      runner: async (name, args) => {
        actions.push([name, args]);
        return { ok: true, name };
      },
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
          silenceMs: 20,
        }),
    });
    await session.start();
    recognition.onresult({
      results: [
        {
          0: { transcript: 'Take me to the Pentagon' },
          isFinal: false,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(
      actions.map(([name]) => name),
      ['fly_to_location'],
    );
    session.stop();
  } finally {
    globalThis.SpeechRecognition = previousRecognition;
  }
});

test('network speech errors keep the session listening', async () => {
  let recognition;
  const previousRecognition = globalThis.SpeechRecognition;
  class FakeRecognition {
    constructor() {
      recognition = this;
    }
    start() {}
    stop() {}
  }
  globalThis.SpeechRecognition = FakeRecognition;
  try {
    const events = [];
    const session = createVoiceSession({
      runner: async () => ({ ok: true }),
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend: backendFixture({
            calls: [],
            speech: 'Done.',
            source: 'planner',
          }),
        }),
    });
    session.subscribe((event) => events.push(event));
    await session.start();
    recognition.onerror({ error: 'network' });
    assert.equal(session.isActive(), true);
    assert.equal(session.state, 'listening');
    assert.ok(!events.some((event) => event.state === 'error'));
    session.stop();
  } finally {
    globalThis.SpeechRecognition = previousRecognition;
  }
});

function installMicRecorder({ chunkSize = 800 } = {}) {
  const previous = {
    MediaRecorder: globalThis.MediaRecorder,
    SpeechRecognition: globalThis.SpeechRecognition,
    webkitSpeechRecognition: globalThis.webkitSpeechRecognition,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const recorders = [];
  class FakeRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options?.mimeType || 'audio/webm';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
      this.ondataavailable?.({
        data: new Blob([new Uint8Array(chunkSize)], { type: this.mimeType }),
      });
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  FakeRecorder.isTypeSupported = () => true;
  globalThis.MediaRecorder = FakeRecorder;
  globalThis.SpeechRecognition = undefined;
  globalThis.webkitSpeechRecognition = undefined;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    },
  });
  return {
    recorders,
    restore() {
      globalThis.MediaRecorder = previous.MediaRecorder;
      globalThis.SpeechRecognition = previous.SpeechRecognition;
      globalThis.webkitSpeechRecognition = previous.webkitSpeechRecognition;
      if (previous.navigator) {
        Object.defineProperty(globalThis, 'navigator', previous.navigator);
      } else {
        delete globalThis.navigator;
      }
    },
  };
}

test('holdTalk records the mic and releaseTalk transcribes it', async () => {
  const mic = installMicRecorder();
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'Flying to Pentagon.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  backend.transcribe = async () => {
    backend.calls.push(['transcribe']);
    return { text: 'Take me to the Pentagon' };
  };
  const actions = [];
  try {
    const session = createVoiceSession({
      runner: async (name, args) => {
        actions.push([name, args]);
        return { ok: true, name };
      },
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    session.adapter.primeMic();
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.adapter.holdTalk();
    assert.equal(mic.recorders.length, 1);
    assert.equal(mic.recorders[0].state, 'recording');
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(backend.calls.some(([kind]) => kind === 'transcribe'));
    assert.deepEqual(
      actions.map(([name]) => name),
      ['fly_to_location'],
    );
    session.stop();
  } finally {
    mic.restore();
  }
});

test('start uses SpeechRecognition and MediaRecorder together when both exist', async () => {
  const order = [];
  const previousRecognition = globalThis.SpeechRecognition;
  class FakeRecognition {
    start() {
      order.push('recognition-start');
    }
    stop() {}
  }
  const mic = installMicRecorder();
  globalThis.SpeechRecognition = FakeRecognition;
  try {
    const session = createVoiceSession({
      runner: async () => ({ ok: true }),
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend: backendFixture({
            calls: [],
            speech: 'Done.',
            source: 'planner',
          }),
        }),
    });
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(order[0], 'recognition-start');
    assert.ok(mic.recorders.length >= 1);
    session.stop();
  } finally {
    mic.restore();
    globalThis.SpeechRecognition = previousRecognition;
  }
});

test('typed Pentagon still flies when getUserMedia is denied', async () => {
  const mic = installMicRecorder();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          throw new Error('NotAllowedError');
        },
      },
    },
  });
  const actions = [];
  const events = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'Flying to Pentagon.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  try {
    const session = createVoiceSession({
      runner: async (name, args) => {
        actions.push([name, args]);
        return { ok: true, name };
      },
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    session.subscribe((event) => events.push(event));
    assert.equal(await session.sendText('Take me to the Pentagon'), true);
    assert.deepEqual(
      actions.map(([name]) => name),
      ['fly_to_location'],
    );
    assert.ok(!events.some((event) => event.state === 'error'));
    session.stop();
  } finally {
    mic.restore();
  }
});
