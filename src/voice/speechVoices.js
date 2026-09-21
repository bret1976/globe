const PREFERRED_VOICE_NAMES = [
  /google us english/i,
  /microsoft aria/i,
  /microsoft jenny/i,
  /samantha/i,
  /siri/i,
  /neural/i,
  /natural/i,
  /enhanced/i,
  /premium/i,
  /online \(natural\)/i,
];

const ROBOT_VOICE_NAMES =
  /compact|eloquent|zira|david|espeak|festival|robot|microsoft david|microsoft mark/i;

/** Pick the least synthetic English voice the browser exposes. */
export function pickHumanSpeechVoice(voices = []) {
  const list = Array.isArray(voices) ? voices : [];
  const english = list.filter((voice) => /^en/i.test(voice?.lang || ''));
  for (const pattern of PREFERRED_VOICE_NAMES) {
    const match = english.find((voice) => pattern.test(voice?.name || ''));
    if (match) return match;
  }
  return (
    english.find((voice) => !ROBOT_VOICE_NAMES.test(voice?.name || '')) ||
    english[0] ||
    null
  );
}
