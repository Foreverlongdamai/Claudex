# 用 Windows 自带的中文语音合成一段约一分钟的录音，给转写测试用
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.SetOutputToWaveFile((Join-Path $PSScriptRoot 'sample-zh.wav'))
$s.Speak('大家好，今天的会议主要讨论三件事。第一，下周三之前完成内置终端的测试，并且提交到代码仓库。第二，Git 审查功能需要支持按行写评论，评论会发给 Claude 处理。第三，关于自动化任务，我们决定每天早上九点运行一次，结果放进审查队列。另外，请大家注意，录音转文字默认使用本地模型，不会上传到任何服务器。散会。')
$s.Dispose()
