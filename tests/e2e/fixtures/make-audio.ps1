# 生成端到端测试用的短录音（Windows 自带的中文语音合成）。运行：powershell -File make-audio.ps1，再用 ffmpeg 转成 16kHz 单声道
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.SetOutputToWaveFile((Join-Path $PSScriptRoot 'raw.wav'))
$s.Speak('这是一段测试录音。今天的暗号是长江九号。')
$s.Dispose()
