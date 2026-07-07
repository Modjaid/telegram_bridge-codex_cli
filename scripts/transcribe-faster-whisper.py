#!/usr/bin/env python3
import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: transcribe-faster-whisper.py /path/to/audio.wav", file=sys.stderr)
        return 1

    audio_path = sys.argv[-1]
    model_name = os.environ.get("LOCAL_WHISPER_MODEL", "Systran/faster-whisper-base")
    device = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    cpu_threads = int(os.environ.get("LOCAL_WHISPER_CPU_THREADS", "4"))
    language = os.environ.get("LOCAL_WHISPER_LANGUAGE", "ru") or None
    initial_prompt = os.environ.get("LOCAL_WHISPER_PROMPT", "") or None
    vad_filter = os.environ.get("LOCAL_WHISPER_VAD", "true").lower() in {"1", "true", "yes", "on"}
    beam_size = int(os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "5"))
    local_files_only = os.environ.get("LOCAL_WHISPER_LOCAL_FILES_ONLY", "true").lower() in {"1", "true", "yes", "on"}

    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        local_files_only=local_files_only,
    )

    segments, _info = model.transcribe(
        audio_path,
        language=language,
        beam_size=beam_size,
        vad_filter=vad_filter,
        initial_prompt=initial_prompt,
    )

    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    print(text.strip(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
