# Generate the PNG equivalents of public/icons/marina.svg without external tools.
Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null
foreach ($size in @(180, 192, 512)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#4f46e5'))
  $graphics.ScaleTransform($size / 512.0, $size / 512.0)
  $letter = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $letter.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(132,360), [System.Drawing.PointF]::new(132,152),
    [System.Drawing.PointF]::new(180,152), [System.Drawing.PointF]::new(256,263),
    [System.Drawing.PointF]::new(332,152), [System.Drawing.PointF]::new(380,152),
    [System.Drawing.PointF]::new(380,360), [System.Drawing.PointF]::new(332,360),
    [System.Drawing.PointF]::new(332,238), [System.Drawing.PointF]::new(256,346),
    [System.Drawing.PointF]::new(180,238), [System.Drawing.PointF]::new(180,360)
  ))
  $graphics.FillPath([System.Drawing.Brushes]::White, $letter)
  $accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#a5f3fc'))
  $graphics.FillEllipse($accent, 382, 98, 36, 36)
  $filename = if ($size -eq 180) { 'apple-touch-icon.png' } else { "icon-$size.png" }
  $bitmap.Save((Join-Path $iconDirectory $filename), [System.Drawing.Imaging.ImageFormat]::Png)
  $accent.Dispose(); $letter.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
