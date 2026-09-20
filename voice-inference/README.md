# GodsEye self-hosted voice inference

Separate GPU box for:

- listen: `Qwen/Qwen3-ASR-0.6B` (Apache 2.0)
- understand/act: `Qwen/Qwen3-8B` (Apache 2.0)
- speak: `hexgrad/Kokoro-82M` (Apache 2.0)

The globe site stays up when this machine is off. Typed commands and the
JavaScript planner still fly to the Pentagon, find the nearest flight, and
enter the cockpit. Set `VOICE_INFERENCE_URL` on the globe host when this
service is reachable.

## Run

```bash
pip install -r requirements.txt
python3 app.py
```

Docker (NVIDIA runtime):

```bash
docker build -t gev-voice-inference .
docker run --gpus all -p 8090:8090 gev-voice-inference
```

Then on the globe host:

```
VOICE_INFERENCE_URL=http://<gpu-host>:8090
```

## Endpoints

- `GET /health` — `{ asr, llm, tts, models }`
- `POST /asr` — `{ audio: <base64>, mimeType }` → `{ text }`
- `POST /v1/chat/completions` — OpenAI-shaped tool calls
- `POST /tts` — `{ text }` → `audio/wav`
