# Director story mode (GodsEye)

Select a scene and shot in **Scenes**, then use the **STORY · selected shot** row:

- **✎ STORY**: timing, caption (title + text), narration script (read aloud by the browser; the shot waits for it), geolocated media (image or video by https URL or file upload, pinned at a lat/lon or "Pin at map center"), and a satellite **before/after swipe** (Esri Wayback archive release dates 2014→today, or current Esri imagery; sweep animation or a draggable divider).
- **◧ START / ◨ END**: frame the map, then capture the shot's start or end framing (a controlled pose-to-pose move, no JSON).
- **● RECORD**: plays the selected scene once and downloads a video (MP4 where supported, otherwise WebM). It captures the globe with the caption, media card and swipe overlays. It does not capture spoken narration or the HUD chrome.
- **⇩ / ⇧ STORY FILE**: a `.gevstory.json` with the scene plus uploaded videos. Import adds the story as a new scene and replaces nothing.

Stories are saved in `shot.story` (see `src/director/story.js`) and survive the existing EXPORT/IMPORT/SHARE SCENE. Uploaded images are downscaled into the scene. Uploaded videos (≤25 MB) stay in this browser's IndexedDB and travel only in a story file. Remote media must allow CORS to appear inside recordings.
