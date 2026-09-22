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
          return {
            getTracks: () => [{ stop() {}, readyState: 'live', enabled: true }],
            getAudioTracks: () => [
              {
                getSettings: () => ({ deviceId: 'default' }),
                readyState: 'live',
                enabled: true,
                stop() {},
              },
            ],
          };
        },
        async enumerateDevices() {
          return [];
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
    session.adapter.holdTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
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

test('start records the real microphone even when SpeechRecognition exists', async () => {
  const order = [];
  const previousRecognition = globalThis.SpeechRecognition;
  class FakeRecognition {
    start() {
      order.push('recognition-start');
    }
    stop() {
      order.push('recognition-stop');
    }
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
    session.adapter.primeMic();
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(mic.recorders.length >= 1);
    assert.ok(!order.includes('recognition-start'));
    session.stop();
  } finally {
    mic.restore();
    globalThis.SpeechRecognition = previousRecognition;
  }
});

test('cancelHold after a short press keeps the open-mic recorder', async () => {
  const order = [];
  const previousRecognition = globalThis.SpeechRecognition;
  class FakeRecognition {
    start() {
      order.push('recognition-start');
    }
    stop() {
      order.push('recognition-stop');
    }
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
    session.adapter.primeMic();
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.adapter.holdTalk();
    session.adapter.cancelHold();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(mic.recorders.some((recorder) => recorder.state === 'recording'));
    assert.ok(!order.includes('recognition-start'));
    session.stop();
  } finally {
    mic.restore();
    globalThis.SpeechRecognition = previousRecognition;
  }
});

test('open-mic recording is transcribed after releaseTalk', async () => {
  const mic = installMicRecorder();
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'On my way to the Pentagon.',
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
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
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

test('open-mic records a second command after the first reply', async () => {
  const mic = installMicRecorder();
  let spokenTurn = 0;
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'On my way to the Pentagon.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  backend.act = async (payload) => {
    backend.calls.push(['act', payload.text]);
    if (/miami/i.test(payload.text)) {
      return {
        calls: [
          {
            name: 'fly_to_location',
            arguments: { query: 'Miami', waitForArrival: true },
          },
        ],
        speech: 'Heading to Miami.',
        locationQuery: 'Miami',
        place: { query: 'Miami' },
        source: 'planner',
      };
    }
    return {
      calls: [
        {
          name: 'fly_to_location',
          arguments: { query: 'Pentagon', waitForArrival: true },
        },
      ],
      speech: 'On my way to the Pentagon.',
      locationQuery: 'Pentagon',
      place: { query: 'Pentagon' },
      source: 'planner',
    };
  };
  backend.transcribe = async () => {
    spokenTurn += 1;
    backend.calls.push(['transcribe', spokenTurn]);
    return {
      text: spokenTurn === 1 ? 'Take me to the Pentagon' : 'Take me to Miami',
    };
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
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(mic.recorders.length, 1);
    assert.equal(mic.recorders[0].state, 'recording');
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      mic.recorders.some((recorder) => recorder.state === 'recording'),
      'mic must keep recording after the first reply',
    );
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      actions.map(([name, args]) => [name, args.query]),
      [
        ['fly_to_location', 'Pentagon'],
        ['fly_to_location', 'Miami'],
      ],
    );
    assert.equal(spokenTurn, 2);
    session.stop();
  } finally {
    mic.restore();
  }
});

test('empty ASR after a clip still restarts the open-mic recorder', async () => {
  const mic = installMicRecorder();
  const backend = backendFixture({
    calls: [],
    speech: 'Done.',
    source: 'planner',
  });
  backend.transcribe = async () => {
    backend.calls.push(['transcribe']);
    return { text: '' };
  };
  try {
    const session = createVoiceSession({
      runner: async () => ({ ok: true }),
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    session.adapter.primeMic();
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = mic.recorders[0];
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(backend.calls.some(([kind]) => kind === 'transcribe'));
    assert.ok(
      mic.recorders.some(
        (recorder) => recorder !== first && recorder.state === 'recording',
      ),
      'silence from ASR must not leave the mic dead',
    );
    session.stop();
  } finally {
    mic.restore();
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

test('a second command still runs after a blocking fly-to', async () => {
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
  let actCount = 0;
  const originalAct = backend.act;
  backend.act = async (payload) => {
    actCount += 1;
    if (actCount === 1) return originalAct(payload);
    return {
      calls: [{ name: 'zoom_to_globe', arguments: {} }],
      speech: 'Pulling back to the globe.',
      source: 'planner',
    };
  };
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
  await session.start();
  assert.equal(await session.sendText('Take me to the Pentagon'), true);
  assert.equal(await session.sendText('Zoom to globe'), true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['fly_to_location', 'zoom_to_globe'],
  );
  session.stop();
});

test('a follow-up typed during the first fly is queued, not dropped', async () => {
  const actions = [];
  let releaseFly;
  const flying = new Promise((resolve) => {
    releaseFly = resolve;
  });
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
  let actCount = 0;
  const originalAct = backend.act;
  backend.act = async (payload) => {
    actCount += 1;
    if (actCount === 1) return originalAct(payload);
    return {
      calls: [{ name: 'zoom_to_globe', arguments: {} }],
      speech: 'Pulling back.',
      source: 'planner',
    };
  };
  const session = createVoiceSession({
    runner: async (name, args) => {
      if (name === 'fly_to_location') await flying;
      actions.push([name, args]);
      return { ok: true, name };
    },
    createAdapter: (hooks) =>
      createSelfHostedSession({
        ...hooks,
        backend,
      }),
  });
  await session.start();
  const first = session.sendText('Take me to the Pentagon');
  await Promise.resolve();
  const second = session.sendText('Zoom to globe');
  releaseFly();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['fly_to_location', 'zoom_to_globe'],
  );
  session.stop();
});

test('a hanging TTS reply still releases the session for the next command', async () => {
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
  let speakCount = 0;
  backend.speak = ({ text }) => {
    speakCount += 1;
    if (speakCount === 1) return new Promise(() => {});
    return { text, audio: null };
  };
  let actCount = 0;
  const originalAct = backend.act;
  backend.act = async (payload) => {
    actCount += 1;
    if (actCount === 1) return originalAct(payload);
    return {
      calls: [{ name: 'zoom_to_globe', arguments: {} }],
      speech: 'Pulling back.',
      source: 'planner',
    };
  };
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
  await session.start();
  const started = Date.now();
  assert.equal(await session.sendText('Take me to the Pentagon'), true);
  assert.equal(await session.sendText('Zoom to globe'), true);
  assert.ok(
    Date.now() - started < 8_000,
    'TTS must not pin the session past its speak deadline',
  );
  assert.deepEqual(
    actions.map(([name]) => name),
    ['fly_to_location', 'zoom_to_globe'],
  );
  session.stop();
});

test('a second spoken command is heard while the first reply is still talking', async () => {
  const mic = installMicRecorder();
  let spokenTurn = 0;
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'On my way to the Pentagon.',
    source: 'planner',
  });
  backend.speak = () => new Promise(() => {});
  backend.act = async (payload) => {
    backend.calls.push(['act', payload.text]);
    if (/miami/i.test(payload.text)) {
      return {
        calls: [
          {
            name: 'fly_to_location',
            arguments: { query: 'Miami', waitForArrival: true },
          },
        ],
        speech: 'Heading to Miami.',
        source: 'planner',
      };
    }
    return {
      calls: [
        {
          name: 'fly_to_location',
          arguments: { query: 'Pentagon', waitForArrival: true },
        },
      ],
      speech: 'On my way to the Pentagon.',
      source: 'planner',
    };
  };
  backend.transcribe = async () => {
    spokenTurn += 1;
    return {
      text: spokenTurn === 1 ? 'Take me to the Pentagon' : 'Take me to Miami',
    };
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
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      mic.recorders.some((recorder) => recorder.state === 'recording'),
      'the mic must stay open during the first spoken reply',
    );
    await session.adapter.releaseTalk();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      actions.map(([name, args]) => [name, args.query]),
      [
        ['fly_to_location', 'Pentagon'],
        ['fly_to_location', 'Miami'],
      ],
    );
    session.stop();
  } finally {
    mic.restore();
  }
});

test('open-mic is recording again before a hanging TTS reply ends', async () => {
  const mic = installMicRecorder();
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
  backend.speak = () => new Promise(() => {});
  try {
    const session = createVoiceSession({
      runner: async () => ({ ok: true }),
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    session.adapter.primeMic();
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = Date.now();
    assert.equal(await session.sendText('Take me to the Pentagon'), true);
    assert.ok(
      Date.now() - started < 6_500,
      'the first turn must not wait out a hung speak() before returning',
    );
    assert.ok(
      mic.recorders.some((recorder) => recorder.state === 'recording'),
      'the mic must be open for the next spoken command during TTS',
    );
    session.stop();
  } finally {
    mic.restore();
  }
});

test('late chunks from a stopped recorder cannot corrupt ten successive commands', async () => {
  const mic = installMicRecorder();
  const audioSizes = [];
  const actions = [];
  const session = createSelfHostedSession({
    emit() {},
    runAction: async (name) => {
      actions.push(name);
      return { ok: true };
    },
    backend: {
      ...backendFixture({
        calls: [{ name: 'fly_to_location', arguments: {} }],
        speech: 'Done.',
      }),
      async transcribe({ audio }) {
        audioSizes.push(audio.length);
        return { text: 'Take me to the Pentagon' };
      },
    },
  });
  try {
    await session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 10; i++) {
      const old = mic.recorders.at(-1);
      await session.releaseTalk();
      old.ondataavailable({ data: new Blob([new Uint8Array(999)]) });
    }
    assert.equal(actions.length, 10);
    assert.deepEqual(audioSizes, Array(10).fill(800));
  } finally {
    session.stop();
    mic.restore();
  }
});

test('failed actions stop dependent cockpit entry and leave the next command usable', async () => {
  const events = [],
    actions = [];
  const session = createSelfHostedSession({
    emit: (e) => events.push(e),
    backend: backendFixture({
      calls: [{ name: 'select_nearest_aircraft' }, { name: 'control_cockpit' }],
      speech: 'Entering cockpit.',
    }),
    runAction: async (name) => {
      actions.push(name);
      return { ok: false, error: 'No airborne aircraft nearby' };
    },
  });
  await session.sendText('Cockpit view');
  await session.sendText('Try again');
  assert.deepEqual(actions, [
    'select_nearest_aircraft',
    'select_nearest_aircraft',
  ]);
  assert.equal(events.filter((e) => e.status === 'failed').length, 2);
  assert.ok(!events.some((e) => e.text === 'Entering cockpit.'));
  session.stop();
});

test('a planner response after stop cannot execute or restart microphone capture', async () => {
  let resolve;
  const actions = [];
  const session = createSelfHostedSession({
    emit() {},
    runAction: async (name) => actions.push(name),
    backend: {
      ...backendFixture({}),
      act: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  const turn = session.sendText('Pentagon');
  session.stop();
  resolve({ calls: [{ name: 'fly_to_location' }] });
  await turn;
  assert.deepEqual(actions, []);
});
