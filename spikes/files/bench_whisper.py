# 在本机 CPU 上比较 faster-whisper 的 small 和 large-v3：速度和中文准确度
# 用法：python bench_whisper.py <音频文件>
import os
import sys
import time

from faster_whisper import WhisperModel

MODELS = {
    'small': r'D:\hf-cache\hub\models--Systran--faster-whisper-small\snapshots\536b0662742c02347bc0e980a01041f333bce120',
    'large-v3': os.path.expanduser(r'~\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478'),
}
audio = sys.argv[1]
threads = min(16, os.cpu_count() or 4)
for name, path in MODELS.items():
    t0 = time.time()
    model = WhisperModel(path, device='cpu', compute_type='int8', cpu_threads=threads)
    t1 = time.time()
    segments, info = model.transcribe(audio, language=None, vad_filter=True, beam_size=5,
                                      initial_prompt='以下是普通话的句子，使用简体中文和标点。')
    text = ''.join(s.text for s in segments)
    t2 = time.time()
    print(f'== {name}: 加载 {t1 - t0:.1f}s，转写 {t2 - t1:.1f}s（音频 {info.duration:.1f}s，{info.duration / (t2 - t1):.1f} 倍速），语言 {info.language} {info.language_probability:.2f}')
    print(text.strip())
