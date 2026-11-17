Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.SetOutputToWaveFile((Join-Path $PSScriptRoot 'sample-en.wav'))
$s.Speak('Quarterly review. Revenue grew twelve percent. The marker word is pelican seven.')
$s.Dispose()
