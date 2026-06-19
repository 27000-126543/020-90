$content = Get-Content 'index.html' -Raw
$start = $content.IndexOf('<script>')
$end = $content.LastIndexOf('</script>')
$js = $content.Substring($start + 8, $end - $start - 8)
Set-Content -Path 'temp_check.js' -Value $js
node --check temp_check.js
