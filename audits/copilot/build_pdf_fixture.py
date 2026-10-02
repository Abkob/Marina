"""Synthetic test evidence only; no user files. Run with reportlab and Pillow.
The image deliberately contains information absent from the PDF text layer.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

out = Path(__file__).parent / 'fixtures'
out.mkdir(exist_ok=True)
font_paths = [Path('C:/Windows/Fonts/arial.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
font_path = next((p for p in font_paths if p.exists()), None)
font = ImageFont.truetype(str(font_path), 36) if font_path else ImageFont.load_default(size=36)
im = Image.new('RGB', (1200, 650), 'white')
draw = ImageDraw.Draw(im)
draw.text((45, 35), 'SCAN: The calibration code is NEBULA-731.', font=font, fill='black')
draw.text((45, 105), 'Figure 1: Recovery after treatment', font=font, fill='black')
draw.line((100, 525, 1090, 525), fill='black', width=4)
draw.line((100, 225, 100, 525), fill='black', width=4)
draw.rectangle((245, 375, 435, 524), fill='#778b9f')
draw.rectangle((705, 255, 895, 524), fill='#36536f')
draw.text((238, 550), 'Before: 25', font=font, fill='black')
draw.text((699, 550), 'After: 45', font=font, fill='black')
im.save(out / 'visual-evidence.png')
c = canvas.Canvas(str(out / 'mixed-evidence.pdf'), pagesize=(612, 792), invariant=1)
c.setFont('Helvetica', 18)
c.drawString(40, 745, 'Marina synthetic indexing audit')
c.setFont('Helvetica', 12)
c.drawString(40, 714, 'TEXT: The control code is ORBIT-219.')
c.drawString(40, 690, 'The evidence below exists only as an embedded image.')
c.drawImage(ImageReader(im), 36, 295, width=540, height=292.5)
c.showPage()
c.drawImage(ImageReader(im), 36, 295, width=540, height=292.5)
c.save()
print('Created two-page synthetic mixed text/image PDF and its image fixture.')
