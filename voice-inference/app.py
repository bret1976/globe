#!/usr/bin/env python3
"""Self-hosted GodsEye voice inference: Qwen3-ASR-0.6B, Qwen3-8B, Kokoro-82M."""

from __future__ import annotations

import base64
import io
import os
import tempfile
from functools import lru_cache
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

ASR_MODEL_ID = os.environ.get("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
LLM_MODEL_ID = os.environ.get("QWEN_LLM_MODEL", "Qwen/Qwen3-8B")
TTS_MODEL_ID = os.environ.get("KOKORO_TTS_MODEL", "hexgrad/Kokoro-82M")

app = FastAPI(title="GodsEye voice inference", version="1.0.0")


class AsrRequest(BaseModel):
    audio: str
    mimeType: str = "audio/webm"
    model: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str | None = None


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    tool_choice: str | None = "auto"
    temperature: float = 0


class TtsRequest(BaseModel):
    text: str
    model: str | None = None


def _device() -> str:
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


@lru_cache(maxsize=1)
def load_asr():
    try:
        from qwen_asr import Qwen3ASRModel

        return Qwen3ASRModel.from_pretrained(ASR_MODEL_ID, device_map="auto")
    except Exception:
        from transformers import AutoModel, AutoProcessor

        processor = AutoProcessor.from_pretrained(ASR_MODEL_ID)
        model = AutoModel.from_pretrained(ASR_MODEL_ID, device_map="auto")
        return (processor, model)


@lru_cache(maxsize=1)
def load_llm():
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        LLM_MODEL_ID,
        torch_dtype="auto",
        device_map="auto",
    )
    return tokenizer, model


@lru_cache(maxsize=1)
def load_tts():
    from kokoro import KPipeline

    return KPipeline(lang_code="a")


def asr_ready() -> bool:
    try:
        load_asr()
        return True
    except Exception:
        return False


def llm_ready() -> bool:
    try:
        load_llm()
        return True
    except Exception:
        return False


def tts_ready() -> bool:
    try:
        load_tts()
        return True
    except Exception:
        return False


@app.get("/health")
def health() -> dict[str, Any]:
    eager = os.environ.get("VOICE_EAGER_LOAD", "0") == "1"
    if eager:
        return {
            "ok": True,
            "asr": asr_ready(),
            "llm": llm_ready(),
            "tts": tts_ready(),
            "device": _device(),
            "models": {
                "asr": ASR_MODEL_ID,
                "llm": LLM_MODEL_ID,
                "tts": TTS_MODEL_ID,
            },
        }
    return {
        "ok": True,
        "asr": True,
        "llm": True,
        "tts": True,
        "device": _device(),
        "models": {
            "asr": ASR_MODEL_ID,
            "llm": LLM_MODEL_ID,
            "tts": TTS_MODEL_ID,
        },
    }


@app.post("/asr")
def transcribe(req: AsrRequest) -> dict[str, str]:
    try:
        raw = base64.b64decode(req.audio)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid audio") from exc
    suffix = ".webm" if "webm" in (req.mimeType or "") else ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as handle:
        handle.write(raw)
        handle.flush()
        model = load_asr()
        if hasattr(model, "transcribe"):
            result = model.transcribe(handle.name)
            text = result.get("text") if isinstance(result, dict) else str(result)
        else:
            processor, asr = model
            inputs = processor(handle.name, return_tensors="pt")
            text = processor.decode(asr.generate(**inputs)[0], skip_special_tokens=True)
    text = str(text or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="ASR returned no transcript")
    return {"text": text, "model": ASR_MODEL_ID}


@app.post("/v1/chat/completions")
def chat(req: ChatRequest) -> dict[str, Any]:
    tokenizer, model = load_llm()
    messages = [message.model_dump() for message in req.messages]
    prompt = tokenizer.apply_chat_template(
        messages,
        tools=req.tools or None,
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    output = model.generate(
        **inputs,
        max_new_tokens=384,
        temperature=max(req.temperature, 0.01),
        do_sample=req.temperature > 0,
    )
    generated = output[0][inputs["input_ids"].shape[-1] :]
    text = tokenizer.decode(generated, skip_special_tokens=True)
    tool_calls = []
    if hasattr(tokenizer, "decode") and "<tool_call>" in text:
        import json
        import re

        for block in re.findall(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.S):
            try:
                parsed = json.loads(block)
                tool_calls.append(
                    {
                        "type": "function",
                        "function": {
                            "name": parsed.get("name"),
                            "arguments": json.dumps(parsed.get("arguments") or {}),
                        },
                    }
                )
            except json.JSONDecodeError:
                continue
    return {
        "id": "qwen3-8b",
        "object": "chat.completion",
        "model": LLM_MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text if not tool_calls else "",
                    "tool_calls": tool_calls,
                },
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
    }


@app.post("/tts")
def speak(req: TtsRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="TTS requires text")
    pipeline = load_tts()
    chunks = []
    for _graphenes, _phonemes, audio in pipeline(text, voice="af_heart"):
        chunks.append(audio)
    if not chunks:
        return JSONResponse({"speech": text, "audio": None})
    import numpy as np
    import soundfile as sf

    samples = np.concatenate(chunks)
    buffer = io.BytesIO()
    sf.write(buffer, samples, 24000, format="WAV")
    return Response(content=buffer.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8090")),
    )
