/**
 * Scenes-panel story tools: a no-JSON editor for the selected shot's story
 * (caption, narration, geolocated media, before/after imagery, timing),
 * start/end framing capture, one-click RECORD and portable story files.
 */
import * as Cesium from 'cesium';
import { createSceneDialog } from './sceneSharing.js';
import {
  parseSceneDocument,
  stringifySceneDocument,
} from '../director/document.js';
import {
  WAYBACK_CONFIG_URL,
  nearestWaybackRelease,
  parseWaybackReleases,
  storyHasContent,
} from '../director/story.js';
import {
  buildStoryFile,
  imageFileToInline,
  storeVideoFile,
  unpackStoryFile,
} from '../scenes/storyMedia.js';
import { primeSpeech } from '../scenes/storyRuntime.js';
import { recordRun, recordingSupported } from '../scenes/storyRecorder.js';

let waybackPromise = null;
export function loadWaybackReleases() {
  waybackPromise ||= fetch(WAYBACK_CONFIG_URL)
    .then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
    )
    .then(parseWaybackReleases)
    .catch((error) => {
      waybackPromise = null;
      throw error;
    });
  return waybackPromise;
}

const POSE_KEYS = ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll'];
const pose = (camera) =>
  Object.fromEntries(POSE_KEYS.map((k) => [k, Number(camera[k]) || 0]));

function download(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
}

/** Ground point under the middle of the view, or the camera position. */
function viewCenter(director) {
  const viewer = director.viewer;
  const canvas = viewer.scene.canvas;
  const hit = viewer.camera.pickEllipsoid(
    new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    viewer.scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
  );
  if (hit) {
    const c = Cesium.Cartographic.fromCartesian(hit);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  }
  const cam = director.styleManager.getCameraState();
  return cam ? { lat: cam.lat, lon: cam.lon } : null;
}

export function createStoryTools(director) {
  let dialog = null;
  let recording = false;
  const selected = () => {
    const scene = director._getSelectedScene();
    const shot = scene?.shots.find((s) => s.id === director._selectedShotId);
    return { scene, shot };
  };
  const status = (text) => director._updateStatus(text);

  /** Mutate the selected shot, validate the whole project, then save. */
  function editShot(mutate, message) {
    const { scene, shot } = selected();
    if (!scene || !shot) {
      status('Select a shot first');
      return false;
    }
    if (director._running) {
      status('Stop playback before editing');
      return false;
    }
    const before = structuredClone(shot);
    try {
      mutate(shot);
      parseSceneDocument(stringifySceneDocument(director._project));
    } catch (error) {
      for (const key of Object.keys(shot)) delete shot[key];
      Object.assign(shot, before);
      status(`Not saved: ${error.message}`);
      throw error;
    }
    director._saveProject();
    director._shotOutcome('shot-updated', scene, shot);
    if (message) status(message);
    return true;
  }

  function captureStartFrame() {
    const camera = director.styleManager.getCameraState();
    if (!camera) return status('Camera not ready');
    try {
      editShot((shot) => {
        shot.move = {
          from: { ...pose(camera), altitudeReference: 'ellipsoid' },
          easing: 'cubic-in-out',
        };
        if (!shot.camera.anchorId) shot.camera.altitudeReference = 'ellipsoid';
        shot.durationSec = Math.max(0.2, shot.durationSec || 4);
      }, 'Start framing set — the shot moves from here to its end framing');
    } catch {}
  }

  function captureEndFrame() {
    const camera = director.styleManager.getCameraState();
    if (!camera) return status('Camera not ready');
    try {
      editShot((shot) => {
        shot.camera = {
          ...pose(camera),
          ...(shot.move ? { altitudeReference: 'ellipsoid' } : {}),
        };
      }, 'End framing set from the current camera');
    } catch {}
  }

  function close() {
    dialog?.dispose();
    dialog = null;
  }

  function field(parent, label, node, hint) {
    const wrap = document.createElement('label');
    wrap.style.display = 'block';
    wrap.style.margin = '6px 0 10px';
    wrap.textContent = label;
    Object.assign(node.style, {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      padding: '7px',
      marginTop: '4px',
      color: '#e3faff',
      background: '#10242e',
      border: '1px solid #397080',
      font: 'inherit',
      // 16px stops iOS Safari zooming on focus; appearance:none lets dark
      // backgrounds apply to <select> in WebKit.
      fontSize: '16px',
      borderRadius: '3px',
      appearance: 'none',
      webkitAppearance: 'none',
    });
    if (node.tagName === 'SELECT')
      Object.assign(node.style, {
        backgroundImage:
          'linear-gradient(45deg, transparent 50%, #9fd 50%), linear-gradient(135deg, #9fd 50%, transparent 50%)',
        backgroundPosition: 'calc(100% - 16px) 50%, calc(100% - 11px) 50%',
        backgroundSize: '5px 5px',
        backgroundRepeat: 'no-repeat',
        paddingRight: '28px',
      });
    node.setAttribute('aria-label', label);
    wrap.append(node);
    if (hint) {
      const h = document.createElement('small');
      h.textContent = hint;
      h.style.opacity = '0.7';
      wrap.append(h);
    }
    parent.append(wrap);
    return node;
  }
  const make = (tag, props = {}) =>
    Object.assign(document.createElement(tag), props);
  function section(title) {
    const box = make('fieldset');
    Object.assign(box.style, {
      border: '1px solid #234a56',
      borderRadius: '4px',
      padding: '8px 12px',
      margin: '0 0 12px',
    });
    const legend = make('legend', { textContent: title });
    legend.style.padding = '0 6px';
    legend.style.color = '#ffb547';
    box.append(legend);
    dialog.body.append(box);
    return box;
  }
  function selectOf(options, value) {
    const s = make('select');
    for (const [v, t] of options)
      s.append(make('option', { value: v, textContent: t }));
    s.value = value;
    return s;
  }

  function openEditor() {
    const { scene, shot } = selected();
    if (!scene || !shot) return status('Select a shot first');
    if (director._running) return status('Stop playback before editing');
    close();
    dialog = createSceneDialog(`Story — ${shot.title}`, close);
    dialog.element.dataset.storyEditor = '';
    dialog.element.style.colorScheme = 'dark';
    const story = structuredClone(shot.story || {});
    dialog.text(
      'Everything here is shown only while this shot plays. Leave a section empty to skip it.',
    );

    const t = section('Timing');
    const duration = field(
      t,
      'Camera move (seconds)',
      make('input', {
        type: 'number',
        min: '0.2',
        max: '600',
        step: '0.5',
        value: String(shot.durationSec ?? 4),
      }),
    );
    const hold = field(
      t,
      'Hold after arriving (seconds)',
      make('input', {
        type: 'number',
        min: '0',
        max: '600',
        step: '0.5',
        value: String(shot.holdSec ?? 0),
      }),
      'The shot also waits for narration to finish.',
    );
    duration.dataset.storyDuration = '';
    hold.dataset.storyHold = '';
    const moveNote = make('p', {
      textContent: shot.move
        ? 'Camera move: start framing → end framing (use ◧ START / ◨ END in the panel).'
        : 'Camera move: ordinary flight to the end framing. Use ◧ START in the panel for a controlled move.',
    });
    moveNote.style.opacity = '0.8';
    t.append(moveNote);
    if (shot.move)
      dialog.button(
        'Use ordinary flight',
        () => {
          moveNote.textContent =
            'Ordinary flight (saved when you press Save story).';
          clearMove = true;
        },
        t,
      );
    let clearMove = false;

    const c = section('Caption');
    const capTitle = field(
      c,
      'Title',
      make('input', { value: story.caption?.title || '', maxLength: 200 }),
    );
    const capText = field(
      c,
      'Text',
      make('textarea', {
        value: story.caption?.text || '',
        rows: 3,
        maxLength: 2000,
      }),
    );
    const capPos = field(
      c,
      'Position',
      selectOf(
        [
          ['bottom', 'Bottom'],
          ['top', 'Top'],
        ],
        story.caption?.position || 'bottom',
      ),
    );
    capTitle.dataset.storyCaptionTitle = '';
    capText.dataset.storyCaptionText = '';

    const n = section('Narration (read aloud)');
    const narText = field(
      n,
      'Script',
      make('textarea', {
        value: story.narration?.text || '',
        rows: 3,
        maxLength: 4000,
      }),
    );
    narText.dataset.storyNarration = '';
    const rate = field(
      n,
      'Speed',
      selectOf(
        [
          ['0.8', 'Slow'],
          ['1', 'Normal'],
          ['1.2', 'Fast'],
        ],
        String(story.narration?.rate || 1),
      ),
    );
    const voices = globalThis.speechSynthesis?.getVoices?.() || [];
    const voice = field(
      n,
      'Voice',
      selectOf(
        [
          ['', 'Browser default'],
          ...voices
            .filter((v) => /^en/i.test(v.lang))
            .slice(0, 40)
            .map((v) => [v.name, `${v.name} (${v.lang})`]),
        ],
        story.narration?.voice || '',
      ),
    );
    dialog.button(
      '▶ Test voice',
      () => {
        if (!globalThis.speechSynthesis)
          return (dialog.status.textContent =
            'Speech not available in this browser');
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(
          narText.value || 'Narration test',
        );
        u.rate = Number(rate.value);
        const v = speechSynthesis
          .getVoices()
          .find((x) => x.name === voice.value);
        if (v) u.voice = v;
        speechSynthesis.speak(u);
      },
      n,
    );

    const m = section('Geolocated media (pinned on the map)');
    const kind = field(
      m,
      'Type',
      selectOf(
        [
          ['', 'None'],
          ['image', 'Image'],
          ['video', 'Video clip'],
        ],
        story.media?.kind || '',
      ),
    );
    kind.dataset.storyMediaKind = '';
    const isInline =
      story.media?.src?.startsWith('data:') ||
      story.media?.src?.startsWith('upload:');
    const url = field(
      m,
      'URL (https)',
      make('input', {
        type: 'url',
        value: isInline ? '' : story.media?.src || '',
        placeholder: 'https://…/clip.mp4 or image.jpg',
      }),
      'Or upload a file below. Images are stored in the scene; videos stay on this device and travel in a ⇩ STORY FILE.',
    );
    url.dataset.storyMediaUrl = '';
    const file = field(
      m,
      'Upload file',
      make('input', { type: 'file', accept: 'image/*,video/*' }),
    );
    file.dataset.storyMediaFile = '';
    const uploadNote = make('p', {
      textContent: isInline
        ? `Stored upload: ${story.media.fileName || 'file'}`
        : '',
    });
    m.append(uploadNote);
    let uploadedSrc = isInline ? story.media.src : null;
    let uploadedName = story.media?.fileName;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      uploadNote.textContent = 'Storing…';
      try {
        if (f.type.startsWith('video/')) {
          uploadedSrc = await storeVideoFile(f);
          kind.value = 'video';
        } else {
          uploadedSrc = await imageFileToInline(f);
          kind.value = 'image';
        }
        uploadedName = f.name.slice(0, 200);
        url.value = '';
        uploadNote.textContent = `Stored upload: ${uploadedName}`;
      } catch (error) {
        uploadNote.textContent = error?.message || 'Upload could not be stored';
      }
    });
    const lat = field(
      m,
      'Latitude',
      make('input', {
        type: 'number',
        step: 'any',
        min: '-90',
        max: '90',
        value: story.media?.lat ?? '',
      }),
    );
    const lon = field(
      m,
      'Longitude',
      make('input', {
        type: 'number',
        step: 'any',
        min: '-180',
        max: '180',
        value: story.media?.lon ?? '',
      }),
    );
    lat.dataset.storyMediaLat = '';
    lon.dataset.storyMediaLon = '';
    dialog.button(
      'Pin at map center',
      () => {
        const center = viewCenter(director);
        if (!center) return (dialog.status.textContent = 'Map not ready');
        lat.value = center.lat.toFixed(6);
        lon.value = center.lon.toFixed(6);
      },
      m,
    );
    const mediaLabel = field(
      m,
      'Label',
      make('input', {
        value: story.media?.label || '',
        maxLength: 200,
        placeholder: 'e.g. Witness video, Timure bridge',
      }),
    );

    const s = section('Satellite before / after (swipe)');
    const enabled = field(
      s,
      'Show swipe during this shot',
      selectOf(
        [
          ['', 'Off'],
          ['on', 'On'],
        ],
        story.compare ? 'on' : '',
      ),
    );
    enabled.dataset.storyCompare = '';
    const sideOptions = [['esri', 'Esri World Imagery — current']];
    const before = field(s, 'Before (left)', selectOf(sideOptions, 'esri'));
    const after = field(s, 'After (right)', selectOf(sideOptions, 'esri'));
    before.dataset.storyBefore = '';
    after.dataset.storyAfter = '';
    const beforeDate = field(
      s,
      'Jump "before" to the archive nearest a date',
      make('input', { type: 'date' }),
      'Esri Wayback archive releases, 2014 → today. Release date = when that imagery was published, capture can be earlier.',
    );
    const sweep = field(
      s,
      'Animate the swipe',
      selectOf(
        [
          ['on', 'Sweep before → after'],
          ['', 'Hold at middle (drag during playback)'],
        ],
        story.compare?.sweep === false ? '' : 'on',
      ),
    );
    const sideValue = (side) =>
      side?.source === 'wayback' ? `wayback:${side.release}` : 'esri';
    let releases = [];
    loadWaybackReleases()
      .then((list) => {
        releases = list;
        for (const sel of [before, after]) {
          const keep =
            sel === before
              ? sideValue(story.compare?.before)
              : sideValue(story.compare?.after);
          for (const r of list)
            sel.append(
              make('option', {
                value: `wayback:${r.release}`,
                textContent: `Wayback ${r.date}`,
              }),
            );
          sel.value = keep;
          if (!sel.value) sel.value = 'esri';
        }
        if (!story.compare && list.length)
          before.value = `wayback:${list[Math.min(list.length - 1, 24)].release}`;
      })
      .catch(
        () =>
          dialog &&
          (dialog.status.textContent =
            'Wayback archive list unavailable; current imagery only'),
      );
    beforeDate.addEventListener('change', () => {
      const r = nearestWaybackRelease(releases, beforeDate.value);
      if (r) before.value = `wayback:${r.release}`;
    });
    const sideFrom = (value) => {
      if (value.startsWith('wayback:')) {
        const release = Number(value.slice(8));
        const date = releases.find((r) => r.release === release)?.date;
        return { source: 'wayback', release, ...(date ? { label: date } : {}) };
      }
      return { source: 'esri', label: 'Current' };
    };

    const save = dialog.button('Save story', () => {
      const next = {};
      if (capTitle.value.trim() || capText.value.trim())
        next.caption = {
          ...(capTitle.value.trim() ? { title: capTitle.value.trim() } : {}),
          ...(capText.value.trim() ? { text: capText.value.trim() } : {}),
          position: capPos.value,
        };
      if (narText.value.trim())
        next.narration = {
          text: narText.value.trim(),
          rate: Number(rate.value),
          ...(voice.value ? { voice: voice.value } : {}),
        };
      if (kind.value) {
        const src = url.value.trim() || uploadedSrc;
        if (!src)
          return (dialog.status.textContent =
            'Add a media URL or upload a file');
        if (lat.value === '' || lon.value === '')
          return (dialog.status.textContent =
            'Set the media location (Pin at map center)');
        next.media = {
          kind: kind.value,
          src,
          lat: Number(lat.value),
          lon: Number(lon.value),
          ...(mediaLabel.value.trim()
            ? { label: mediaLabel.value.trim() }
            : {}),
          ...(!url.value.trim() && uploadedName
            ? { fileName: uploadedName }
            : {}),
        };
      }
      if (enabled.value)
        next.compare = {
          before: sideFrom(before.value),
          after: sideFrom(after.value),
          split: 0.5,
          sweep: !!sweep.value,
        };
      try {
        editShot((target) => {
          if (Object.keys(next).length) target.story = next;
          else delete target.story;
          target.durationSec = Math.max(0.2, Number(duration.value) || 4);
          target.holdSec = Math.max(0, Number(hold.value) || 0);
          if (clearMove) {
            delete target.move;
          }
        }, `Story saved: ${shot.title}`);
        close();
      } catch (error) {
        if (dialog) dialog.status.textContent = `Not saved: ${error.message}`;
      }
    });
    save.dataset.storySave = '';
  }

  async function record() {
    if (recording) return;
    if (director._running) return status('Stop playback first');
    if (!recordingSupported()) {
      director._lastRecording = { error: 'unsupported' };
      return status(
        'Recording is not supported in this browser — use the device screen recorder, or Safari 14.5+ / Chrome',
      );
    }
    const { scene } = selected();
    if (!scene?.shots.length) return status('Select a scene with shots');
    recording = true;
    primeSpeech();
    try {
      const result = await recordRun(
        director.viewer,
        () => director._story.snapshot(),
        () => director.startScene(scene.id, { single: true }),
      );
      director._lastRecording = {
        size: result.blob.size,
        type: result.type,
        url: result.url,
        fileName: result.fileName,
        durationMs: result.durationMs,
        width: result.width,
      };
      if (result.blob.size < 1000) throw new Error('Recording came out empty');
      download(result.url, result.fileName);
      status(
        `Recorded ${(result.blob.size / 1048576).toFixed(1)} MB ${result.type} — downloaded ${result.fileName}`,
      );
    } catch (error) {
      director._lastRecording = { error: error.message };
      status(`Recording failed: ${error.message}`);
    } finally {
      recording = false;
    }
  }

  async function exportStory() {
    const { scene } = selected();
    if (!scene) return status('Select a scene first');
    try {
      const doc = parseSceneDocument(stringifySceneDocument(director._project));
      doc.scenes = doc.scenes.filter((s) => s.id === scene.id);
      const text = await buildStoryFile(JSON.stringify(doc), scene);
      const url = URL.createObjectURL(
        new Blob([text], { type: 'application/json' }),
      );
      download(
        url,
        `${scene.title.replace(/[^\w-]+/g, '-').slice(0, 60) || 'story'}.gevstory.json`,
      );
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status('Story file downloaded (scene + uploaded media)');
    } catch (error) {
      status(`Story export failed: ${error.message}`);
    }
  }

  /** Append a story file's scenes to the current project (nothing is replaced). */
  async function importStoryText(text) {
    const doc = parseSceneDocument(await unpackStoryFile(text));
    const ids = new Set(director._project.scenes.map((s) => s.id));
    const added = [];
    for (const scene of doc.scenes) {
      if (ids.has(scene.id))
        scene.id = `${scene.id}-${Date.now().toString(36)}`;
      director._project.scenes.push(scene);
      added.push(scene);
    }
    try {
      parseSceneDocument(stringifySceneDocument(director._project));
    } catch (error) {
      director._project.scenes.splice(-added.length, added.length);
      throw error;
    }
    director._selectedSceneId = added[0]?.id || director._selectedSceneId;
    director._selectedShotId = added[0]?.shots[0]?.id || null;
    director._saveProject();
    director._renderSceneSelect();
    director._renderShotList();
    status(`Imported story: ${added.map((s) => s.title).join(', ')}`);
    return added.map((s) => s.id);
  }

  let fileInput = null;
  function importStory() {
    fileInput ||= Object.assign(document.createElement('input'), {
      type: 'file',
      accept: '.json,application/json',
      hidden: true,
    });
    if (!fileInput.isConnected) document.body.append(fileInput);
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      try {
        await importStoryText(await f.text());
      } catch (error) {
        status(`Story import failed: ${error.message}`);
      }
    };
    fileInput.click();
  }

  return {
    openEditor,
    captureStartFrame,
    captureEndFrame,
    record,
    exportStory,
    importStory,
    importStoryText,
    close,
    hasStory: () => storyHasContent(selected().shot?.story),
    destroy() {
      close();
      fileInput?.remove();
    },
  };
}

/** Mount the story toolbar into the Scenes panel. */
export function mountStoryTools(
  director,
  panel = document.getElementById('scene-panel'),
) {
  const tools = createStoryTools(director);
  director._storyTools = tools;
  if (!panel) return () => tools.destroy();
  const bar = document.createElement('div');
  bar.dataset.storyTools = '';
  bar.className = 'scene-controls';
  const title = document.createElement('div');
  title.textContent = 'STORY · selected shot';
  Object.assign(title.style, {
    width: '100%',
    font: '600 10px/1.4 ui-monospace, monospace',
    letterSpacing: '0.12em',
    color: '#ffb547',
    margin: '6px 0 2px',
  });
  bar.append(title);
  const removers = [];
  for (const [label, fn, key, tip] of [
    [
      '✎ STORY',
      tools.openEditor,
      'edit',
      'Caption, narration, media pin, before/after for the selected shot',
    ],
    [
      '◧ START',
      tools.captureStartFrame,
      'start-frame',
      'Use the current camera as the shot’s start framing',
    ],
    [
      '◨ END',
      tools.captureEndFrame,
      'end-frame',
      'Use the current camera as the shot’s end framing',
    ],
    [
      '● RECORD',
      tools.record,
      'record',
      'Play the scene and save it as a video',
    ],
    [
      '⇩ STORY FILE',
      tools.exportStory,
      'export',
      'Download this scene with its uploaded media',
    ],
    [
      '⇧ STORY FILE',
      tools.importStory,
      'import',
      'Add a story file as a new scene',
    ],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = tip;
    b.className = 'scene-btn';
    b.dataset.storyTool = key;
    if (key === 'record') b.style.color = '#ff6b6b';
    b.addEventListener('click', fn);
    removers.push(() => b.removeEventListener('click', fn));
    bar.append(b);
  }
  (panel.querySelector?.('.scene-panel-inner') || panel).appendChild(bar);
  return () => {
    for (const remove of removers) remove();
    bar.remove();
    tools.destroy();
  };
}
