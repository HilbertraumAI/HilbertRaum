# #518: a SYNTHETIC, content-free German invoice image for the vision SSE re-capture.
# Fictional company and figures, drawn here with GDI+ - no real document, no PII. The point of
# the image is only that the model reads the umlauted issuer name back ("Mueller & Soehne GmbH"
# with real umlauts), so the captured stream carries multibyte UTF-8 inside content deltas.
param([string]$Out = (Join-Path $PSScriptRoot 'invoice-synthetic.png'))
Add-Type -AssemblyName System.Drawing
$ue = [string][char]0x00FC   # u-umlaut
$oe = [string][char]0x00F6   # o-umlaut
$W = 640; $H = 440
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$black = [System.Drawing.Brushes]::Black
$grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 70, 70))
$fTitle = New-Object System.Drawing.Font 'Arial', 26, ([System.Drawing.FontStyle]::Bold)
$fHead = New-Object System.Drawing.Font 'Arial', 18, ([System.Drawing.FontStyle]::Bold)
$fBody = New-Object System.Drawing.Font 'Arial', 14
$fSmall = New-Object System.Drawing.Font 'Arial', 12
$company = "M" + $ue + "ller & S" + $oe + "hne GmbH"
$g.DrawString($company, $fHead, $black, 40, 30)
$g.DrawString("Musterstra" + [string][char]0x00DF + "e 12", $fSmall, $grey, 40, 62)
$g.DrawString("12345 Musterstadt", $fSmall, $grey, 40, 82)
$g.DrawString("RECHNUNG", $fTitle, $black, 40, 130)
$g.DrawString("Rechnungsnummer: 2026-0042", $fBody, $black, 40, 180)
$g.DrawString("Rechnungsdatum: 27.09.2026", $fBody, $black, 40, 205)
$g.DrawString("Kunde: Beispiel AG, Beispielweg 7, 54321 Beispielhausen", $fBody, $black, 40, 230)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 1
$g.DrawLine($pen, 40, 270, 600, 270)
$g.DrawString("Position", $fBody, $black, 40, 278)
$g.DrawString("Betrag", $fBody, $black, 480, 278)
$g.DrawLine($pen, 40, 302, 600, 302)
$g.DrawString("Beratung, 4 Stunden", $fBody, $black, 40, 310)
$g.DrawString("400,00 EUR", $fBody, $black, 480, 310)
$g.DrawString("Fahrtkosten", $fBody, $black, 40, 335)
$g.DrawString("38,50 EUR", $fBody, $black, 480, 335)
$g.DrawLine($pen, 40, 365, 600, 365)
$g.DrawString("Gesamtbetrag (inkl. 19 % MwSt.)", $fBody, $black, 40, 375)
$g.DrawString("438,50 EUR", $fHead, $black, 460, 372)
$g.DrawString("Zahlbar innerhalb von 14 Tagen ohne Abzug.", $fSmall, $grey, 40, 410)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("wrote " + $Out + " " + (Get-Item $Out).Length + " bytes")
